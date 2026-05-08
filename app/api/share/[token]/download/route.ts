import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { signGetUrl } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * GET /api/share/[token]/download?kind=video|audio&filename=...
 *
 * Public, token-authenticated download endpoint. The token IS the
 * auth — same shape as /api/share/[token] (the JSON viewer endpoint),
 * but signs the recording's S3 key with `Content-Disposition:
 * attachment; filename="..."` so the browser saves the file instead
 * of streaming it inline.
 *
 * Returns { url } that the client navigates to; the URL itself
 * carries the disposition header in its query, which S3 echoes back
 * on the response. This pattern works around the cross-origin
 * `<a download>` restriction (Chrome ignores `download` attr on
 * cross-origin links unless the response includes a matching
 * Content-Disposition header).
 *
 * Status codes:
 *   200 — { url } returned
 *   404 — token doesn't exist, or the requested recording kind has no
 *         S3 key yet (e.g. a session with no video)
 *   410 — token was revoked
 *   400 — invalid kind / token shape
 *
 * Used by the public viewer page at /share/[token]. The owner-side
 * Past Session view uses the authenticated /api/uploads/get flow
 * instead since it already has x-user-id from the signed-in session.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ token: string }> }
) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured." },
      { status: 503 }
    );
  }

  const { token } = await ctx.params;
  const cleanToken = token?.trim();
  if (!cleanToken || !/^share-[A-Za-z0-9_-]{20,128}$/.test(cleanToken)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const kind = searchParams.get("kind") || "video";
  if (kind !== "video" && kind !== "audio") {
    return NextResponse.json(
      { error: "kind must be 'video' or 'audio'" },
      { status: 400 }
    );
  }

  // Optional client-supplied filename. Sanitize to a tame ASCII subset
  // before passing to signGetUrl — S3 quotes the value but we don't
  // want a hostile name like `..\..\..\file.mov` even surfacing in
  // a Content-Disposition header. Defaults are derived below if the
  // client doesn't supply one.
  const rawFilename = searchParams.get("filename") || "";
  const safeFilename = rawFilename
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/[\x00-\x1f]+/g, "")
    .slice(0, 200)
    .trim();

  try {
    const r = await query<{
      revoked_at: Date | null;
      audio_s3_key: string | null;
      video_s3_key: string | null;
      video_mov_s3_key: string | null;
      title: string;
      session_id: string;
    }>(
      `SELECT
         sh.revoked_at,
         s.audio_s3_key, s.video_s3_key, s.video_mov_s3_key, s.title,
         s.id AS session_id
       FROM session_shares sh
       JOIN sessions s ON s.id = sh.session_id
       WHERE sh.token = $1`,
      [cleanToken]
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const row = r.rows[0];
    if (row.revoked_at !== null) {
      return NextResponse.json(
        { error: "This share has been revoked." },
        { status: 410 }
      );
    }

    // Prefer the transcoded MOV for video — H.264/AAC plays everywhere
    // and matches the format the JSON endpoint serves. Fall back to
    // the original raw recording (mp4/webm) when no MOV exists yet.
    const key =
      kind === "audio"
        ? row.audio_s3_key
        : row.video_mov_s3_key || row.video_s3_key;
    if (!key) {
      return NextResponse.json(
        { error: `No ${kind} recording for this session.` },
        { status: 404 }
      );
    }

    // Default filename when the client didn't supply one. Embeds the
    // session title + today's date so the user's Downloads folder
    // doesn't fill up with anonymous "recording.mp4"s.
    const ext = (key.match(/\.([a-z0-9]{2,5})$/i)?.[1] || "mp4").toLowerCase();
    const stamp = new Date().toISOString().slice(0, 10);
    const fallbackFilename = `${(row.title || "interview-recording")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80)} — ${stamp}.${ext}`;
    const filename = safeFilename || fallbackFilename;

    const url = await signGetUrl(key, filename);
    return NextResponse.json({ url });
  } catch (e) {
    console.error("[/api/share/:token/download] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
