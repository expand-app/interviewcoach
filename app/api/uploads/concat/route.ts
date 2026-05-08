import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";
import { concatSegmentsToCanonical } from "@/lib/transcode";

export const runtime = "nodejs";
// ffmpeg concat (`-c copy`) is fast (~1-3s) but the wall-time
// includes downloading N segments from S3 and uploading the
// stitched result back. A long session with many pause/resume
// segments could push past the default 10s API timeout. 60s gives
// generous headroom while still bounding the worst case.
export const maxDuration = 60;

/**
 * POST /api/uploads/concat
 *
 * Body: { sessionId, segmentKeys: string[], mime?: string }
 *
 * Returns: { key } where `key` is the canonical S3 path of the
 * stitched MP4 (`users/USER/sessions/SESSION/video.mp4`). PastView
 * playback + the Download button look up against this key.
 *
 * What it does:
 *   1. Verifies the caller owns the session (same ownership check
 *      pattern as /api/uploads/sign).
 *   2. Verifies every segmentKey is under this user's prefix (defends
 *      against a tampered request that asks the server to concat
 *      someone else's recordings).
 *   3. Calls concatSegmentsToCanonical → ffmpeg `-c copy` → S3 upload
 *      → DB UPDATE video_s3_key → segment cleanup.
 *
 * Trigger flow: client-api.ts uploadRecordingMultiSegment calls this
 * AFTER all segments have been PUT to S3. The client then waits for
 * the response (typically 3-7s) and updates its local Session row.
 *
 * Not idempotent: calling with the same segmentKeys twice will work
 * the first time (segments exist) and fail the second time (segments
 * were deleted post-concat). That's fine — the client only fires
 * once per end-session.
 */

interface Body {
  sessionId?: string;
  segmentKeys?: string[];
  mime?: string;
}

export async function POST(req: Request) {
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

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const { sessionId, segmentKeys, mime } = body;
  if (
    !sessionId ||
    !Array.isArray(segmentKeys) ||
    segmentKeys.length === 0
  ) {
    return NextResponse.json(
      { error: "sessionId + non-empty segmentKeys[] required" },
      { status: 400 }
    );
  }
  if (segmentKeys.length > 200) {
    // Defensive cap. A real session would never reach this — even
    // pausing every minute for a 4-hour session is 240 segments,
    // way past anything plausible.
    return NextResponse.json(
      { error: "too many segments (max 200)" },
      { status: 400 }
    );
  }

  // Ownership: the session row belongs to this user.
  const own = await query<{ id: string }>(
    `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  if (own.rows.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  // Every segmentKey MUST live under this user/session prefix. A
  // malicious / buggy client sending arbitrary keys here would
  // otherwise let us read someone else's recordings.
  const prefix = `users/${userId}/sessions/${sessionId}/`;
  for (const k of segmentKeys) {
    if (typeof k !== "string" || !k.startsWith(prefix)) {
      return NextResponse.json(
        { error: `segmentKey '${k}' outside session prefix` },
        { status: 400 }
      );
    }
  }

  const finalKey = await concatSegmentsToCanonical({
    userId,
    sessionId,
    segmentKeys,
    outputMime: mime,
  });
  if (!finalKey) {
    return NextResponse.json(
      { error: "concat failed — see server logs" },
      { status: 500 }
    );
  }

  return NextResponse.json({ key: finalKey });
}
