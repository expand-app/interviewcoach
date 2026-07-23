import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";
import { logSessionEvent } from "@/lib/session-event-log";

export const runtime = "nodejs";

/**
 * POST /api/sessions/:id/log-event
 *
 * Single-event writer the client uses to emit post-session diagnostic
 * breadcrumbs (most importantly: video upload phases — segment-attempt /
 * segment-success / segment-failed / complete). The end-of-session
 * batch insert in POST /api/sessions only covers events captured
 * BEFORE the session row was saved; uploads happen AFTER, and there's
 * no other write path that lets the client tag a single event onto
 * the session timeline.
 *
 * Auth: same `x-user-id` ownership check as the rest of the
 * /api/sessions/:id surface — only the session's owner can append
 * events to it. Admin endpoints don't need this; admins can write
 * directly via SQL or the analytics endpoints.
 *
 * Body: { source: string, event: string, data?: object, atMs?: number }
 *   - source / event: free-form short identifiers (e.g. "upload" /
 *     "segment-success"). Mirrors the same convention the live debug
 *     buffer uses.
 *   - data: optional JSON-serializable payload. Stored as JSONB.
 *   - atMs: optional millisecond offset. Defaults to Date.now() —
 *     post-session events use wall-clock since they don't have a
 *     "session start" reference.
 *
 * Response: 200 { ok: true } on success. Failure to log is NEVER
 * surfaced as a 5xx because event logging is fire-and-forget — a
 * transient DB hiccup shouldn't break the upload flow it's
 * instrumenting. Logs to console.warn for server-side visibility.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!isDbConfigured()) {
    return NextResponse.json({ ok: true, skipped: "no-db" });
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const { id } = await ctx.params;
  const sessionId = id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  // Ownership check — same shape as GET /api/sessions/:id/events.
  // No event without proof the session belongs to the caller.
  try {
    const r = await query<{ user_id: string }>(
      `SELECT user_id FROM sessions WHERE id = $1`,
      [sessionId]
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (r.rows[0].user_id !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } catch (e) {
    console.warn("[/api/sessions/:id/log-event] ownership check failed:", e);
    return NextResponse.json({ ok: true, skipped: "ownership-check-error" });
  }

  let body: {
    source?: string;
    event?: string;
    data?: unknown;
    atMs?: number;
  } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const source = (body.source || "").trim();
  const event = (body.event || "").trim();
  if (!source || !event) {
    return NextResponse.json(
      { error: "source and event required" },
      { status: 400 }
    );
  }

  // Fire-and-forget. The helper itself swallows DB errors and logs
  // to console.warn. We return ok immediately — the client doesn't
  // need confirmation that the row landed.
  logSessionEvent(
    sessionId,
    { source, event, data: body.data },
    typeof body.atMs === "number" ? body.atMs : undefined
  );
  return NextResponse.json({ ok: true });
}
