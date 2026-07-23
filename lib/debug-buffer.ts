/**
 * Client-side ring buffer for the session debug log.
 *
 * Replaces the file-based logging the original lib/debug-log.ts used:
 * every event the orchestrator / API layer emits via logClient() now
 * lands in this in-memory buffer. The LiveDebugPanel subscribes to
 * the buffer and re-renders on push; on endLive the buffer is
 * snapshotted and shipped to /api/sessions as the events array,
 * landing in the session_events table.
 *
 * Why not in zustand: events fire 100s of times per session.
 * Subscribers in zustand re-render every component selecting a
 * different slice on each push (zustand's selector eq is shallow,
 * which catches that, but we don't want to leak hot-path mutation
 * into the global store anyway). Module-scope buffer + an explicit
 * subscriber list keeps the cost local to the panel.
 */

export interface DebugEvent {
  /** Milliseconds from session start (matches the live UI clock). */
  atMs: number;
  /** Short category tag, e.g. "session" / "utterance" / "classify". */
  source: string;
  /** Short action tag, e.g. "start" / "delta" / "done". */
  event: string;
  /** Optional small payload. May be any JSON-serializable shape. */
  data?: unknown;
}

const MAX_EVENTS = 50_000;
let events: DebugEvent[] = [];
let sessionStartMs: number | null = null;
let resetSeq = 0;
/** Bumped on every push AND every reset. Used as the snapshot value
 *  by useSyncExternalStore — a primitive number whose identity
 *  changes is enough to trigger a re-render. We can't return the
 *  events array as the snapshot itself: pushDebugEvent mutates it
 *  in place, so the array reference stays stable across pushes and
 *  React's Object.is comparison says "nothing changed", silently
 *  skipping every re-render. (That was the Phase 2 bug: events
 *  flowed into the buffer but the panel never updated until the
 *  next reset bumped resetSeq.) */
let eventsVersion = 0;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      /* never let one subscriber kill the rest */
    }
  }
}

/** Append one event. `tSec` overrides the session-elapsed clock when
 *  provided (the orchestrator passes its own elapsed for parity with
 *  the UI clock). Truncates oldest entries when the cap is hit. */
export function pushDebugEvent(
  source: string,
  event: string,
  data?: unknown,
  tSec?: number
): void {
  if (sessionStartMs === null) sessionStartMs = Date.now();
  const atMs =
    tSec !== undefined
      ? Math.max(0, Math.round(tSec * 1000))
      : Math.max(0, Date.now() - sessionStartMs);
  events.push({ atMs, source, event, data });
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  eventsVersion++;
  notify();
}

/** Wipe the buffer for a fresh session. Bumps `resetSeq` so panels
 *  can detect a session boundary and clear their per-session UI
 *  state (user comments, scroll position) without comparing arrays. */
export function resetDebugBuffer(): void {
  events = [];
  sessionStartMs = Date.now();
  resetSeq++;
  eventsVersion++;
  notify();
}

export function getDebugEvents(): readonly DebugEvent[] {
  return events;
}

export function getResetSeq(): number {
  return resetSeq;
}

/** Snapshot for useSyncExternalStore. Returns a primitive whose
 *  identity changes on every push/reset; the React component then
 *  reads `getDebugEvents()` directly to get the (mutable) buffer. */
export function getEventsVersion(): number {
  return eventsVersion;
}

/** Drain a copy of the buffer at end-of-session for shipping to the
 *  server. Doesn't clear the buffer — that happens at the NEXT
 *  session's resetDebugBuffer() call. */
export function snapshotDebugEvents(): DebugEvent[] {
  return events.slice();
}

export function subscribeDebugEvents(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
