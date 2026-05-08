/**
 * GET /api/share/[token]/audio
 *
 * Twin of /api/share/[token]/video — see that file's docblock for
 * the full design rationale (China cross-border S3 reachability,
 * range request passthrough, security via token-binding).
 *
 * Audio is much smaller than video (~50 MB for an hour-long session
 * vs ~150 MB video) so the cost / latency considerations are less
 * severe, but the same GFW-blocking-S3 problem applies. Without
 * this proxy, mainland users hit an audio-only fallback that also
 * won't load.
 */

import { NextRequest } from "next/server";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { isDbConfigured, query } from "@/lib/db";
import { RECORDINGS_BUCKET, RECORDINGS_REGION } from "@/lib/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) s3 = new S3Client({ region: RECORDINGS_REGION });
  return s3;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  if (!isDbConfigured()) {
    return new Response("Database not configured.", { status: 503 });
  }

  const { token } = await ctx.params;
  const cleanToken = token?.trim();
  if (!cleanToken || !/^share-[A-Za-z0-9_-]{20,128}$/.test(cleanToken)) {
    return new Response("Not found", { status: 404 });
  }

  const r = await query<{
    revoked_at: Date | null;
    audio_s3_key: string | null;
  }>(
    `SELECT sh.revoked_at, s.audio_s3_key
       FROM session_shares sh
       JOIN sessions s ON s.id = sh.session_id
      WHERE sh.token = $1`,
    [cleanToken]
  );
  if (r.rowCount === 0) {
    return new Response("Not found", { status: 404 });
  }
  if (r.rows[0].revoked_at !== null) {
    return new Response("Share has been revoked", { status: 410 });
  }
  const audioKey = r.rows[0].audio_s3_key;
  if (!audioKey) {
    return new Response("No audio on this session", { status: 404 });
  }

  const rangeHeader = req.headers.get("range") || undefined;

  try {
    const s3Resp = await getS3().send(
      new GetObjectCommand({
        Bucket: RECORDINGS_BUCKET,
        Key: audioKey,
        Range: rangeHeader,
      })
    );

    if (!s3Resp.Body) {
      return new Response("Empty response from storage", { status: 500 });
    }

    const isPartial = !!s3Resp.ContentRange;
    const headers = new Headers();
    // Audio key extension isn't reliable (.webm, .mp4, .m4a all in
    // the wild) so trust S3's stored ContentType where present, fall
    // back to a generic application/octet-stream that browsers will
    // sniff. Most are audio/webm or audio/mp4.
    headers.set("Content-Type", s3Resp.ContentType || "application/octet-stream");
    if (s3Resp.ContentLength != null) {
      headers.set("Content-Length", String(s3Resp.ContentLength));
    }
    if (s3Resp.ContentRange) {
      headers.set("Content-Range", s3Resp.ContentRange);
    }
    headers.set("Accept-Ranges", "bytes");
    if (s3Resp.ETag) headers.set("ETag", s3Resp.ETag);
    if (s3Resp.LastModified) {
      headers.set("Last-Modified", s3Resp.LastModified.toUTCString());
    }
    headers.set("Cache-Control", "public, max-age=3600");

    const nodeStream = s3Resp.Body as Readable;
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    return new Response(webStream, {
      status: isPartial ? 206 : 200,
      headers,
    });
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    const httpCode = err.$metadata?.httpStatusCode;
    if (err.name === "NoSuchKey" || httpCode === 404) {
      return new Response("Audio not found in storage", { status: 404 });
    }
    if (httpCode === 416) {
      return new Response("Range not satisfiable", { status: 416 });
    }
    console.error("[/api/share/:token/audio] S3 error:", e);
    return new Response("Storage error", { status: 502 });
  }
}
