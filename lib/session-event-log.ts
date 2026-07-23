/**
 * Server-side session_events writer. Used by the post-session
 * pipeline (expand-suggestions, future score-session, transcoding,
 * etc.) to leave a breadcrumb trail in the same `session_events`
 * table the client uses for live diagnostics.
 *
 * Why a dedicated helper: the client-side debug-buffer goes through
 * a batch INSERT inside POST /api/sessions; server-side code can't
 * reuse that path because there's no Session payload to attach to.
 * This helper writes single rows directly with a fire-and-forget
 * `void` return — callers don't await and don't surface failures
 * to the user (event logging shouldn't ever break the actual work).
 *
 * The `at_ms` column on session_events is normally "ms since session
 * start" for client-side events. For server-side post-session events
 * we use a NEGATIVE convention: the value is `-(ms-since-end)` so
 * post-session events sort AFTER the natural session timeline when
 * ordered ASC by at_ms — actually we use a high positive offset
 * instead since negatives confuse the existing GET /events path.
 *
 * Convention adopted: post-session events use at_ms = sessionDurationMs
 * + (ms-since-end). I.e. they tail naturally onto the existing
 * client-side stream. For brevity (and since some callers don't know
 * the duration), accepting a wall-clock at_ms is fine — the order
 * within the post-session stream still reflects insertion order.
 */

import { isDbConfigured, query } from "./db";

interface EventInput {
  source: string;
  event: string;
  data?: unknown;
}

/** Insert ONE event for a session. Fire-and-forget — failures are
 *  swallowed and logged to console.warn so a transient DB hiccup
 *  doesn't break the work the event was logging.
 *
 *  atMs defaults to Date.now() when not supplied; this is fine for
 *  post-session events where chronological order within the
 *  post-session stream is what matters, not "ms since session start".
 *  When the caller has a proper offset (e.g. ms-since-session-start
 *  for live events), pass it explicitly. */
export function logSessionEvent(
  sessionId: string,
  input: EventInput,
  atMs?: number
): void {
  if (!isDbConfigured()) return;
  const ms = atMs ?? Date.now();
  void (async () => {
    try {
      await query(
        `INSERT INTO session_events (session_id, at_ms, source, event, data)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          sessionId,
          ms,
          input.source,
          input.event,
          input.data === undefined ? null : JSON.stringify(input.data),
        ]
      );
    } catch (e) {
      console.warn("[session-event-log] insert failed:", {
        sessionId,
        source: input.source,
        event: input.event,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
}

/** Batched variant — useful when emitting multiple events in quick
 *  succession (e.g. one per item in a fan-out). Single round-trip
 *  with a multi-row VALUES clause. Same fire-and-forget semantics. */
export function logSessionEvents(
  sessionId: string,
  events: Array<EventInput & { atMs?: number }>
): void {
  if (!isDbConfigured() || events.length === 0) return;
  void (async () => {
    try {
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      const now = Date.now();
      for (const e of events) {
        const i = params.length;
        valuesSql.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5})`);
        params.push(
          sessionId,
          e.atMs ?? now,
          e.source,
          e.event,
          e.data === undefined ? null : JSON.stringify(e.data)
        );
      }
      await query(
        `INSERT INTO session_events (session_id, at_ms, source, event, data)
         VALUES ${valuesSql.join(",")}`,
        params
      );
    } catch (e) {
      console.warn("[session-event-log] batch insert failed:", {
        sessionId,
        count: events.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();
}
