"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchSessionEvents } from "@/lib/client-api";
import {
  LogLine,
  entriesFromEvents,
  type LogEntry,
} from "./LiveDebugPanel";
import type { DebugEvent } from "@/lib/debug-buffer";

/**
 * Past-session counterpart of LiveDebugPanel.
 *
 * The live panel reads from the in-memory debug-event ring buffer to
 * show what's happening RIGHT NOW. This panel reads the persisted
 * `session_events` rows (via /api/sessions/:id/events) so the user
 * can review the same Review Panel log on any saved session — that's
 * what they're after when they click into a past session and want
 * to see "what went wrong at 02:34 of session X". Phase 2 ships the
 * full event stream alongside the session at endLive, so this is a
 * complete replay of the live panel's content.
 *
 * Read-only: no comments input, no analyze button, no auto-refresh —
 * the saved log is immutable.
 */

interface Props {
  sessionId: string;
}

export function PastDebugPanel({ sessionId }: Props) {
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const evs = await fetchSessionEvents(sessionId);
      if (aborted) return;
      setEvents(evs);
      setLoading(false);
    })().catch((e) => {
      if (aborted) return;
      setError(String(e));
      setLoading(false);
    });
    return () => {
      aborted = true;
    };
  }, [sessionId]);

  const entries: LogEntry[] = useMemo(
    () => entriesFromEvents(events),
    [events]
  );
  // Newest-first: matches the live panel's ordering so the user's eye
  // doesn't have to re-orient between live and past views.
  const reversedEntries = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <div className="h-full flex flex-col border-l border-rule bg-paper-subtle overflow-hidden">
      <div className="px-4 py-3 border-b border-rule flex items-center justify-between shrink-0">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-lighter">
            Session Log
          </div>
          <div className="text-[10px] text-ink-lighter mt-0.5">
            {loading
              ? "loading…"
              : `${entries.length} events · newest first`}
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-[11.5px] leading-relaxed font-mono">
        {error ? (
          <div className="text-ink-lighter italic mt-4 px-1">
            Couldn&apos;t load the log: {error}
          </div>
        ) : loading ? (
          <div className="text-ink-lighter italic mt-4 px-1">Loading…</div>
        ) : reversedEntries.length === 0 ? (
          <div className="text-ink-lighter italic mt-4 px-1">
            No log events recorded for this session.
          </div>
        ) : (
          reversedEntries.map((e) => <LogLine key={e.lineIdx} entry={e} />)
        )}
      </div>
    </div>
  );
}
