import { NextResponse } from "next/server";
import { logEvent, resetLog } from "@/lib/debug-log";

export const runtime = "nodejs";

/**
 * Client → server pipe for the session debug log.
 *
 * POST body:
 *   { reset: true }                              → rotate latest.log → prev.log,
 *                                                   start a fresh session log.
 *   { source, event, data?, tSec? }              → append one event. `tSec` is
 *                                                   the UI's elapsed-session
 *                                                   time so the log matches the
 *                                                   clock the user reads.
 *
 * Always returns {ok:true} — logging failures don't propagate to the
 * UI. See lib/debug-log.ts for the file layout and grep-ability.
 */
interface Body {
  tSec?: number;
  source?: string;
  event?: string;
  data?: unknown;
  reset?: boolean;
}

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* tolerate empty / malformed */
  }
  if (body.reset) await resetLog();
  if (body.source && body.event) {
    await logEvent(body.source, body.event, body.data, body.tSec);
  }
  return NextResponse.json({ ok: true });
}
