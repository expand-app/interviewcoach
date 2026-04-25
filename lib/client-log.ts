/**
 * Client-side debug-log helper.
 *
 * Every call is fire-and-forget: we never await the response, never
 * surface errors, never block the UI. The log is test-only
 * infrastructure — its failure must not break the live session.
 *
 * The `tSec` we pass is the session's elapsed seconds from the live
 * store, which is exactly the clock the user sees in the UI. That way
 * when they tell me "at 2:34 the commentary went blank", the log line
 * timestamp for that event will also be around `02:34` and I can grep
 * directly.
 */

import { useStore } from "./store";

/** Append one event to the session log. Source/event should be short,
 *  consistent tags so I can grep across sessions (e.g. source="classify"
 *  event="request" | "response" | "error"). Data should be a small
 *  object or string — previews only, not full transcripts (the server
 *  truncates long payloads to 400 chars anyway). */
export function logClient(
  source: string,
  event: string,
  data?: unknown
): void {
  let tSec = 0;
  try {
    tSec = useStore.getState().live.elapsedSeconds;
  } catch {
    /* store not mounted yet — fine, server falls back to wall clock */
  }
  const body = JSON.stringify({ tSec, source, event, data });
  // keepalive lets the request complete even if the page is unloading.
  try {
    void fetch("/api/debug-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* swallow */
    });
  } catch {
    /* swallow */
  }
}

/** Rotate latest.log → prev.log and start a fresh session log.
 *  Called at the very start of a new interview session so the log's
 *  mm:ss clock matches the UI clock the user reads during the test. */
export function resetClientLog(): void {
  try {
    void fetch("/api/debug-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reset: true,
        source: "session",
        event: "reset",
      }),
      keepalive: true,
    }).catch(() => {
      /* swallow */
    });
  } catch {
    /* swallow */
  }
}
