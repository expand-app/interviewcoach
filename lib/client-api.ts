/**
 * Client → server API wrappers for the Phase 2 persistence layer.
 *
 * All calls are fire-and-forget at the use-site (the store updates
 * local state immediately and these helpers sync the server in the
 * background). On failure they log to console but don't surface
 * errors — the design choice is "the in-memory state is the source
 * of truth during the session; the server is a write-through cache
 * for cross-device / cross-reload survival".
 *
 * Auth: every call sends `x-user-id: <uuid>` from the local user
 * record. If there's no user (sign-in not yet run), helpers
 * short-circuit and return empty / undefined — the local-only path
 * keeps working.
 */

import type {
  Session,
  Utterance,
  SessionScore,
} from "@/types/session";
import { useStore } from "./store";
import type { DebugEvent } from "./debug-buffer";

function userId(): string | undefined {
  try {
    return useStore.getState().user?.userId;
  } catch {
    return undefined;
  }
}

function authHeaders(): Record<string, string> {
  const id = userId();
  return id ? { "x-user-id": id } : {};
}

/** Fire-and-forget single-event logger. Posts to
 *  /api/sessions/:id/log-event — used by the post-session upload
 *  pipeline (and any other client-side post-session observable)
 *  to leave breadcrumbs in the session_events table that admin
 *  diagnostics can later read. Failures are swallowed silently —
 *  event logging shouldn't impact the actual work.
 *
 *  Use sparingly: every call is one HTTP roundtrip. Batch within
 *  a single phase if you'd otherwise emit >5-10 events per second. */
export function logUploadEvent(
  sessionId: string,
  source: string,
  event: string,
  data?: unknown
): void {
  if (!sessionId || !userId()) return;
  void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/log-event`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ source, event, data, atMs: Date.now() }),
    keepalive: true,
  }).catch(() => {
    /* swallow — diagnostic events aren't load-bearing */
  });
}

export interface PastSessionListItem {
  id: string;
  title: string;
  startedAt: string;
  durationSeconds: number;
  hasScore: boolean;
  scoreError?: string;
  /** 'retake' = AI-interviewer mock session. Absent/'live' = regular. */
  sessionMode?: "live" | "retake";
  /** Original session id when sessionMode === 'retake'. */
  parentSessionId?: string;
}

/** Sign-in handshake: ensures a row exists in `users` for this
 *  email, returns the row's UUID. Called by LoginView right after
 *  the client-side credential check passes. */
export async function upsertUser(
  email: string,
  name: string
): Promise<{ userId: string } | null> {
  try {
    const r = await fetch("/api/users/upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name }),
    });
    if (!r.ok) return null;
    return (await r.json()) as { userId: string };
  } catch {
    return null;
  }
}

export interface AuthResult {
  userId: string;
  email: string;
  name: string;
}

/** Server-validated sign-in. Verifies password with bcrypt; returns
 *  the user row on success or an `{ error }` object on failure (401
 *  for bad credentials, 503 if the DB isn't configured). */
export async function signInUser(
  email: string,
  password: string
): Promise<AuthResult | { error: string }> {
  try {
    const r = await fetch("/api/auth/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = (await r.json().catch(() => ({}))) as Partial<AuthResult> & {
      error?: string;
    };
    if (!r.ok) {
      return { error: data.error || "Sign-in failed. Please try again." };
    }
    if (!data.userId || !data.email || !data.name) {
      return { error: "Sign-in returned an unexpected response." };
    }
    return { userId: data.userId, email: data.email, name: data.name };
  } catch {
    return { error: "Network error. Check your connection and try again." };
  }
}

/** Step 1 of registration: validate inputs server-side, hash the
 *  password, and have the server email a 6-digit code to the user.
 *  The invite code is checked but NOT consumed — that happens only
 *  on successful verify-email.
 *
 *  Returns `{ ok: true, email }` on success (the email is the
 *  normalized lowercase form, useful for displaying "code sent to
 *  ___" in the UI even if the user typed mixed case). */
export async function requestEmailVerification(args: {
  email: string;
  password: string;
  inviteCode: string;
  /** First name. Required by the server — passing undefined here will
   *  fail with "Please enter your first name." Kept optional in the
   *  TS shape so legacy resend flows that don't have the name in
   *  scope can still re-fire (server falls back to legacy `name`
   *  field for backwards compat). */
  firstName?: string;
  /** Optional last name. Joined with firstName as "First Last". */
  lastName?: string;
  /** Legacy combined-name field. Prefer firstName/lastName above for
   *  new code paths. */
  name?: string;
}): Promise<{ ok: true; email: string } | { error: string }> {
  try {
    const r = await fetch("/api/auth/request-verification", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      email?: string;
      error?: string;
    };
    if (!r.ok || !data.ok) {
      return {
        error:
          data.error ||
          "Couldn't send the verification code. Please try again.",
      };
    }
    return { ok: true, email: data.email || args.email };
  } catch {
    return { error: "Network error. Check your connection and try again." };
  }
}

/** Step 2 of registration: submit the 6-digit code from the email.
 *  Server creates the user atomically (with the previously-stashed
 *  password hash and invite code) and returns the new user row.
 *  After this resolves successfully, the client should sign the user
 *  in immediately — same as a regular sign-in. */
export async function verifyEmailAndCreateAccount(args: {
  email: string;
  code: string;
}): Promise<AuthResult | { error: string }> {
  try {
    const r = await fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = (await r.json().catch(() => ({}))) as Partial<AuthResult> & {
      error?: string;
    };
    if (!r.ok) {
      return { error: data.error || "Verification failed. Please try again." };
    }
    if (!data.userId || !data.email || !data.name) {
      return { error: "Verification returned an unexpected response." };
    }
    return { userId: data.userId, email: data.email, name: data.name };
  } catch {
    return { error: "Network error. Check your connection and try again." };
  }
}

/** Step 1 of forgot-password: ask the server to email a reset code.
 *  Returns `{ ok: true, email }` on success. Errors include "no
 *  account with this email", rate-limit, and SES send failures —
 *  surface verbatim to the user, they're written to be readable. */
export async function requestPasswordReset(args: {
  email: string;
}): Promise<{ ok: true; email: string } | { error: string }> {
  try {
    const r = await fetch("/api/auth/request-password-reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = (await r.json().catch(() => ({}))) as {
      ok?: boolean;
      email?: string;
      error?: string;
    };
    if (!r.ok || !data.ok) {
      return {
        error:
          data.error ||
          "Couldn't send the reset code. Please try again.",
      };
    }
    return { ok: true, email: data.email || args.email };
  } catch {
    return { error: "Network error. Check your connection and try again." };
  }
}

/** Step 2 of forgot-password: submit the 6-digit code + a new
 *  password. On success the server has rotated the password_hash
 *  and returns the user row — same shape as sign-in, so the client
 *  can drop straight into the signed-in state. */
export async function resetPassword(args: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<AuthResult | { error: string }> {
  try {
    const r = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = (await r.json().catch(() => ({}))) as Partial<AuthResult> & {
      error?: string;
    };
    if (!r.ok) {
      return { error: data.error || "Password reset failed. Please try again." };
    }
    if (!data.userId || !data.email || !data.name) {
      return { error: "Password reset returned an unexpected response." };
    }
    return { userId: data.userId, email: data.email, name: data.name };
  } catch {
    return { error: "Network error. Check your connection and try again." };
  }
}

/** List the user's saved sessions for the sidebar / past list.
 *
 *  THROWS on failure (no userId yet, non-2xx, or network error) rather
 *  than swallowing to `[]`. This distinction is load-bearing: the caller
 *  (hydratePastSessions) persists a UX cache of this list and must NOT
 *  overwrite a good cached list with an empty one just because a refresh
 *  raced userId hydration or hit an Aurora cold-start 5xx. A thrown error
 *  means "couldn't determine" (keep the cache + retry); a returned `[]`
 *  means "server confirmed the user genuinely has no sessions". */
export async function fetchPastSessions(): Promise<PastSessionListItem[]> {
  const id = userId();
  if (!id) throw new Error("fetchPastSessions: userId not ready");
  const r = await fetch("/api/sessions", {
    headers: { "x-user-id": id },
    cache: "no-store",
  });
  if (!r.ok) {
    throw new Error(`fetchPastSessions: HTTP ${r.status}`);
  }
  const data = (await r.json()) as { sessions?: PastSessionListItem[] };
  return data.sessions ?? [];
}

/** Load full session detail: top-level fields + questions + comments.
 *  Utterances and events are fetched separately (lazy, on-demand). */
export async function fetchPastSession(
  id: string
): Promise<Partial<Session> | null> {
  if (!userId()) return null;
  try {
    const r = await fetch(`/api/sessions/${id}`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { session?: Partial<Session> };
    return data.session ?? null;
  } catch {
    return null;
  }
}

/** GET utterances for a saved session — used by PastDebugPanel. */
export async function fetchSessionUtterances(
  id: string
): Promise<Utterance[]> {
  if (!userId()) return [];
  try {
    const r = await fetch(`/api/sessions/${id}/utterances`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { utterances?: Utterance[] };
    return data.utterances ?? [];
  } catch {
    return [];
  }
}

/** GET debug events for a saved session — used by PastDebugPanel. */
export async function fetchSessionEvents(id: string): Promise<DebugEvent[]> {
  if (!userId()) return [];
  try {
    const r = await fetch(`/api/sessions/${id}/events`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { events?: DebugEvent[] };
    return data.events ?? [];
  } catch {
    return [];
  }
}

/** POST a freshly-ended session with all child rows in one shot.
 *  The endLive flow calls this fire-and-forget right after pushing
 *  the session into the local store. */
export async function postSession(
  session: Session,
  speakerRoles: Record<number, "interviewer" | "candidate">,
  allUtterances: Utterance[],
  events: DebugEvent[]
): Promise<void> {
  if (!userId()) return;
  try {
    await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        session: {
          id: session.id,
          title: session.title,
          jd: session.jd,
          resume: session.resume,
          startedAt: session.startedAt,
          durationSeconds: session.durationSeconds,
          jdSummary: session.jdSummary,
          resumeSummary: session.resumeSummary,
          interviewerProfile: session.interviewerProfile,
          interviewerProfileSummary: session.interviewerProfileSummary,
          speakerRoles,
          score: session.score,
          scoreError: session.scoreError,
          parentSessionId: session.parentSessionId,
          sessionMode: session.sessionMode,
        },
        questions: session.questions.map((q) => ({
          id: q.id,
          parentQuestionId: q.parentQuestionId,
          text: q.text,
          askedAtSeconds: q.askedAtSeconds,
          answerText: q.answerText,
          // Pass `kind` through so candidate-kind reverse-Q&A questions
          // get persisted with the right type — without this they'd
          // default to "interviewer" on the server insert and confuse
          // the rendering side.
          kind: q.kind,
          comments: q.comments.map((c) => ({
            id: c.id,
            text: c.text,
            expandedSuggestion: c.expandedSuggestion,
            atSeconds: c.atSeconds,
            kind: c.kind,
            // Snapshot of the interviewer monologue at hint-gen time;
            // present only on listening-kind comments. Pass through so
            // PastView can render "Interviewer mentioned …" without
            // guessing from a fragile time window over utterances.
            contextText: c.contextText,
          })),
        })),
        utterances: allUtterances.map((u) => ({
          id: u.id,
          dgSpeaker: u.dgSpeaker,
          text: u.text,
          atSeconds: u.atSeconds,
          duration: u.duration,
        })),
        events,
      }),
    });
  } catch (e) {
    console.warn("[client-api] postSession failed:", e);
  }
}

export interface PatchFields {
  title?: string;
  score?: SessionScore | null;
  scoreError?: string | null;
  jdSummary?: string;
  resumeSummary?: string;
  interviewerProfileSummary?: string;
  /** Comment-id → expanded text. Merged onto existing comment rows. */
  expandedSuggestions?: Record<string, string>;
  /** S3 keys for persistent recordings. Set after the presigned PUT
   *  upload completes — the client immediately PATCHes them onto the
   *  session row so a future page load can sign a GET URL and play
   *  the recording without depending on the in-memory blob URL. */
  audioS3Key?: string;
  videoS3Key?: string;
}

/** Partial update for the post-session enrichment flow (score,
 *  context summaries, expanded suggestions, rename). */
export async function patchSession(
  id: string,
  fields: PatchFields
): Promise<void> {
  if (!userId()) return;
  try {
    await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(fields),
    });
  } catch (e) {
    console.warn("[client-api] patchSession failed:", e);
  }
}

// =====================================================================
// Recording uploads — Phase 3.
//
// Browser → S3 directly via presigned PUT URL: keeps the blob off
// our Next.js server (a 200MB video is too big to round-trip through
// EB and Lambda response limits). The server only signs URLs and
// records keys.
// =====================================================================

/** Request a presigned PUT URL for a recording. Returns null when
 *  the call failed — caller treats as "no upload available, keep
 *  using the in-memory blob URL". */
export async function requestUploadUrl(args: {
  sessionId: string;
  kind: "audio" | "video";
  contentType: string;
  ext: string;
  /** Optional. When provided, the server stores the object under
   *  `users/.../sessions/.../video.{i}.{ext}` instead of the
   *  canonical `video.{ext}`. Used by the multi-segment upload
   *  path to keep each pause/resume segment as its own S3 object
   *  before ffmpeg-concat fuses them into the canonical key. */
  segmentIndex?: number;
}): Promise<{ url: string; key: string } | null> {
  if (!userId()) return null;
  try {
    const r = await fetch("/api/uploads/sign", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(args),
    });
    if (!r.ok) {
      console.warn("[client-api] requestUploadUrl failed:", r.status);
      return null;
    }
    return (await r.json()) as { url: string; key: string };
  } catch (e) {
    console.warn("[client-api] requestUploadUrl error:", e);
    return null;
  }
}

/** Fetch a fresh presigned GET URL for playback. Used by PastView
 *  whenever it needs a `<video>` / `<audio>` src for a saved
 *  recording. TTL 1h server-side, so a long-watch viewer might need
 *  a refresh — acceptable for the alpha. */
export async function requestPlaybackUrl(args: {
  sessionId: string;
  kind: "audio" | "video";
}): Promise<string | null> {
  if (!userId()) return null;
  try {
    const params = new URLSearchParams({
      sessionId: args.sessionId,
      kind: args.kind,
    });
    const r = await fetch(`/api/uploads/get?${params.toString()}`, {
      headers: authHeaders(),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { url?: string };
    return data.url ?? null;
  } catch {
    return null;
  }
}

/** Upload a Blob to a presigned PUT URL with a one-shot retry.
 *
 *  Critical: `signedContentType` MUST match exactly what the server
 *  put on the PutObjectCommand when signing the URL. If the PUT's
 *  Content-Type header differs (e.g. browsers sending the full
 *  "video/mp4;codecs=avc1..." vs the server signing the bare
 *  "video/mp4"), S3 silently produces a 0-byte object on some code
 *  paths — bug observed in the wild on session sess-1777791644302
 *  where audio.webm uploaded fine but video.mp4 ended up 0 bytes.
 *
 *  The PUT goes directly to S3 (presigned URLs bypass our origin),
 *  so it doesn't pass through CloudFront / ALB / Next.js — just
 *  the browser → S3 hop. */
async function putBlobToS3(
  url: string,
  blob: Blob,
  signedContentType: string,
  diagLabel = "video"
): Promise<boolean> {
  const sizeMb = (blob.size / 1024 / 1024).toFixed(1);
  const attempt = async (
    attemptNum: number
  ): Promise<{ ok: boolean; status?: number; err?: string }> => {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: "PUT",
        body: blob,
        headers: { "content-type": signedContentType },
      });
      const elapsedMs = Date.now() - t0;
      if (!r.ok) {
        // S3 returned 4xx/5xx. Surfaces the status so "wrong
        // content-type vs signed type" (403) shows up distinctly
        // from "internal error" (5xx) in the console.
        console.warn(
          `[client-api] putBlobToS3 ${diagLabel} attempt ${attemptNum} non-OK`,
          { status: r.status, elapsedMs, sizeMb, signedContentType }
        );
        return { ok: false, status: r.status };
      }
      console.log(
        `[client-api] putBlobToS3 ${diagLabel} OK in ${elapsedMs}ms`,
        { sizeMb }
      );
      return { ok: true, status: r.status };
    } catch (e) {
      const elapsedMs = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[client-api] putBlobToS3 ${diagLabel} attempt ${attemptNum} threw`,
        { msg, elapsedMs, sizeMb }
      );
      return { ok: false, err: msg };
    }
  };
  // Up to 3 attempts with linear backoff. fetch has no built-in
  // retry; long uploads occasionally fail on transient TCP resets,
  // and S3 5xx is also retryable per AWS guidance. After 3 failures
  // we give up — surface the failure to the caller so the UI can
  // tell the user the recording didn't save.
  for (let i = 1; i <= 3; i++) {
    const r = await attempt(i);
    if (r.ok) return true;
    // Don't retry a 4xx — those are deterministic (auth/cors/sig
    // mismatch) and won't fix themselves.
    if (r.status && r.status >= 400 && r.status < 500) {
      console.warn(
        `[client-api] putBlobToS3 ${diagLabel} 4xx — not retrying`,
        { status: r.status }
      );
      return false;
    }
    if (i < 3) {
      const backoffMs = 1000 * i;
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }
  return false;
}

/** Full upload helper: fetch blob from a blob: URL, request a
 *  presigned PUT, send the blob, PATCH the session row with the
 *  resulting S3 key. Errors are swallowed (logged) — the in-memory
 *  blob URL keeps working as fallback for the current tab. */
export async function uploadRecording(args: {
  sessionId: string;
  kind: "audio" | "video";
  blobUrl: string;
}): Promise<string | null> {
  if (!userId()) return null;
  try {
    // Pull the blob back out of the object URL. fetch() on a blob:
    // URL resolves locally with no network — same browser tab only.
    const blob = await (await fetch(args.blobUrl)).blob();
    if (!blob.size) return null;

    // Pick an extension from the blob's MIME so PastView's <video>
    // doesn't have to guess. webm is the default for MediaRecorder.
    const mime = (blob.type || "").split(";")[0];
    const ext = (() => {
      if (mime === "audio/webm" || mime === "video/webm") return "webm";
      if (mime === "video/mp4") return "mp4";
      if (mime === "audio/mp4" || mime === "audio/m4a") return "m4a";
      if (mime === "audio/ogg") return "ogg";
      if (mime === "audio/mpeg") return "mp3";
      return args.kind === "video" ? "webm" : "webm";
    })();

    const signedContentType = mime || "application/octet-stream";
    const signed = await requestUploadUrl({
      sessionId: args.sessionId,
      kind: args.kind,
      contentType: signedContentType,
      ext,
    });
    if (!signed) return null;
    const ok = await putBlobToS3(signed.url, blob, signedContentType);
    if (!ok) {
      console.warn("[client-api] PUT to S3 returned not-ok");
      return null;
    }

    // PATCH the session row with the new key. Server-side PATCH
    // does a HeadObject on the key before accepting it (verifies
    // ContentLength > 0) — that's the safety net against the
    // Content-Type-mismatch / network-stall failure mode where
    // S3 returns 200 but stores a 0-byte object. If the verify
    // fails, PATCH returns 400; we return null so the local store
    // doesn't pretend the recording is on S3.
    const patched = await patchSessionStrict(args.sessionId, {
      [args.kind === "audio" ? "audioS3Key" : "videoS3Key"]: signed.key,
    } as PatchFields);
    if (!patched) {
      console.warn(
        "[client-api] upload verification failed — server rejected the key",
        { sessionId: args.sessionId, key: signed.key, blobSize: blob.size }
      );
      return null;
    }
    return signed.key;
  } catch (e) {
    console.warn("[client-api] uploadRecording failed:", e);
    return null;
  }
}

/** Multi-segment video upload. Each pause/resume cycle in the live
 *  session produced its own MP4 segment (a fresh MediaRecorder run
 *  → its own ftyp+moov boxes → can't be naively concatenated into
 *  one Blob without breaking demuxers).
 *
 *  Flow:
 *    1) For each segment, request a presigned PUT URL with
 *       segmentIndex set so the server stores it under
 *       `users/.../sessions/.../video.{i}.mp4`.
 *    2) PUT each segment in parallel (Promise.all). All-or-nothing —
 *       if any segment PUT fails we abort and return null; the user
 *       can re-end-session and retry.
 *    3) Call /api/uploads/concat with the segment keys. Server runs
 *       `ffmpeg -f concat -i list.txt -c copy final.mp4` — a non-
 *       re-encoding remux that takes ~1s and produces a valid
 *       single-segment MP4 ready for WeChat / iOS / QuickTime.
 *    4) Server uploads the final to the canonical
 *       `users/.../sessions/.../video.mp4` key, updates the DB row,
 *       optionally deletes the segment files, and returns the
 *       canonical key.
 *
 *  Single-segment fast path: when `segmentUrls.length === 1`, we
 *  PUT the single segment directly to the canonical key (no .{i}
 *  suffix) and skip the concat entirely. ~1-3s end to end.
 */
export async function uploadRecordingMultiSegment(args: {
  sessionId: string;
  segmentUrls: string[];
  mime: string;
  /** When true, segments are already in IndexedDB cache (this is a
   *  resume on next /app load). Skip the blob: URL fetch + initial
   *  cache-write step entirely and use the cached blobs directly. */
  resumeFromCache?: boolean;
}): Promise<string | null> {
  if (!userId()) return null;
  // Local alias for logUploadEvent — keeps the call sites short
  // without re-importing this same file.
  const log = logUploadEvent;
  if (args.segmentUrls.length === 0 && !args.resumeFromCache) return null;
  try {
    const baseMime = (args.mime || "").split(";")[0] || "video/mp4";
    const ext = baseMime === "video/webm" ? "webm" : "mp4";

    // Pull blobs — either from blob: URLs (fresh upload) or from
    // IndexedDB (resume). Both produce the same `valid: Blob[]`
    // input to the rest of the pipeline.
    let valid: Blob[];
    const cacheMod = await import("./upload-cache");
    if (args.resumeFromCache) {
      const cached = await cacheMod.getCachedSession(args.sessionId);
      const videoSegs = cached.filter((c) => c.kind === "video");
      if (videoSegs.length === 0) {
        log(args.sessionId, "upload", "resume-no-cache", {
          reason: "no video segments in IndexedDB",
        });
        return null;
      }
      valid = videoSegs.map((c) => c.blob);
      log(args.sessionId, "upload", "resume-begin", {
        segments: valid.length,
        totalBytes: valid.reduce((s, b) => s + b.size, 0),
      });
    } else {
      const segmentBlobs: Blob[] = await Promise.all(
        args.segmentUrls.map(async (u) => (await fetch(u)).blob())
      );
      valid = segmentBlobs.filter((b) => b.size > 0);
      if (valid.length === 0) return null;

      // Persist each segment to IndexedDB BEFORE we start network
      // PUTs. If the tab closes / browser crashes / network drops
      // mid-upload, the next /app load will discover these cached
      // blobs and resume the upload (see app/page.tsx mount). The
      // cache write is awaited (not fire-and-forget) so a synchronous
      // tab-close right after End still has the data on disk.
      try {
        await Promise.all(
          valid.map((blob, i) =>
            cacheMod.cacheBlob({
              sessionId: args.sessionId,
              kind: "video",
              segmentIndex: i,
              mime: baseMime,
              blob,
            })
          )
        );
      } catch (e) {
        // Cache failure shouldn't block the upload — just log and
        // proceed without resume safety net for this session.
        console.warn("[client-api] IndexedDB cache write failed:", e);
        log(args.sessionId, "upload", "cache-write-failed", {
          message: e instanceof Error ? e.message : String(e),
        });
      }
      log(args.sessionId, "upload", "begin", {
        segments: valid.length,
        totalBytes: valid.reduce((s, b) => s + b.size, 0),
        mime: baseMime,
      });
    }

    // === Always-via-concat path ===
    // Even when there's only ONE segment, we route through the
    // concat endpoint instead of PUTing directly to the canonical
    // key. Why: Chrome's MediaRecorder MP4 output is FRAGMENTED MP4
    // (ftyp+moov+moof+mdat). Chrome / QuickTime / VLC play it fine,
    // but WeChat / older iOS reject fragmented containers. Running
    // every recording through `ffmpeg -f concat -c copy -movflags
    // +faststart` produces a NON-fragmented MP4 (single moov +
    // single mdat) that plays everywhere. For a one-segment input
    // this is just a fast container re-mux (~1-2s) — no codec
    // re-encoding.
    //
    // All segments — including the lone one — get the `.{i}` key
    // suffix so the server-side concat code's prefix-validation
    // (segments live under the session prefix) treats every upload
    // uniformly. The intermediate keys are deleted by the concat
    // worker after a successful remux.

    // Sign + PUT each segment in parallel under its own .{i} key.
    const signedSegments = await Promise.all(
      valid.map((_, i) =>
        requestUploadUrl({
          sessionId: args.sessionId,
          kind: "video",
          contentType: baseMime,
          ext,
          segmentIndex: i,
        })
      )
    );
    if (signedSegments.some((s) => !s)) {
      console.warn("[client-api] multi-segment sign failed");
      log(args.sessionId, "upload", "sign-failed", {
        segments: valid.length,
        signedCount: signedSegments.filter((s) => s).length,
      });
      emitUploadError(
        "Couldn't get upload URLs for the recording segments — not saved."
      );
      return null;
    }
    log(args.sessionId, "upload", "sign-complete", {
      segments: signedSegments.length,
    });

    // PUT each segment with per-segment event logging + cache cleanup.
    // Promise.all preserves the legacy behavior: parallel PUTs, abort
    // on the first failure (any segment failing means the concat won't
    // be valid). The cache delete after each success is fire-and-forget
    // — failures there are harmless leftovers that pruneStale eventually
    // clears.
    const putResults = await Promise.all(
      signedSegments.map(async (s, i) => {
        const segT0 = Date.now();
        const ok = await putBlobToS3(
          s!.url,
          valid[i],
          baseMime,
          `video-seg-${i}`
        );
        const elapsedMs = Date.now() - segT0;
        if (ok) {
          log(args.sessionId, "upload", "segment-success", {
            segment: i,
            sizeBytes: valid[i].size,
            elapsedMs,
          });
          // Free the disk slot now — segment is on S3.
          void cacheMod
            .removeCachedSegment(args.sessionId, "video", i)
            .catch(() => {
              /* harmless leftover */
            });
        } else {
          log(args.sessionId, "upload", "segment-failed", {
            segment: i,
            sizeBytes: valid[i].size,
            elapsedMs,
          });
        }
        return ok;
      })
    );
    if (putResults.some((ok) => !ok)) {
      console.warn("[client-api] multi-segment PUT failed");
      emitUploadError(
        "One or more recording segments failed to upload — try re-ending the session."
      );
      return null;
    }

    // Ask the server to ffmpeg-concat the segments. Returns the
    // canonical final key on success. Server-side this is the
    // bounded operation: typical 5-min session (3 segments) takes
    // 3-7s end-to-end (S3 download + `-c copy` remux + S3 upload).
    const segmentKeys = signedSegments.map((s) => s!.key);
    const concatT0 = Date.now();
    log(args.sessionId, "upload", "concat-begin", {
      segments: segmentKeys.length,
    });
    const r = await fetch("/api/uploads/concat", {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        sessionId: args.sessionId,
        segmentKeys,
        mime: baseMime,
      }),
    });
    if (!r.ok) {
      console.warn("[client-api] concat endpoint failed", r.status);
      log(args.sessionId, "upload", "concat-failed", {
        status: r.status,
        elapsedMs: Date.now() - concatT0,
      });
      emitUploadError(
        "Server couldn't stitch the recording segments — recording not saved."
      );
      return null;
    }
    const data = (await r.json()) as { key?: string };
    log(args.sessionId, "upload", "complete", {
      key: data.key,
      concatElapsedMs: Date.now() - concatT0,
    });
    // End-to-end success — purge any remaining cache for this
    // session (segments from a partial earlier attempt, etc.).
    void cacheMod.clearSessionCache(args.sessionId).catch(() => {
      /* harmless */
    });
    return data.key ?? null;
  } catch (e) {
    console.warn("[client-api] uploadRecordingMultiSegment failed:", e);
    log(args.sessionId, "upload", "fatal-error", {
      message: e instanceof Error ? e.message : String(e),
    });
    emitUploadError(
      "Recording upload failed — see browser console for details."
    );
    return null;
  }
}

/** Dispatch a user-visible toast on upload failure. The app already
 *  listens for `ic:error` events (orchestrator errors / Deepgram
 *  reconnects / etc.) and renders them as transient banners — we
 *  reuse that same channel so upload failures aren't silent. */
function emitUploadError(msg: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("ic:error", { detail: msg }));
  }
}

/** Like patchSession but returns whether the server accepted it.
 *  Used by the upload-verify path so a 0-byte S3 object detected
 *  server-side surfaces as "upload didn't really work" instead of
 *  silently corrupting the session row. */
async function patchSessionStrict(
  id: string,
  fields: PatchFields
): Promise<boolean> {
  if (!userId()) return false;
  try {
    const r = await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(fields),
    });
    return r.ok;
  } catch (e) {
    console.warn("[client-api] patchSessionStrict failed:", e);
    return false;
  }
}

export async function deletePastSessionRemote(id: string): Promise<void> {
  if (!userId()) return;
  try {
    await fetch(`/api/sessions/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
  } catch (e) {
    console.warn("[client-api] deletePastSession failed:", e);
  }
}

/* ============================================================
   Session share-link lifecycle. Available to EITHER the session's
   owner OR the admin (server enforces via gateRequest in the route).
   The client wrappers always send x-user-id; the server picks the
   right auth path.
   ============================================================ */

export interface SessionShare {
  token: string;
  sessionId: string;
  createdAt: string;
  viewerUrl: string;
  jsonUrl: string;
}

/** Returns the existing live share for a session, or null if none. */
export async function getSessionShare(
  sessionId: string
): Promise<SessionShare | null> {
  try {
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/share`,
      { headers: authHeaders(), cache: "no-store" }
    );
    if (!r.ok) return null;
    const data = (await r.json()) as { share: SessionShare | null };
    return data.share;
  } catch {
    return null;
  }
}

/** Mints (or returns existing) share token for a session. */
export async function createSessionShare(
  sessionId: string
): Promise<SessionShare | { error: string }> {
  try {
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/share`,
      {
        method: "POST",
        headers: authHeaders(),
      }
    );
    const data = (await r.json().catch(() => ({}))) as {
      share?: SessionShare;
      error?: string;
    };
    if (!r.ok || !data.share) {
      return { error: data.error || "Couldn't create share link." };
    }
    return data.share;
  } catch {
    return { error: "Network error. Try again." };
  }
}

/** Revokes the live share for a session. Returns true on success. */
export async function revokeSessionShare(
  sessionId: string
): Promise<boolean> {
  try {
    const r = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/share`,
      {
        method: "DELETE",
        headers: authHeaders(),
      }
    );
    return r.ok;
  } catch {
    return false;
  }
}
