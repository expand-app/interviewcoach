import { NextResponse } from "next/server";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { isDbConfigured, query } from "@/lib/db";
import { isAdminRequest } from "@/lib/auth-server";
import { signGetUrl, RECORDINGS_BUCKET, RECORDINGS_REGION } from "@/lib/s3";
import { triggerBackgroundTranscode, movKeyFor } from "@/lib/transcode";

export const runtime = "nodejs";

let adminS3: S3Client | null = null;
function getAdminS3(): S3Client {
  if (!adminS3) adminS3 = new S3Client({ region: RECORDINGS_REGION });
  return adminS3;
}

/**
 * GET /api/share/[token]
 *
 * Public, token-authenticated endpoint that returns the full session
 * payload for cross-system import. The token (a 192-bit base64url
 * string minted by /api/admin/sessions/[id]/share) IS the auth — no
 * x-user-id header, no cookie, nothing else required.
 *
 * Status codes:
 *   200 — payload returned
 *   404 — token doesn't exist (or wasn't shaped like a token)
 *   410 — token was revoked (admin clicked Revoke); the URL is dead
 *
 * The shape mirrors /api/admin/analytics/sessions/[id] so a single
 * client can branch its fetch URL but keep one rendering path. New
 * fields added to the admin endpoint should be mirrored here so the
 * destination system stays in sync; conversely any field added here
 * should be considered a public surface (recipients you don't control
 * may parse it).
 *
 * Recording URLs are signed at fetch time with the standard 1h S3
 * TTL. The destination system is expected to fetch this JSON, then
 * either (a) immediately re-fetch the bytes from the signed URLs, or
 * (b) re-call this endpoint when it needs fresh URLs. Doing the
 * signing per-request (vs storing a long-lived signed URL on the
 * share row) means revocation actually cuts off recording access too.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string }> }
) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured." },
      { status: 503 }
    );
  }

  const { token } = await ctx.params;
  const cleanToken = token?.trim();
  // Token shape sanity-check before hitting the DB. Tokens are
  // "share-" + base64url; reject anything else with a 404 so we don't
  // burn a Postgres roundtrip on obvious junk URLs (crawlers, etc.).
  if (!cleanToken || !/^share-[A-Za-z0-9_-]{20,128}$/.test(cleanToken)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Single round-trip joins the share → session → user.
    const r = await query<{
      revoked_at: Date | null;
      session_id: string;
      user_id: string;
      title: string;
      jd: string;
      resume: string;
      started_at: Date;
      created_at: Date;
      duration_seconds: number;
      audio_s3_key: string | null;
      video_s3_key: string | null;
      video_mov_s3_key: string | null;
      jd_summary: string | null;
      resume_summary: string | null;
      interviewer_profile: string | null;
      interviewer_profile_summary: string | null;
      speaker_roles: unknown;
      score: unknown;
      score_error: string | null;
      user_email: string;
      user_name: string;
    }>(
      `SELECT
         sh.revoked_at,
         s.id    AS session_id,
         s.user_id,
         s.title, s.jd, s.resume, s.started_at, s.created_at,
         s.duration_seconds,
         s.audio_s3_key, s.video_s3_key, s.video_mov_s3_key,
         s.jd_summary, s.resume_summary,
         s.interviewer_profile, s.interviewer_profile_summary,
         s.speaker_roles,
         s.score, s.score_error,
         u.email AS user_email,
         u.name  AS user_name
       FROM session_shares sh
       JOIN sessions s ON s.id = sh.session_id
       JOIN users u    ON u.id = s.user_id
       WHERE sh.token = $1`,
      [cleanToken]
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const s = r.rows[0];
    if (s.revoked_at !== null) {
      return NextResponse.json(
        {
          error:
            "This share has been revoked. Ask the link owner for a fresh share URL.",
        },
        { status: 410 }
      );
    }

    // Optional `?force=1` query param — gated mechanism to RE-RUN the
    // iOS-compatibility transcode for this session. Used when an
    // existing video_mov_s3_key points to a stale output (e.g.
    // produced by an older transcode codepath that turned out not to
    // play on iOS / WeChat after all). Without this, the normal lazy-
    // backfill below would skip because video_mov_s3_key is non-null.
    //
    // Permission: admin OR the SESSION OWNER. Owners can re-process
    // their own recordings (they're paying the CPU cost on their own
    // session, and the session is theirs to begin with). Random share-
    // link visitors can't trigger re-encode — that would let third
    // parties burn t3.small CPU on demand by spamming `?force=1` to
    // any leaked share URL.
    //
    // Effect:
    //   1. UPDATE sessions SET video_mov_s3_key = NULL (so the lazy
    //      check fires), then
    //   2. DELETE the stale s3 object so a future request can't
    //      accidentally serve it, then
    //   3. Fall through to the normal lazy-trigger below.
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    if (force) {
      const isAdmin = await isAdminRequest(req);
      const callerUserId = req.headers.get("x-user-id")?.trim();
      const isOwner = callerUserId && callerUserId === s.user_id;
      if (!isAdmin && !isOwner) {
        return NextResponse.json(
          { error: "force=1 requires admin or session-owner auth" },
          { status: 403 }
        );
      }
      if (s.video_mov_s3_key) {
        const staleKey = s.video_mov_s3_key;
        // Clear the column first (single round-trip). The lazy
        // trigger below then fires because the field is now null.
        await query(
          `UPDATE sessions SET video_mov_s3_key = NULL WHERE id = $1`,
          [s.session_id]
        );
        // Best-effort delete the stale s3 object. Failure here is
        // non-fatal: even if the object survives, the
        // movKeyFor("video.mp4") output is a deterministic key
        // ("video.remuxed.mp4"), and the new transcode will
        // overwrite it on completion. Logging only so we know if
        // there's a permission/credential issue worth investigating.
        try {
          await getAdminS3().send(
            new DeleteObjectCommand({
              Bucket: RECORDINGS_BUCKET,
              Key: staleKey,
            })
          );
        } catch (delErr) {
          console.warn(
            "[/api/share force=1] stale-object delete failed",
            { key: staleKey, error: delErr }
          );
        }
        // Local mutation so the rest of this handler's behavior
        // (lazy-trigger guard, signed URL choice) reflects the new
        // null state without re-querying.
        s.video_mov_s3_key = null;
        // Suppress unused-variable warnings on movKeyFor — we keep
        // the import for clarity even though we don't construct the
        // key directly here. Same import is used inside transcode.ts.
        void movKeyFor;
      }
    }

    // Lazy-backfill the iOS-compatible non-fragmented MP4. The owner-
    // side /api/sessions/[id] GET also triggers this, but a session
    // accessed ONLY via share link (admin shared an old session) would
    // never get the remux without this hook. Mirrors the owner path's
    // safety guards: only when video_s3_key exists, video_mov_s3_key
    // is null, and source is .mp4. Process-local in-progress dedup
    // means multiple concurrent share fetches only spawn one ffmpeg.
    //
    // The CURRENT request still returns the fragmented MP4 (mobile
    // can't play it). The user has to refresh ~10-30s later for the
    // remuxed version to be served. Acceptable: the remux is a one-
    // time backfill per session, and with the auto-trigger on every
    // GET the catch-up happens on the first view rather than never.
    if (
      s.video_s3_key &&
      !s.video_mov_s3_key &&
      /\.mp4$/i.test(s.video_s3_key)
    ) {
      triggerBackgroundTranscode(s.session_id, s.video_s3_key);
    }
    // Recording URLs come back as PROXY URLs through puebulo.com
    // (`/api/share/<token>/video` and `/api/share/<token>/audio`),
    // not direct S3 signed URLs.
    //
    // Why: AWS S3 (us-east-1.amazonaws.com) is unreliable from
    // mainland China — TCP RST, throttling, and QoS on cross-border
    // video streams cause iOS / WeChat <video> elements to fail
    // with what looks like a "format not supported" error but is
    // actually "URL didn't deliver bytes". The puebulo.com domain
    // is reachable, so by relaying S3 bytes through here we get
    // China-friendly delivery without ICP filing or storage migration.
    //
    // The proxy endpoints are public (token = auth) and pass through
    // Range requests, so iOS Safari's video probe + seek behavior
    // works identically to a direct S3 URL. See video/route.ts for
    // the full design.
    //
    // Cost: every byte streamed costs $0.09/GB AWS internet egress
    // (us-east-1 rate, applies regardless of viewer's country). For
    // a 161 MB video, that's $0.0145 per playthrough. S3→EB transit
    // is free (intra-region). The download endpoint
    // /api/share/[token]/download stays available for programmatic
    // consumers that need a full file URL via signed S3 redirect.
    const videoKey = s.video_mov_s3_key || s.video_s3_key;
    // Construct the public origin honoring nginx-forwarded headers.
    // Next.js's req.url comes through as `http://localhost:8080/...`
    // when running behind EB's nginx → Node bridge, so a naive
    // `new URL(req.url).origin` would emit useless internal URLs.
    // The x-forwarded-host + x-forwarded-proto headers are set by
    // nginx with the externally-visible values, falling back to the
    // Host header for environments without forwarders (local dev).
    const fwdHost =
      req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
    // The internal nginx → Node bridge uses HTTP, so x-forwarded-proto
    // can come through as `http` even when the original client was
    // HTTPS. Trust the public domain instead: anything that isn't
    // bare localhost is forced to https (production traffic always
    // arrives via the ALB's HTTPS listener; the http listener
    // redirects to https before reaching Node). Local dev still gets
    // http://localhost.
    const isLocalhost = /^localhost(:|$)/.test(fwdHost);
    const fwdProto = isLocalhost ? "http" : "https";
    const origin = fwdHost ? `${fwdProto}://${fwdHost}` : new URL(req.url).origin;
    const audioUrl = s.audio_s3_key
      ? `${origin}/api/share/${encodeURIComponent(cleanToken)}/audio`
      : null;
    const videoUrl = videoKey
      ? `${origin}/api/share/${encodeURIComponent(cleanToken)}/video`
      : null;
    // Suppress unused-variable warnings — signGetUrl is now used
    // only inside the force=1 branch above (delete stale object) and
    // implicitly via the download route. Keep the import; it stays
    // useful for any future endpoint that needs a direct signed URL.
    void signGetUrl;

    // Child rows. Utterances are included (the destination system may
    // want a full transcript for re-rendering); session_events is
    // intentionally OMITTED — it's a debug-log surface that doesn't
    // belong in a public payload.
    const [questionsRes, commentsRes, utterancesRes] = await Promise.all([
      query<{
        id: string;
        parent_question_id: string | null;
        text: string;
        asked_at_seconds: number;
        answer_text: string;
        position: number;
        kind: string;
      }>(
        `SELECT id, parent_question_id, text, asked_at_seconds, answer_text, position, kind
           FROM questions
          WHERE session_id = $1
          ORDER BY position ASC`,
        [s.session_id]
      ),
      query<{
        id: string;
        question_id: string;
        text: string;
        expanded_suggestion: string | null;
        at_seconds: number;
        kind: string;
        context_text: string | null;
      }>(
        `SELECT c.id, c.question_id, c.text, c.expanded_suggestion, c.at_seconds, c.kind,
                c.context_text
           FROM comments c
           JOIN questions q ON q.id = c.question_id
          WHERE q.session_id = $1
          ORDER BY c.at_seconds ASC`,
        [s.session_id]
      ),
      query<{
        id: string;
        dg_speaker: number | null;
        text: string;
        at_seconds: number;
        duration: number | null;
        position: number;
      }>(
        `SELECT id, dg_speaker, text, at_seconds, duration, position
           FROM utterances
          WHERE session_id = $1
          ORDER BY position ASC`,
        [s.session_id]
      ),
    ]);

    return NextResponse.json({
      session: {
        id: s.session_id,
        title: s.title,
        jd: s.jd,
        resume: s.resume,
        startedAt:
          s.started_at instanceof Date
            ? s.started_at.toISOString()
            : s.started_at,
        createdAt:
          s.created_at instanceof Date
            ? s.created_at.toISOString()
            : s.created_at,
        durationSeconds: s.duration_seconds,
        audioS3Key: s.audio_s3_key,
        videoS3Key: s.video_s3_key,
        videoMovS3Key: s.video_mov_s3_key,
        jdSummary: s.jd_summary,
        resumeSummary: s.resume_summary,
        interviewerProfile: s.interviewer_profile,
        interviewerProfileSummary: s.interviewer_profile_summary,
        speakerRoles: s.speaker_roles,
        score: s.score,
        scoreError: s.score_error,
        // Public surface — only name + email of the session owner.
        // No internal user_id, no admin metadata.
        owner: {
          email: s.user_email,
          name: s.user_name,
        },
      },
      recordings: {
        audioUrl,
        videoUrl,
      },
      questions: questionsRes.rows.map((q) => ({
        id: q.id,
        parentQuestionId: q.parent_question_id,
        text: q.text,
        askedAtSeconds: q.asked_at_seconds,
        answerText: q.answer_text,
        position: q.position,
        // kind: "interviewer" (default, omitted on legacy rows) |
        // "candidate". Public consumers should treat unknown values as
        // "interviewer" — that matches the schema default and the
        // historical reality of every row before this column landed.
        kind: q.kind || "interviewer",
      })),
      comments: commentsRes.rows.map((c) => ({
        id: c.id,
        questionId: c.question_id,
        text: c.text,
        expandedSuggestion: c.expanded_suggestion,
        atSeconds: c.at_seconds,
        kind: c.kind,
        // Snapshot of interviewer monologue for listening hints — see
        // types/session.ts Comment.contextText. Null on legacy rows
        // and on non-listening kinds.
        contextText: c.context_text,
      })),
      utterances: utterancesRes.rows.map((u) => ({
        id: u.id,
        dgSpeaker: u.dg_speaker,
        text: u.text,
        atSeconds: u.at_seconds,
        duration: u.duration,
        position: u.position,
      })),
    });
  } catch (e) {
    console.error("[/api/share/:token] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
