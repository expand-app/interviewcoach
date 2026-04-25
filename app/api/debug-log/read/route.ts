import { NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

/**
 * Serve the current session's debug log for the Live Debug Panel to
 * render in real-time. Returns the raw text content + the file's mtime
 * so the client can skip re-rendering when nothing has changed.
 *
 * This is dev infrastructure — no caching, no auth. In production the
 * /debug-logs/ directory won't exist (gitignored) and this returns an
 * empty string, so shipping it accidentally is harmless.
 */
export async function GET() {
  const LOG = path.join(process.cwd(), "debug-logs", "latest.log");
  try {
    const [content, s] = await Promise.all([
      readFile(LOG, "utf8"),
      stat(LOG),
    ]);
    return NextResponse.json({
      content,
      mtime: s.mtimeMs,
      size: s.size,
    });
  } catch {
    return NextResponse.json({ content: "", mtime: 0, size: 0 });
  }
}
