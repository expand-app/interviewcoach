/**
 * GET /api/share/[token]/video
 *
 * Streaming proxy that serves the share-token's video bytes through
 * the puebulo.com domain rather than handing the browser a direct
 * AWS S3 signed URL. Reason: `*.s3.us-east-1.amazonaws.com` is
 * unreliable from inside mainland China — TCP RST, throttling, and
 * QoS on cross-border video streams cause the iOS / WeChat <video>
 * element to fail with MediaError code 4 (which looks like "format
 * not supported" but is actually "URL didn't deliver bytes"). The
 * primary site domain `puebulo.com` is reachable, so by relaying
 * S3 bytes through here we get China-friendly delivery without
 * needing ICP filing or migrating storage to a Chinese CDN.
 *
 * Security model: the share token IS the auth (same as the JSON
 * endpoint at /api/share/[token]). 410 if revoked, 404 if missing.
 * The token-to-video binding lives in the DB, so a request for
 * /api/share/<token-A>/video can only ever serve token-A's video
 * — no key parameter to manipulate.
 *
 * Range requests: passed straight through to S3 GetObject. The
 * client's Range header lands as the GetObjectCommand `Range`
 * input; S3's Content-Range, ContentLength, and ETag come back in
 * the response. iOS Safari sends `Range: bytes=0-1` first to probe
 * metadata, then `Range: bytes=N-` as the user seeks — both work.
 *
 * Cost model: every byte streamed costs $0.09/GB AWS internet
 * egress (us-east-1 rate, same regardless of viewer's country).
 * For a 161 MB video, that's $0.0145 per playthrough. S3 → EB
 * (intra-region) transit is free.
 *
 * Caching: Cache-Control: public, max-age=3600. The proxy URL is
 * stable per session so browser cache reuse helps a lot when a
 * single viewer scrubs the timeline. We don't put this behind a
 * shared cache (CloudFront/etc) because the share-token URL is
 * public-but-unguessable; cache-poisoning isn't a concern but
 * keeping things simple is.
 */

import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { isDbConfigured, query } from "@/lib/db";
import { RECORDINGS_BUCKET, RECORDINGS_REGION } from "@/lib/s3";

export const runtime = "nodejs";
// Force dynamic — Next.js must NOT cache these responses (each Range
// request has different bytes, and signed S3 calls happen per-request
// on our side).
export const dynamic = "force-dynamic";

// One shared S3 client per process. The SDK pools connections, so
// reuse is essential for proxy throughput.
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

  // Resolve token → video key. We prefer the iOS-compatible mov key
  // (full re-encode at libx264 baseline level 3.1 / 720p cap, see
  // lib/transcode.ts) and fall back to the raw video_s3_key if the
  // backfill hasn't run yet. The latter MAY be MediaRecorder's
  // fragmented MP4 which mobile browsers can't always play, but
  // serving SOMETHING is better than 404 — desktop viewers will
  // still see content while transcode is running in the background.
  const r = await query<{
    revoked_at: Date | null;
    video_s3_key: string | null;
    video_mov_s3_key: string | null;
  }>(
    `SELECT sh.revoked_at, s.video_s3_key, s.video_mov_s3_key
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
  const videoKey = r.rows[0].video_mov_s3_key || r.rows[0].video_s3_key;
  if (!videoKey) {
    return new Response("No video on this session", { status: 404 });
  }

  // Pass-through Range. iOS Safari sends `Range: bytes=0-1` first to
  // probe metadata, then `Range: bytes=N-` requests as the user
  // seeks. Both cases get forwarded verbatim.
  const rangeHeader = req.headers.get("range") || undefined;

  try {
    const s3Resp = await getS3().send(
      new GetObjectCommand({
        Bucket: RECORDINGS_BUCKET,
        Key: videoKey,
        Range: rangeHeader,
      })
    );

    if (!s3Resp.Body) {
      console.warn("[/api/share/:token/video] empty S3 body", { videoKey });
      return new Response("Empty response from storage", { status: 500 });
    }

    // 206 if S3 honored a Range, 200 otherwise. S3 sets ContentRange
    // only on partial responses, so that's our switch.
    const isPartial = !!s3Resp.ContentRange;

    const headers = new Headers();
    headers.set("Content-Type", s3Resp.ContentType || "video/mp4");
    if (s3Resp.ContentLength != null) {
      headers.set("Content-Length", String(s3Resp.ContentLength));
    }
    if (s3Resp.ContentRange) {
      headers.set("Content-Range", s3Resp.ContentRange);
    }
    headers.set("Accept-Ranges", "bytes");
    if (s3Resp.ETag) {
      headers.set("ETag", s3Resp.ETag);
    }
    if (s3Resp.LastModified) {
      headers.set("Last-Modified", s3Resp.LastModified.toUTCString());
    }
    // Browser-cache only — we don't put this behind a shared cache.
    // 1h is long enough that scrubbing the timeline reuses bytes,
    // short enough that revoking a share takes effect within an
    // hour for clients that keep the page open.
    headers.set("Cache-Control", "public, max-age=3600");

    // Convert Node Readable → Web ReadableStream so the Response
    // body API accepts it. Streaming (rather than buffering) is
    // critical: a 161 MB file would otherwise sit in EB RAM for the
    // whole download, and t3.small's 2 GB couldn't sustain even a
    // few concurrent viewers.
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
      return new Response("Video not found in storage", { status: 404 });
    }
    if (httpCode === 416) {
      // Client requested a range past EOF. Pass through so iOS knows
      // to retry with a smaller range.
      return new Response("Range not satisfiable", { status: 416 });
    }
    console.error("[/api/share/:token/video] S3 error:", e);
    return new Response("Storage error", { status: 502 });
  }
}
