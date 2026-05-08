import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";
import { recordingKey, signPutUrl } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * POST /api/uploads/sign
 *
 * Body: { sessionId, kind: "audio" | "video", contentType, ext }
 *
 * Returns: { url, key } where:
 *   - url is a presigned PUT URL the browser PUTs the blob to
 *   - key is the S3 object key the client passes back to PATCH
 *     /api/sessions/:id once upload completes
 *
 * Server validates that the caller actually owns the session before
 * issuing the URL — without this check, anyone with a valid x-user-id
 * could spam our bucket under arbitrary session ids.
 */

interface Body {
  sessionId?: string;
  kind?: "audio" | "video";
  contentType?: string;
  ext?: string;
  /** Optional. When set, the issued key carries a `.{i}` suffix —
   *  used by the multi-segment video upload flow before
   *  /api/uploads/concat fuses them into the canonical key. */
  segmentIndex?: number;
}

const ALLOWED_AUDIO_EXT = new Set(["webm", "mp4", "ogg", "mp3", "m4a", "wav"]);
const ALLOWED_VIDEO_EXT = new Set(["webm", "mp4", "mov", "mkv"]);

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

  const { sessionId, kind, contentType, ext, segmentIndex } = body;
  if (!sessionId || !kind || !contentType || !ext) {
    return NextResponse.json(
      { error: "sessionId, kind, contentType, ext required" },
      { status: 400 }
    );
  }
  if (kind !== "audio" && kind !== "video") {
    return NextResponse.json(
      { error: "kind must be 'audio' or 'video'" },
      { status: 400 }
    );
  }
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  const allowed = kind === "audio" ? ALLOWED_AUDIO_EXT : ALLOWED_VIDEO_EXT;
  if (!allowed.has(cleanExt)) {
    return NextResponse.json(
      { error: `ext '${cleanExt}' not allowed for ${kind}` },
      { status: 400 }
    );
  }

  // Ownership check.
  const own = await query<{ id: string }>(
    `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]
  );
  if (own.rows.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }

  // segmentIndex sanity: must be a non-negative integer < 1000 (cap
  // is purely defensive — a session can't possibly have hundreds of
  // pause/resume cycles).
  let segIdx: number | undefined;
  if (segmentIndex !== undefined) {
    if (
      typeof segmentIndex !== "number" ||
      !Number.isInteger(segmentIndex) ||
      segmentIndex < 0 ||
      segmentIndex >= 1000
    ) {
      return NextResponse.json(
        { error: "invalid segmentIndex" },
        { status: 400 }
      );
    }
    segIdx = segmentIndex;
  }

  const key = recordingKey(userId, sessionId, kind, cleanExt, segIdx);
  const url = await signPutUrl(key, contentType);
  return NextResponse.json({ url, key });
}
