import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/utterances
 *
 * Returns the full utterance log for a saved session. PastView's
 * Review Panel hits this on mount to render the captions stream the
 * live session showed. Server-side ownership check via x-user-id +
 * a JOIN to sessions.user_id.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!isDbConfigured()) {
    return NextResponse.json({ utterances: [] });
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const { id } = await ctx.params;

  const r = await query<{
    id: string;
    dg_speaker: number | null;
    text: string;
    at_seconds: number;
    duration: number | null;
  }>(
    `SELECT u.id, u.dg_speaker, u.text, u.at_seconds, u.duration
     FROM utterances u
     JOIN sessions s ON s.id = u.session_id
     WHERE u.session_id = $1 AND s.user_id = $2
     ORDER BY u.position`,
    [id, userId]
  );

  return NextResponse.json({
    utterances: r.rows.map((u) => ({
      id: u.id,
      dgSpeaker: u.dg_speaker ?? undefined,
      text: u.text,
      atSeconds: u.at_seconds,
      duration: u.duration ?? undefined,
    })),
  });
}
