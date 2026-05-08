import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { isDbConfigured, query } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";
import { isAdminRequest } from "@/lib/auth-server";
import { RECORDINGS_BUCKET, RECORDINGS_REGION } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * GET /api/uploads/download?sessionId=...&kind=video|audio
 *
 * Streams a transcoded MOV (h264 + AAC) of the saved recording. The
 * source is whatever's at the session row's audio_s3_key /
 * video_s3_key — typically VP9/WebM from the new MediaRecorder path.
 * VP9 in WebM doesn't play in QuickTime / iOS / many sharing apps,
 * which is why this route exists. We pipe S3 → ffmpeg → response so
 * no temp file hits disk and the user sees bytes flowing within ~2-3s
 * of clicking Download.
 *
 * Auth model matches the rest of the app: x-user-id header that the
 * client sets after signing in. Caller is the page's own download
 * handler (a fetch() with the header), NOT a plain <a download>
 * (which can't carry custom headers).
 *
 * Failure modes:
 *   - DB not configured → 503 (route can't look up the s3 key).
 *   - x-user-id missing → 401.
 *   - ffmpeg binary missing → 503 (likely a fresh deploy where
 *     .ebextensions/02-ffmpeg.config hasn't run yet).
 *   - Session not owned by caller / not found → 404.
 *   - No recording uploaded for that kind → 404.
 *   - ffmpeg crashes mid-stream → response truncates with whatever
 *     bytes already flowed; client sees a corrupt download. Retry.
 */

const FFMPEG_BIN = "/usr/local/bin/ffmpeg";
const ALLOWED_KINDS = new Set(["audio", "video"]);

let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) s3 = new S3Client({ region: RECORDINGS_REGION });
  return s3;
}

export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 }
    );
  }
  const userId = getUserIdFromHeaders(req);
  // Admin path: when isAdminRequest passes, skip the ownership check
  // entirely (admin can download any user's recording for triage from
  // the admin debug page). Non-admin still requires a matching
  // x-user-id, exactly as before.
  const isAdmin = await isAdminRequest(req);
  if (!isAdmin && !userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get("sessionId");
  const kind = searchParams.get("kind");
  if (!sessionId || !kind || !ALLOWED_KINDS.has(kind)) {
    return NextResponse.json(
      { error: "sessionId + kind=audio|video required" },
      { status: 400 }
    );
  }

  if (!existsSync(FFMPEG_BIN)) {
    console.error("[download] ffmpeg binary missing at", FFMPEG_BIN);
    return NextResponse.json(
      { error: "Transcoder not installed on server. Try again in a few minutes." },
      { status: 503 }
    );
  }

  // Ownership check + key lookup, in one query. Admin path drops the
  // user_id filter so any session can be reached; non-admin path
  // matches the original AND user_id = $2 ownership filter.
  const col = kind === "audio" ? "audio_s3_key" : "video_s3_key";
  const titleCol = "title";
  const r = isAdmin
    ? await query<{ key: string | null; title: string }>(
        `SELECT ${col} AS key, ${titleCol} AS title
           FROM sessions
          WHERE id = $1`,
        [sessionId]
      )
    : await query<{ key: string | null; title: string }>(
        `SELECT ${col} AS key, ${titleCol} AS title
           FROM sessions
          WHERE id = $1 AND user_id = $2`,
        [sessionId, userId]
      );
  if (r.rows.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const { key, title } = r.rows[0];
  if (!key) {
    return NextResponse.json(
      { error: `no ${kind} uploaded for this session` },
      { status: 404 }
    );
  }

  // Fetch the source object as a node Readable.
  const s3Resp = await getS3().send(
    new GetObjectCommand({ Bucket: RECORDINGS_BUCKET, Key: key })
  );
  const body = s3Resp.Body;
  if (!body) {
    return NextResponse.json({ error: "empty source object" }, { status: 502 });
  }
  const sourceStream = body as Readable;

  // Spawn ffmpeg.
  // - libx264 veryfast / CRF 20: visually lossless for screen-record
  //   content, ~3-5x realtime on a t3.small. A 17-min recording
  //   transcodes in ~3-5 minutes; CloudFront's between-bytes timeout
  //   is 60s but ffmpeg emits frames ~every 1-2s so the connection
  //   stays alive throughout.
  // - aac 192k: clean voice audio, plays everywhere.
  // - -movflags +faststart+frag_keyframe+empty_moov+default_base_moof:
  //   produce fragmented MP4 / MOV that's playable while still
  //   downloading. Without these the moov atom lands at end-of-file
  //   and ffmpeg has to buffer the whole transcode before writing
  //   anything (no streaming output = bad UX + ffmpeg holds memory).
  // - -f mov: explicit MOV container (vs default MP4 derived from
  //   extension). MOV is what QuickTime / iMovie / Keynote want.
  const ffArgs = [
    "-loglevel", "error",
    "-i", "pipe:0",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart+frag_keyframe+empty_moov+default_base_moof",
    "-f", "mov",
    "pipe:1",
  ];
  const ff = spawn(FFMPEG_BIN, ffArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Pipe source bytes into ffmpeg.
  sourceStream.pipe(ff.stdin);
  sourceStream.on("error", (e) => {
    console.warn("[download] source stream error:", e);
    ff.stdin.destroy();
  });

  // Surface stderr in CloudWatch so we can debug bad inputs.
  let stderrTail = "";
  ff.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
  });
  ff.on("close", (code) => {
    if (code !== 0) {
      console.warn("[download] ffmpeg exited", code, stderrTail);
    }
  });

  // Filename: sanitized session title + .mov.
  const safe = (title || "interview-recording")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${safe || "interview-recording"} — ${stamp}.mov`;

  return new Response(Readable.toWeb(ff.stdout) as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "video/quicktime",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "no-store",
    },
  });
}
