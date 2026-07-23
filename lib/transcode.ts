/**
 * Background WebM → MOV transcode + S3 upload + DB patch.
 *
 * Triggered fire-and-forget from /api/sessions/:id PATCH (when
 * `videoS3Key` lands) and from /api/sessions/:id GET (when an old
 * session was opened that didn't have the MOV cached yet).
 *
 * Design:
 *   - Spawn ffmpeg, pipe S3 WebM → ffmpeg stdin.
 *   - Pipe ffmpeg stdout → S3 multipart upload (lib-storage Upload).
 *     This streams without buffering the whole MOV in RAM — important
 *     because t3.small has 2GB and a 17-min recording at high quality
 *     is 100-200MB.
 *   - On success: UPDATE sessions SET video_mov_s3_key = <new key>.
 *   - On failure: log + leave column null. Next GET will retrigger.
 *
 * In-memory dedupe: the keyByInProgress map prevents two concurrent
 * triggers (e.g. PATCH + GET firing close together) from running two
 * ffmpegs for the same session. Process-local — fine for a single
 * EB instance; if we ever scale out, swap for a Redis lock or a
 * proper job queue.
 */

import { spawn } from "node:child_process";
import { existsSync, promises as fsp, createReadStream } from "node:fs";
import { join as pathJoin } from "node:path";

/**
 * Disk-backed staging root for ffmpeg concat / transcode work.
 *
 * On Amazon Linux 2023 EB instances, `/tmp` is a tmpfs (RAM-backed)
 * mount sized at roughly 50% of system RAM. A t3.small has only 2GB
 * RAM, so /tmp caps at ~1GB total — not enough headroom for a
 * 35-minute fragmented MP4 (~500MB) plus its remuxed copy in flight.
 * The end result is `ffmpeg ... Error muxing a packet: No space left
 * on device` even though the EBS root volume has 30GB free.
 *
 * `/var/tmp` IS on the EBS root volume (not tmpfs) on the same AMI,
 * so a 1GB ffmpeg workload fits with ~28GB to spare. We stage to a
 * project-prefixed subdir under /var/tmp; the cleanup paths below
 * still rm-rf the staging dir after each concat so we don't leak.
 *
 * Falls back to /tmp on systems where /var/tmp doesn't exist (dev
 * Macs / Windows). Production is always Linux.
 */
const STAGING_ROOT = existsSync("/var/tmp") ? "/var/tmp" : "/tmp";
import { Readable, PassThrough } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { query } from "./db";
import { RECORDINGS_BUCKET, RECORDINGS_REGION } from "./s3";

const FFMPEG_BIN = "/usr/local/bin/ffmpeg";

let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) s3 = new S3Client({ region: RECORDINGS_REGION });
  return s3;
}

const inProgress = new Set<string>();
// Global concurrency gate: only ONE ffmpeg process at a time per
// instance. t3.small has 2 vCPU + 2GB RAM — two concurrent
// transcodes saturate CPU and a third pushes RAM into OOM territory,
// killing Node and leaving the EB instance unresponsive to SSM
// (which then makes deploys time out). Background jobs queue here:
// the gate releases when the running ffmpeg exits, the next queued
// trigger picks it up. Same-session dedupe via `inProgress` still
// short-circuits before the queue.
let activeWorker: Promise<void> | null = null;
const queue: Array<() => Promise<void>> = [];

function pumpQueue(): void {
  if (activeWorker) return;
  const next = queue.shift();
  if (!next) return;
  activeWorker = next().finally(() => {
    activeWorker = null;
    pumpQueue();
  });
}

function enqueueWorker(fn: () => Promise<void>): void {
  queue.push(fn);
  pumpQueue();
}

/** Derive the downloadable-MP4 key from the source key. The output
 *  is always `.mp4` regardless of source format — that's what the
 *  Download button serves and what plays in WeChat / iOS / etc.
 *
 *  CRITICAL: must NEVER equal the source key. When the source is
 *  already `.mp4` (post-2026 MediaRecorder MP4 era), naively
 *  replacing the extension produces the same key and ffmpeg's
 *  output overwrites the source — fatal if ffmpeg fails (the
 *  Upload commits a 0-byte object and the original recording is
 *  destroyed). For .mp4 inputs we suffix with `.remuxed.mp4` so
 *  source and target are always distinct. */
export function movKeyFor(sourceKey: string): string {
  if (/\.mp4$/i.test(sourceKey)) {
    return sourceKey.replace(/\.mp4$/i, ".remuxed.mp4");
  }
  return sourceKey.replace(/\.[a-z0-9]+$/i, "") + ".mp4";
}

/** Kick off (or no-op if already running / queue if another running)
 *  a background transcode for the given session's source video.
 *  Returns immediately — caller must NOT await this if they want
 *  fire-and-forget semantics.
 *
 *  No-op when:
 *    - ffmpeg binary isn't on the box (logs a warning)
 *    - This sessionId already has a transcode running OR queued in
 *      this process
 */
export function triggerBackgroundTranscode(
  sessionId: string,
  sourceKey: string
): void {
  if (inProgress.has(sessionId)) {
    console.log(
      "[transcode] skipping — already in progress / queued for",
      sessionId
    );
    return;
  }
  if (!existsSync(FFMPEG_BIN)) {
    console.warn(
      "[transcode] ffmpeg binary missing at",
      FFMPEG_BIN,
      "— skipping background transcode"
    );
    return;
  }
  inProgress.add(sessionId);
  enqueueWorker(() =>
    runTranscode(sessionId, sourceKey).finally(() => {
      inProgress.delete(sessionId);
    })
  );
}

/** Concatenate multi-segment recordings into a single canonical
 *  MP4 using ffmpeg's concat demuxer with `-c copy` (no re-encoding).
 *
 *  Why this exists: a live session can be paused and resumed multiple
 *  times. Each pause tears the MediaRecorder down so the mic indicator
 *  + screen-share badge actually go off; on resume a fresh recorder
 *  starts. Each recorder run produces an independent fragmented MP4
 *  with its own ftyp+moov boxes, so naively concatenating their bytes
 *  into a single Blob produces an invalid MP4 (demuxers reject it
 *  with MediaError code 4). We upload each segment as its own S3
 *  object and stitch them here.
 *
 *  `-c copy` does NOT re-encode — it just rewrites the container,
 *  remapping samples from the input streams into a single output.
 *  Typical 5-min recording (3 segments) takes 1-3s of ffmpeg time
 *  on a t3.small. The dominating cost is S3 download + upload, not
 *  CPU — total wall time 3-7s, well under the 10s budget.
 *
 *  Concurrency: shares the same global gate as runTranscode so two
 *  concurrent end-session events can't saturate the box.
 *
 *  Returns the canonical key on success, null on failure. Caller
 *  (the /api/uploads/concat route) decides what to do with null —
 *  typically returns 500 so the client knows the recording isn't
 *  available yet. */
export async function concatSegmentsToCanonical(args: {
  userId: string;
  sessionId: string;
  segmentKeys: string[];
  /** Container MIME for ContentType on the final S3 object. We always
   *  output mp4; the input format is detected from segment keys. */
  outputMime?: string;
}): Promise<string | null> {
  if (!existsSync(FFMPEG_BIN)) {
    console.warn(
      "[concat] ffmpeg binary missing at",
      FFMPEG_BIN,
      "— cannot concat segments"
    );
    return null;
  }
  if (args.segmentKeys.length === 0) return null;

  // Run inside the global concurrency gate so we don't double up
  // with a background WebM transcode running on the same instance.
  return new Promise<string | null>((resolve) => {
    enqueueWorker(async () => {
      const result = await runConcat(args);
      resolve(result);
    });
  });
}

async function runConcat(args: {
  userId: string;
  sessionId: string;
  segmentKeys: string[];
  outputMime?: string;
}): Promise<string | null> {
  const t0 = Date.now();
  const { userId, sessionId, segmentKeys } = args;

  // Output goes to the CANONICAL key (no .{i} suffix). Always .mp4
  // — that's what PastView's playback + Download flows look up.
  const canonicalKey = `users/${userId}/sessions/${sessionId}/video.mp4`;

  // Stage segments to a per-session tmp directory. Cleanup in finally.
  const stagingDir = pathJoin(STAGING_ROOT, `ic-concat-${sessionId}`);
  const localSegmentPaths: string[] = [];
  let outputPath = "";
  try {
    await fsp.mkdir(stagingDir, { recursive: true });

    // 1) Parallel-download each segment to local disk. Streaming
    //    instead of buffering keeps RAM low for large recordings.
    await Promise.all(
      segmentKeys.map(async (key, i) => {
        const local = pathJoin(stagingDir, `seg-${i}.mp4`);
        localSegmentPaths.push(local);
        const r = await getS3().send(
          new GetObjectCommand({ Bucket: RECORDINGS_BUCKET, Key: key })
        );
        const body = r.Body as Readable | undefined;
        if (!body) throw new Error(`empty body for ${key}`);
        const fh = await fsp.open(local, "w");
        const w = fh.createWriteStream();
        await new Promise<void>((res, rej) => {
          body.on("error", rej);
          w.on("error", rej);
          w.on("finish", () => res());
          body.pipe(w);
        });
        await fh.close();
      })
    );

    // 2) Write the concat-demuxer manifest. The list file format is:
    //    `file 'absolute-path.mp4'` per line. Single-quoted to
    //    survive any (unlikely) special chars in the temp path.
    const listPath = pathJoin(stagingDir, "list.txt");
    const listBody = localSegmentPaths
      .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
      .join("\n");
    await fsp.writeFile(listPath, listBody, "utf8");

    // 3) ffmpeg concat with `-c copy`. -safe 0 lets us reference
    //    absolute paths (default 1 only allows relative). +faststart
    //    moves the moov atom to the front for instant playback.
    outputPath = pathJoin(stagingDir, "out.mp4");
    const ffArgs = [
      "-loglevel", "error",
      "-f", "concat",
      "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      "-movflags", "+faststart",
      outputPath,
    ];
    await new Promise<void>((res, rej) => {
      const ff = spawn(FFMPEG_BIN, ffArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderrTail = "";
      ff.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });
      ff.on("close", (code) => {
        if (code === 0) res();
        else
          rej(
            new Error(
              `ffmpeg concat exited ${code}; stderr: ${stderrTail.slice(-500)}`
            )
          );
      });
    });

    // 4) Upload the final MP4 to S3 under the canonical key.
    const finalStream = createReadStream(outputPath);
    const upload = new Upload({
      client: getS3(),
      params: {
        Bucket: RECORDINGS_BUCKET,
        Key: canonicalKey,
        Body: finalStream,
        ContentType: "video/mp4",
      },
      queueSize: 2,
      partSize: 5 * 1024 * 1024,
    });
    await upload.done();

    // 5) Update the DB so PastView can sign GET URLs against the
    //    canonical key. Don't gate by user_id — the API route
    //    already verified ownership.
    await query(
      `UPDATE sessions SET video_s3_key = $1 WHERE id = $2`,
      [canonicalKey, sessionId]
    );

    // 6) Best-effort delete the segment objects. They're now redundant.
    //    Failure here is non-fatal — orphan segments cost a few cents
    //    until a GC sweep cleans them up later.
    await Promise.all(
      segmentKeys.map((k) =>
        getS3()
          .send(
            new DeleteObjectCommand({ Bucket: RECORDINGS_BUCKET, Key: k })
          )
          .catch((e) =>
            console.warn("[concat] segment delete failed", { key: k, e })
          )
      )
    );

    console.log("[concat] done", {
      sessionId,
      segments: segmentKeys.length,
      canonicalKey,
      elapsedMs: Date.now() - t0,
    });
    return canonicalKey;
  } catch (e) {
    console.warn("[concat] failed", {
      sessionId,
      segmentKeys,
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
    });
    return null;
  } finally {
    // Best-effort cleanup of the staging dir.
    try {
      await fsp.rm(stagingDir, { recursive: true, force: true });
    } catch (e) {
      console.warn("[concat] staging cleanup failed", e);
    }
  }
}

async function runTranscode(
  sessionId: string,
  sourceKey: string
): Promise<void> {
  const t0 = Date.now();
  const targetKey = movKeyFor(sourceKey);
  // Stage to disk because `-movflags +faststart` requires SEEKABLE
  // output: ffmpeg writes the moov atom at the end of the muxing
  // pass, then SEEKS BACK to the front to copy it there. Writing to
  // stdout (pipe:1) makes the output a non-seekable stream and ffmpeg
  // bails with "muxer does not support non seekable output" (exit
  // 234). Previously we tried to stream stdout → S3 multipart upload,
  // which is RAM-cheap but incompatible with +faststart. Disk path
  // is essential — without it the trigger fires but every transcode
  // dies before producing output. Cleanup in finally{} regardless.
  const stagingDir = pathJoin(STAGING_ROOT, `ic-transcode-${sessionId}`);
  let outputPath = "";
  // Mode is informational now — both .mp4 and .webm sources go
  // through full re-encode (libx264 baseline + AAC). See the ffArgs
  // block below for the rationale.
  const mode = /\.mp4$/i.test(sourceKey) ? "reencode-mp4" : "reencode-webm";
  console.log("[transcode] start", { sessionId, sourceKey, targetKey, mode });

  try {
    await fsp.mkdir(stagingDir, { recursive: true });

    // 1) Stream the source from S3 → local file. Streaming avoids
    //    buffering 600MB+ in RAM on a t3.small. Once the file is
    //    on disk, ffmpeg can SEEK through it freely (required for
    //    -c copy correctness on weird input fMP4 layouts) and the
    //    OUTPUT path is also a seekable file (required for
    //    +faststart to work — the whole point of this rewrite).
    const sourcePath = pathJoin(stagingDir, "source.mp4");
    outputPath = pathJoin(stagingDir, "out.mp4");
    {
      const s3Resp = await getS3().send(
        new GetObjectCommand({ Bucket: RECORDINGS_BUCKET, Key: sourceKey })
      );
      const body = s3Resp.Body as Readable | undefined;
      if (!body) throw new Error("empty source object");
      const fh = await fsp.open(sourcePath, "w");
      const w = fh.createWriteStream();
      await new Promise<void>((res, rej) => {
        body.on("error", rej);
        w.on("error", rej);
        w.on("finish", () => res());
        body.pipe(w);
      });
      await fh.close();
    }

    // 2) Spawn ffmpeg with FILE input + FILE output.
    //
    // BOTH paths are now FULL re-encode (changed 2026-05-07):
    //
    // The previous .mp4 path used `-c copy` (just remux container) on
    // the assumption that MediaRecorder's H.264 + AAC streams would be
    // iOS-Safari-compatible as-is. That assumption broke in production:
    // even with non-fragmented MP4 + moov-at-front + faststart + brand
    // "isom,iso2,avc1,mp41", iOS Safari and WeChat in-app browser both
    // refused to play with MEDIA_ERR_SRC_NOT_SUPPORTED (code 4), while
    // Chrome / desktop Safari played fine. The clean structural metadata
    // ruled out container issues; remaining suspects are codec-level —
    // in-band SPS/PPS parameter sets, NAL emulation bytes, or non-
    // standard avcC fields that MediaRecorder produces and `-c copy`
    // preserves verbatim.
    //
    // Full re-encode normalizes the bitstream: libx264 emits clean
    // out-of-band SPS/PPS into avcC, no in-band parameter sets, no
    // weird profile extensions. Same for AAC LC encoding. Trade-off:
    // 30s remux → ~2-3 min re-encode on a t3.small for a 57-min
    // recording. Acceptable because (a) it runs in the background
    // after upload, (b) the user only needs to refresh once, and (c)
    // the alternative (recording that doesn't play on phones) is
    // worse than 3 minutes of patience.
    //
    // baseline + 720p cap keeps it compatible with iOS 9+, all
    // Android, every WeChat in-app browser.
    //
    // CRITICAL — the `scale=...` filter caps width at 1280px (Level
    // 3.1 max resolution) and height at 720px, preserving aspect
    // ratio. Without this cap the screen-capture source can come in
    // at non-standard sizes like 1806x1014 (a browser tab's content
    // area), which exceeds Level 3.1's macroblock limit (3600). When
    // we asked libx264 to claim `-level 3.1` on a 1806x1014 input,
    // the SPS wrote Level 3.1 but the actual content was Level 4.0+
    // territory — iOS Safari parses the SPS, sees the
    // resolution/level mismatch, and rejects with
    // MEDIA_ERR_SRC_NOT_SUPPORTED. The screen-capture macro that
    // probably caused this (showing a tab's full content rendered
    // area at native pixel ratio) produces dimensions like
    // 1806x1014, 1920x946, etc — all over Level 3.1 limits.
    //
    // `force_original_aspect_ratio=decrease` shrinks the frame to
    // FIT inside 1280x720 without distorting (one dim hits the cap,
    // the other is smaller). `trunc(iw/2)*2` ensures even dimensions
    // (libx264 + yuv420p require divisible-by-2). The downscale also
    // shrinks file size by ~40-60% which is welcome.
    //
    // -preset veryfast is the sweet spot: ultrafast cuts
    // compatibility (some devices lose B-frames), faster/medium
    // triple wall time. yuv420p is the universal pixel format;
    // 4:2:2 or 4:4:4 break iOS playback.
    const ffArgs = [
      "-loglevel", "error",
      "-i", sourcePath,
      "-vf",
      "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264",
      "-profile:v", "baseline",
      "-level", "3.1",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-f", "mp4",
      outputPath,
    ];
    const ff = spawn(FFMPEG_BIN, ffArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Capture stderr tail for diagnostics.
    let stderrTail = "";
    ff.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });

    // 3) Wait for ffmpeg to finish. If it exits non-zero, the output
    //    file is incomplete/junk; bail without uploading.
    const ffCode = await new Promise<number>((resolve) => {
      ff.on("close", (code) => resolve(code ?? -1));
    });
    if (ffCode !== 0) {
      throw new Error(
        `ffmpeg exited ${ffCode}; stderr tail: ${stderrTail.slice(-500)}`
      );
    }

    // 4) Stream the local output → S3. Multipart upload still — the
    //    file can be 100s of MB, the Upload helper handles parts.
    const finalStream = createReadStream(outputPath);
    const upload = new Upload({
      client: getS3(),
      params: {
        Bucket: RECORDINGS_BUCKET,
        Key: targetKey,
        Body: finalStream,
        ContentType: "video/mp4",
      },
      queueSize: 2,
      partSize: 5 * 1024 * 1024,
    });
    await upload.done();

    // 5) Patch the session row so the Download / Share / Past Session
    //    paths can take the fast (mobile-compatible) path. Don't gate
    //    on user_id here — caller already verified ownership before
    //    triggering, or it's the public share endpoint where the
    //    token is the auth.
    await query(
      `UPDATE sessions SET video_mov_s3_key = $1 WHERE id = $2`,
      [targetKey, sessionId]
    );

    console.log("[transcode] done", {
      sessionId,
      targetKey,
      mode,
      elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    console.warn("[transcode] failed", {
      sessionId,
      sourceKey,
      mode,
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
    });
  } finally {
    // Best-effort cleanup of the staging dir. Important on a t3.small
    // — leaving 600MB+ files in /var/tmp would fill the EBS volume
    // over a few sessions.
    try {
      await fsp.rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      console.warn("[transcode] staging cleanup failed", cleanupErr);
    }
  }
}
