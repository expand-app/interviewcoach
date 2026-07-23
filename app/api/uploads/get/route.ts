import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";
import { signGetUrl } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * GET /api/uploads/get?sessionId=...&kind=audio|video
 *
 * Returns { url } — a presigned GET URL the browser uses for the
 * <audio>/<video> element's src. TTL 1h. Server-side ownership
 * check: only the session's user can fetch the URL.
 *
 * The session row stores the s3 key (audio_s3_key / video_s3_key)
 * once the upload completes; this route signs a fresh URL on each
 * call so the source-of-truth is the persistent key, not a stale
 * URL.
 */

export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 }
    );
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  const kind = searchParams.get("kind");
  // Optional: client passes `filename` to force the URL into
  // download mode (S3 responds with Content-Disposition: attachment).
  // Without it, the URL is suitable for inline <video src=...>
  // playback (browser streams it instead of saving).
  const filename = searchParams.get("filename") || undefined;
  // kind=video-mov → return the pre-transcoded MOV's presigned URL,
  // used by the Download button for the fast path. 404 when the
  // background transcode hasn't completed yet — client falls back
  // to the on-demand /api/uploads/download streaming endpoint.
  const validKinds = new Set(["audio", "video", "video-mov"]);
  if (!sessionId || !kind || !validKinds.has(kind)) {
    return NextResponse.json(
      { error: "sessionId + kind=audio|video|video-mov required" },
      { status: 400 }
    );
  }

  const col =
    kind === "audio"
      ? "audio_s3_key"
      : kind === "video"
        ? "video_s3_key"
        : "video_mov_s3_key";
  const r = await query<{ key: string | null }>(
    `SELECT ${col} AS key FROM sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  if (r.rows.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const key = r.rows[0].key;
  if (!key) {
    // For video-mov specifically, "not ready" is the COMMON case
    // (transcode in progress) — return 200 with {ready: false}
    // instead of 404 so the polling client doesn't flood EB
    // Enhanced Health's 4xx failure-rate counter. Frequent 4xx
    // causes false-positive "instance unhealthy" alerts and can
    // abort otherwise-clean deploys mid-rollout.
    if (kind === "video-mov") {
      return NextResponse.json({ ready: false });
    }
    return NextResponse.json(
      { error: `no ${kind} uploaded for this session` },
      { status: 404 }
    );
  }

  const url = await signGetUrl(key, filename);
  return NextResponse.json(kind === "video-mov" ? { ready: true, url } : { url });
}
