import { NextResponse } from "next/server";
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { isDbConfigured, query, withTx } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";
import {
  concatSegmentsToCanonical,
  triggerBackgroundTranscode,
} from "@/lib/transcode";
import { triggerBackgroundExpand } from "@/lib/expand-suggestions-helper";
import { RECORDINGS_BUCKET, RECORDINGS_REGION } from "@/lib/s3";

export const runtime = "nodejs";

// One-shot S3 client for the upload-verify path. HeadObject is
// cheap (returns metadata only, no body), so a single shared client
// is fine.
let s3Verify: S3Client | null = null;
function getVerifyS3() {
  if (!s3Verify) s3Verify = new S3Client({ region: RECORDINGS_REGION });
  return s3Verify;
}

/** Verify a recording key actually has bytes in S3 before we let the
 *  client PATCH it onto a session row. Catches the silent 0-byte
 *  upload failure mode where S3 returns HTTP 200 on PUT but stores
 *  no body — observed when Content-Type signing didn't match the
 *  PUT header. Returns true when the object exists with size > 0. */
async function verifyS3Key(key: string): Promise<boolean> {
  try {
    const r = await getVerifyS3().send(
      new HeadObjectCommand({ Bucket: RECORDINGS_BUCKET, Key: key })
    );
    const size = typeof r.ContentLength === "number" ? r.ContentLength : 0;
    // Log the metadata at PATCH time so we can diff "what we wrote"
    // vs "what fails to play" later. ContentType is especially
    // important — if S3 stored "application/octet-stream" instead
    // of "video/mp4", browsers reject the file with MediaError
    // code 4 (src_not_supported) even though the bytes are fine.
    console.log("[verifyS3Key] HEAD ok", {
      key,
      size,
      contentType: r.ContentType,
      etag: r.ETag,
    });
    return size > 0;
  } catch (e) {
    console.warn("[verifyS3Key] HEAD failed for", key, e);
    return false;
  }
}

/** Process-local dedupe set so two close GETs on the same orphan
 *  session don't fire two ffmpeg concat passes. concatSegments-
 *  ToCanonical itself uses the global ffmpeg-queue so it'd serialize
 *  anyway, but skipping the redundant trigger saves the listObjects
 *  call too. Cleared when the recovery promise settles. */
const orphanRecoveryInProgress = new Set<string>();

/** Re-fire the segment-concat for sessions whose client-side
 *  /api/uploads/concat call dropped before reaching the server.
 *
 *  Failure mode this catches: client signed + PUT each video.{i}.mp4
 *  segment to S3 (segments end up persisted), then called
 *  POST /api/uploads/concat to stitch them — but that final fetch
 *  was canceled by tab close / navigation / network blip / browser
 *  shutdown before the request reached the server. Result: orphan
 *  segments in S3, no canonical video.mp4, video_s3_key NULL in DB,
 *  PastView shows no Recording section.
 *
 *  Recovery: list S3 under the session prefix, find any
 *  `video.{N}.{ext}` orphan segments, and call the same concat
 *  helper the API endpoint would. concatSegmentsToCanonical updates
 *  video_s3_key on success and deletes the segment files. The user
 *  doesn't have to re-record — they just refresh the past view.
 *
 *  Fire-and-forget — runs in background, doesn't delay the GET
 *  response. */
async function recoverOrphanVideoSegments(
  userId: string,
  sessionId: string
): Promise<void> {
  if (orphanRecoveryInProgress.has(sessionId)) return;
  orphanRecoveryInProgress.add(sessionId);
  try {
    const prefix = `users/${userId}/sessions/${sessionId}/`;
    const listResult = await getVerifyS3().send(
      new ListObjectsV2Command({
        Bucket: RECORDINGS_BUCKET,
        Prefix: prefix,
        MaxKeys: 50,
      })
    );
    // Match `video.{N}.mp4` / `video.{N}.webm`. Plain `video.mp4`
    // (no segment index) is NOT a recovery candidate — that's the
    // canonical key the concat would produce, not an orphan.
    const segmentKeys = (listResult.Contents ?? [])
      .map((o) => o.Key)
      .filter(
        (k): k is string =>
          !!k && /\/video\.\d+\.(mp4|webm)$/i.test(k)
      )
      .sort(); // numeric ordering: video.0.mp4, video.1.mp4, ...
    if (segmentKeys.length === 0) {
      // No orphans — nothing to recover. Could mean: legitimate
      // no-recording session, or the user never enabled video.
      return;
    }
    console.log("[orphan-concat] recovering", {
      sessionId,
      segments: segmentKeys.length,
    });
    const finalKey = await concatSegmentsToCanonical({
      userId,
      sessionId,
      segmentKeys,
    });
    if (finalKey) {
      console.log("[orphan-concat] recovered", { sessionId, finalKey });
    } else {
      console.warn("[orphan-concat] failed", { sessionId, segmentKeys });
    }
  } catch (e) {
    console.warn("[orphan-concat] error for", sessionId, e);
  } finally {
    orphanRecoveryInProgress.delete(sessionId);
  }
}

interface RouteCtx {
  params: Promise<{ id: string }>;
}

// ===== GET /api/sessions/:id =====
// Full session: top-level row + all questions + all comments. Does
// NOT include utterances or events — those are paginatable and
// fetched lazily by the past-view review panel.
export async function GET(req: Request, ctx: RouteCtx) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const sessR = await query<{
    id: string;
    title: string;
    jd: string;
    resume: string;
    started_at: Date;
    duration_seconds: number;
    audio_s3_key: string | null;
    video_s3_key: string | null;
    video_mov_s3_key: string | null;
    jd_summary: string | null;
    resume_summary: string | null;
    interviewer_profile: string | null;
    interviewer_profile_summary: string | null;
    speaker_roles: Record<string, "interviewer" | "candidate">;
    score: unknown;
    score_error: string | null;
    parent_session_id: string | null;
    session_mode: string | null;
    parent_title: string | null;
  }>(
    `SELECT s.id, s.title, s.jd, s.resume, s.started_at, s.duration_seconds,
            s.audio_s3_key, s.video_s3_key, s.video_mov_s3_key,
            s.jd_summary, s.resume_summary,
            s.interviewer_profile, s.interviewer_profile_summary,
            s.speaker_roles, s.score, s.score_error,
            s.parent_session_id, s.session_mode,
            parent.title AS parent_title
     FROM sessions s
     LEFT JOIN sessions parent ON parent.id = s.parent_session_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [id, userId]
  );
  if (sessR.rows.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const s = sessR.rows[0];

  const qsR = await query<{
    id: string;
    parent_question_id: string | null;
    text: string;
    asked_at_seconds: number;
    answer_text: string;
    kind: string;
  }>(
    `SELECT id, parent_question_id, text, asked_at_seconds, answer_text, kind
     FROM questions
     WHERE session_id = $1
     ORDER BY position`,
    [id]
  );

  // Lazy-backfill the iOS-compatible non-fragmented MP4 (re-enabled
  // 2026-05-07). Why:
  //
  // The MediaRecorder + ffmpeg-concat path produces fragmented MP4
  // (fMP4): each pause/resume segment carries its own ftyp+moov, and
  // even after `-c copy` concatenation the result is technically
  // fragmented even with +faststart. iOS Safari and WeChat embedded
  // browsers REFUSE to play fMP4 ("Recording File is missing or it is
  // format that browser cannot play") — confirmed in the field on the
  // McKinsey session share-link case. Desktop Chrome / Safari play
  // it fine, masking the issue from owners reviewing on laptop.
  //
  // The remux path here re-runs ffmpeg with `-c copy` + `+faststart`
  // + `-f mp4` to produce a NON-fragmented MP4 with moov-at-front
  // that plays everywhere. ~5-10s on a t3.small for any session
  // length (no re-encoding, just container rewrite).
  //
  // Safety: movKeyFor("video.mp4") returns "video.remuxed.mp4" —
  // distinct from the source key, so a failing ffmpeg pass can no
  // longer overwrite the original good recording (the bug that made
  // us disable this in the first place). On failure, video_mov_s3_key
  // stays null and we fall back to serving the fragmented original;
  // mobile users see "can't play" but the recording itself is intact.
  //
  // Triggers ONLY when:
  //   - source video_s3_key exists (recording was uploaded)
  //   - video_mov_s3_key is null (haven't successfully remuxed yet)
  //   - source is .mp4 (legacy .webm goes through the on-demand
  //     /api/uploads/download endpoint instead — too slow to
  //     remux on every session GET)
  // The transcode helper has process-local in-progress dedup, so
  // multiple concurrent GETs / shares only spawn one ffmpeg.
  if (
    s.video_s3_key &&
    !s.video_mov_s3_key &&
    /\.mp4$/i.test(s.video_s3_key)
  ) {
    triggerBackgroundTranscode(s.id, s.video_s3_key);
  }
  // Lazy-backfill expanded "Try saying" answers. Same shape as the
  // MOV transcode trigger above. Cheap to fire — the helper itself
  // checks if any comments are actually missing and exits early
  // otherwise, with a process-local in-progress dedupe so two close
  // GETs don't double-fire.
  triggerBackgroundExpand(s.id);

  // Lazy concat-recovery for orphan video segments. Catches the
  // failure mode where a client-side /api/uploads/concat call was
  // dropped (tab close, navigation, network blip) AFTER the segments
  // were PUT to S3 successfully — the bytes are there, the canonical
  // video.mp4 just never got produced. See the helper docblock for
  // details. Only fires when video_s3_key is unset in DB; sessions
  // with a video already wired skip the listObjects call entirely.
  // Fire-and-forget; doesn't delay this GET response.
  if (!s.video_s3_key) {
    void recoverOrphanVideoSegments(userId, s.id);
  }

  const cmR = await query<{
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
     ORDER BY c.at_seconds`,
    [id]
  );
  const commentsByQ = new Map<string, typeof cmR.rows>();
  for (const c of cmR.rows) {
    const arr = commentsByQ.get(c.question_id) ?? [];
    arr.push(c);
    commentsByQ.set(c.question_id, arr);
  }

  return NextResponse.json({
    session: {
      id: s.id,
      title: s.title,
      jd: s.jd,
      resume: s.resume,
      startedAt: s.started_at.toISOString(),
      durationSeconds: s.duration_seconds,
      audioS3Key: s.audio_s3_key ?? undefined,
      videoS3Key: s.video_s3_key ?? undefined,
      videoMovS3Key: s.video_mov_s3_key ?? undefined,
      jdSummary: s.jd_summary ?? undefined,
      resumeSummary: s.resume_summary ?? undefined,
      interviewerProfile: s.interviewer_profile ?? undefined,
      interviewerProfileSummary: s.interviewer_profile_summary ?? undefined,
      speakerRoles: s.speaker_roles ?? {},
      score: s.score ?? undefined,
      scoreError: s.score_error ?? undefined,
      parentSessionId: s.parent_session_id ?? undefined,
      sessionMode: s.session_mode === "retake" ? "retake" : "live",
      parentTitle: s.parent_title ?? undefined,
      questions: qsR.rows.map((q) => ({
        id: q.id,
        parentQuestionId: q.parent_question_id ?? undefined,
        text: q.text,
        askedAtSeconds: q.asked_at_seconds,
        answerText: q.answer_text || undefined,
        kind: (q.kind as "interviewer" | "candidate") || "interviewer",
        comments: (commentsByQ.get(q.id) ?? []).map((c) => ({
          id: c.id,
          text: c.text,
          expandedSuggestion: c.expanded_suggestion ?? undefined,
          atSeconds: c.at_seconds,
          kind:
            (c.kind as "answer" | "listening" | "cand-q-cmt") || "answer",
          contextText: c.context_text ?? undefined,
        })),
      })),
    },
  });
}

// ===== PATCH /api/sessions/:id =====
// Partial update for the post-session enrichment flow:
// - title (rename from sidebar)
// - score / scoreError after /api/score-session lands
// - jdSummary / resumeSummary / interviewerProfileSummary after
//   /api/summarize-context lands
// - expandedSuggestions: { [commentId]: string } merge after
//   /api/expand-suggestions lands

interface PatchBody {
  title?: string;
  score?: unknown;
  scoreError?: string | null;
  jdSummary?: string;
  resumeSummary?: string;
  interviewerProfileSummary?: string;
  expandedSuggestions?: Record<string, string>;
  /** S3 object keys for the recorded audio / video. Set by the
   *  client after the presigned PUT upload completes. Either field
   *  is independent — the user may have only audio, or audio+video,
   *  depending on whether they enabled "capture screen video". */
  audioS3Key?: string;
  videoS3Key?: string;
}

export async function PATCH(req: Request, ctx: RouteCtx) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: PatchBody = {};
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // Confirm ownership before any mutation.
  const own = await query<{ id: string }>(
    `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (own.rows.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await withTx(async (q) => {
    const sets: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    if (body.title !== undefined) {
      sets.push(`title = $${p++}`);
      params.push(body.title);
    }
    if (body.score !== undefined) {
      // Setting score clears any prior score_error: the two are
      // mutually exclusive (see store.ts:setPastSessionScore).
      sets.push(`score = $${p++}`);
      params.push(body.score === null ? null : JSON.stringify(body.score));
      sets.push(`score_error = NULL`);
    }
    if (body.scoreError !== undefined) {
      // Conversely setting score_error clears any prior score.
      sets.push(`score_error = $${p++}`);
      params.push(body.scoreError);
      sets.push(`score = NULL`);
    }
    if (body.jdSummary !== undefined) {
      sets.push(`jd_summary = $${p++}`);
      params.push(body.jdSummary);
    }
    if (body.resumeSummary !== undefined) {
      sets.push(`resume_summary = $${p++}`);
      params.push(body.resumeSummary);
    }
    if (body.interviewerProfileSummary !== undefined) {
      sets.push(`interviewer_profile_summary = $${p++}`);
      params.push(body.interviewerProfileSummary);
    }
    if (body.audioS3Key !== undefined) {
      // Verify the upload actually has bytes before persisting the
      // key. Catches the Content-Type-mismatch "S3 returned 200 but
      // stored 0 bytes" failure mode that left users with broken
      // playback after reload.
      if (body.audioS3Key) {
        const ok = await verifyS3Key(body.audioS3Key);
        if (!ok) {
          console.warn(
            "[PATCH] rejecting empty/missing audio key",
            body.audioS3Key
          );
          return NextResponse.json(
            { error: "audio upload missing or empty in S3" },
            { status: 400 }
          );
        }
      }
      sets.push(`audio_s3_key = $${p++}`);
      params.push(body.audioS3Key || null);
    }
    if (body.videoS3Key !== undefined) {
      if (body.videoS3Key) {
        const ok = await verifyS3Key(body.videoS3Key);
        if (!ok) {
          console.warn(
            "[PATCH] rejecting empty/missing video key",
            body.videoS3Key
          );
          return NextResponse.json(
            { error: "video upload missing or empty in S3" },
            { status: 400 }
          );
        }
      }
      sets.push(`video_s3_key = $${p++}`);
      params.push(body.videoS3Key || null);
      // Auto-transcode disabled — see the GET handler above for the
      // reasoning (movKeyFor of an .mp4 source collides with the
      // source key, and a failing ffmpeg pass committed a 0-byte
      // upload that clobbered fresh recordings). The new multi-
      // segment upload path produces a +faststart MP4 directly at
      // video_s3_key; nothing to remux on the way in.
    }
    if (sets.length > 0) {
      params.push(id);
      await q(
        `UPDATE sessions SET ${sets.join(", ")} WHERE id = $${p}`,
        params
      );
    }

    // Comment expansions: per-comment UPDATE. The map shape comes
    // straight from the store action setPastSessionExpandedSuggestions
    // — keys are comment ids, values are expanded text.
    if (body.expandedSuggestions) {
      for (const [commentId, text] of Object.entries(body.expandedSuggestions)) {
        await q(
          `UPDATE comments SET expanded_suggestion = $1 WHERE id = $2`,
          [text, commentId]
        );
      }
    }
  });

  return NextResponse.json({ ok: true });
}

// ===== DELETE /api/sessions/:id =====
// Cascades to questions/comments/utterances/session_events via FK.
export async function DELETE(req: Request, ctx: RouteCtx) {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL not configured" }, { status: 503 });
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const r = await query(
    `DELETE FROM sessions WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
