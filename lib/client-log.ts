/**
 * Client-side debug-log helper. Thin wrapper around lib/debug-buffer.
 *
 * Older revisions POSTed every event to /api/debug-log which appended
 * to a file under debug-logs/. The file path doesn't survive
 * production deploys (one EB instance, restarts wipe local state,
 * past sessions need their own log). Phase 2 moved logging into a
 * client-side ring buffer that ships with the session POST at
 * endLive — see lib/debug-buffer.ts.
 *
 * Existing call sites (orchestrator.ts, app/app/page.tsx) keep using
 * logClient(...) and resetClientLog() unchanged; only the
 * implementation moved.
 */

import { useStore } from "./store";
import { pushDebugEvent, resetDebugBuffer } from "./debug-buffer";

/** Append one event to the in-memory session log. */
export function logClient(
  source: string,
  event: string,
  data?: unknown
): void {
  let tSec: number | undefined;
  try {
    tSec = useStore.getState().live.elapsedSeconds;
  } catch {
    /* store not mounted yet — buffer falls back to wall clock */
  }
  pushDebugEvent(source, event, data, tSec);
}

/** Wipe the buffer at the start of a new session so timestamps line
 *  up with the UI's mm:ss clock. */
export function resetClientLog(): void {
  resetDebugBuffer();
  pushDebugEvent("session", "reset");
}
