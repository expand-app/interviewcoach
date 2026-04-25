/**
 * Server-side append-only debug log for the current test session.
 *
 * Purpose: when the user hits a bug during a live test and says
 * "at 02:34 the commentary didn't appear", I can grep the log for
 * events around that timestamp and see exactly what happened —
 * utterances received, state transitions, API calls fired,
 * responses, errors. No console-digging needed.
 *
 * File layout: ./debug-logs/latest.log — one line per event, relative
 * mm:ss.mmm from session start.
 *
 * Session start triggers a reset (via /api/debug-log with reset:true),
 * which rotates the previous session to ./debug-logs/prev.log so one
 * historical session is always retrievable.
 *
 * This is dev infrastructure; never called from production code paths
 * that matter. Failures to write are swallowed — the log shouldn't
 * ever break a live session.
 */

import { appendFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "debug-logs");
const LATEST = path.join(LOG_DIR, "latest.log");
const PREV = path.join(LOG_DIR, "prev.log");

// Session start wall-clock. Set on reset, re-synced defensively if the
// first log arrives before a reset (e.g. dev-server auto-instrumented).
let sessionStartMs: number | null = null;

async function ensureDir(): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

/**
 * Reset the log: rotate latest → prev, start fresh. Called via the
 * /api/debug-log endpoint with `{reset: true}` when a new session
 * begins so the log lines up with the session's mm:ss clock the user
 * reads in the UI.
 */
export async function resetLog(): Promise<void> {
  sessionStartMs = Date.now();
  await ensureDir();
  // Rotate if latest.log exists and has content.
  try {
    const s = await stat(LATEST);
    if (s.size > 0) {
      try {
        await rename(LATEST, PREV);
      } catch {
        /* ignore — e.g. prev is locked on Windows */
      }
    }
  } catch {
    /* latest.log doesn't exist yet */
  }
  const header =
    `# Interview Coach debug log · session ${new Date().toISOString()}\n` +
    `# format: mm:ss.mmm  [source]  event  data\n`;
  try {
    await writeFile(LATEST, header, "utf8");
  } catch {
    /* ignore */
  }
}

function fmt(ms: number): string {
  const total = Math.max(0, ms);
  const mm = Math.floor(total / 60000)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor((total % 60000) / 1000)
    .toString()
    .padStart(2, "0");
  const msPart = Math.floor(total % 1000)
    .toString()
    .padStart(3, "0");
  return `${mm}:${ss}.${msPart}`;
}

/**
 * Append one event to the log.
 *
 * @param source  short category tag — "session" / "utterance" / "classify"
 *                / "commentary" / "listen-hint" / "roles" / "api" / "error"
 * @param event   short action name — "start" / "delta" / "done" / "error"
 *                etc. Kept to 10 chars so the file lines up nicely.
 * @param data    optional small payload. Stringified, truncated to 400
 *                chars. Don't pass big transcripts here — use previews.
 * @param explicitTSec  when set, overrides the session-elapsed clock
 *                (e.g. client passes its own live.elapsedSeconds so the
 *                log matches the UI's displayed time exactly).
 */
export async function logEvent(
  source: string,
  event: string,
  data?: unknown,
  explicitTSec?: number
): Promise<void> {
  await ensureDir();
  if (sessionStartMs === null) sessionStartMs = Date.now();
  const ms =
    explicitTSec !== undefined
      ? Math.round(explicitTSec * 1000)
      : Date.now() - sessionStartMs;
  const time = fmt(ms);
  const src = source.padEnd(12).slice(0, 12);
  const ev = event.padEnd(10).slice(0, 10);
  let tail = "";
  if (data !== undefined) {
    const raw =
      typeof data === "string" ? data : safeStringify(data);
    tail = "  " + raw.replace(/\s+/g, " ").slice(0, 400);
  }
  const line = `${time}  [${src}]  ${ev}${tail}\n`;
  try {
    await appendFile(LATEST, line, "utf8");
  } catch {
    /* ignore */
  }
}

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}
