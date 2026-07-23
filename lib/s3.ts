/**
 * Thin wrapper around the AWS S3 SDK for the recordings bucket.
 *
 * Used by the upload sign / get routes. Credentials come from the
 * EC2 instance metadata service when running on EB (the
 * aws-elasticbeanstalk-ec2-role instance profile carries
 * PuebuloRecordingsAccess); locally without AWS_* env set, the SDK
 * falls back to ~/.aws/credentials so dev runs still work if the
 * developer is logged in.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const RECORDINGS_BUCKET =
  process.env.RECORDINGS_BUCKET || "puebulo-recordings-625719641746";

export const RECORDINGS_REGION = process.env.AWS_REGION || "us-east-1";

let client: S3Client | null = null;
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({ region: RECORDINGS_REGION });
  }
  return client;
}

/** Build the canonical S3 key for a session asset. Keeps recordings
 *  scoped under user/session prefixes so deleting a user (or session)
 *  is a clean prefix wipe later.
 *
 *  When `segmentIndex` is provided, the key carries a `.{i}` suffix
 *  before the extension — e.g. `video.0.mp4`, `video.1.mp4`. Used by
 *  the multi-segment upload path: each pause/resume cycle in a live
 *  session produced its own MediaRecorder run with its own ftyp+moov
 *  boxes, and we keep them as separate objects until the server
 *  ffmpeg-concats them with `-c copy` into the canonical
 *  `{kind}.{ext}` key.
 *
 *  The canonical key (no segmentIndex) is what PastView's playback /
 *  download path looks up. Segment keys are intermediate. */
export function recordingKey(
  userId: string,
  sessionId: string,
  kind: "audio" | "video",
  ext: string,
  segmentIndex?: number
): string {
  // Strip leading dot if caller passed ".webm" instead of "webm".
  const cleanExt = ext.replace(/^\./, "").toLowerCase();
  const suffix =
    typeof segmentIndex === "number" ? `.${segmentIndex}` : "";
  return `users/${userId}/sessions/${sessionId}/${kind}${suffix}.${cleanExt}`;
}

/** Sign a PUT URL the browser uses to upload directly to S3.
 *  TTL: 1h so a slow upload over a poor connection still completes. */
export async function signPutUrl(
  key: string,
  contentType: string
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: RECORDINGS_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(getClient(), cmd, { expiresIn: 3600 });
}

/** Sign a GET URL for the recording.
 *
 *  When `downloadFilename` is provided, S3 will respond with
 *  `Content-Disposition: attachment; filename="..."`, which forces
 *  the browser to download the file instead of opening it inline.
 *  This is critical for the Download button — without the header,
 *  browsers ignore the `<a download>` attribute on cross-origin
 *  links and just play the video in the tab.
 *
 *  Without `downloadFilename`, the URL is suitable for inline
 *  playback in a `<video>` element (no disposition header,
 *  browser plays it as a media stream).
 *
 *  TTL 1h — long enough that a user can scrub the timeline without
 *  re-fetching, short enough that a leaked URL doesn't grant
 *  indefinite access. */
export async function signGetUrl(
  key: string,
  downloadFilename?: string
): Promise<string> {
  // RFC 5987 encoding for the filename* parameter handles non-ASCII
  // characters (Chinese titles, em-dash, etc) reliably across
  // browsers. The unquoted ASCII fallback in the standard `filename`
  // param is for very old clients that don't understand filename*.
  let responseContentDisposition: string | undefined;
  if (downloadFilename) {
    const ascii = downloadFilename.replace(/[^\x20-\x7E]/g, "_");
    const encoded = encodeURIComponent(downloadFilename);
    responseContentDisposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  }
  const cmd = new GetObjectCommand({
    Bucket: RECORDINGS_BUCKET,
    Key: key,
    ResponseContentDisposition: responseContentDisposition,
  });
  return getSignedUrl(getClient(), cmd, { expiresIn: 3600 });
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: RECORDINGS_BUCKET, Key: key })
  );
}
