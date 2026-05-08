import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/events
 *
 * Returns the full debug-log event stream for a saved session, in
 * chronological order. PastDebugPanel hits this on mount to render
 * the same Review Panel content the LiveDebugPanel showed during
 * the live session.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!isDbConfigured()) {
    return NextResponse.json({ events: [] });
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const r = await query<{
    at_ms: number;
    source: string;
    event: string;
    data: unknown;
  }>(
    `SELECT e.at_ms, e.source, e.event, e.data
     FROM session_events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.session_id = $1 AND s.user_id = $2
     ORDER BY e.at_ms, e.id`,
    [id, userId]
  );

  return NextResponse.json({
    events: r.rows.map((e) => ({
      atMs: e.at_ms,
      source: e.source,
      event: e.event,
      data: e.data ?? undefined,
    })),
  });
}
