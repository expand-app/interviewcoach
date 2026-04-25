"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";

/**
 * Live Debug Panel — right-rail real-time view of the session log.
 *
 * Purpose: during a test run the user watches this panel, notices
 * "at 02:34 commentary didn't appear", adds a comment pinned to that
 * timestamp, then copies a debrief bundle (full log + their comments)
 * to paste back to Claude. Replaces the hunt-and-grep workflow with
 * a direct, in-context annotation loop.
 *
 * Also annotates every event with (a) WHY the system did that thing
 * right then, and (b) which user instruction that logic came from,
 * so the user doesn't need to ask "why did it do that?" — it's right
 * there next to the event.
 *
 * Dev-only infrastructure. Not part of the video frame; lives in its
 * own right rail alongside the main content.
 */

// === Reasoning dictionary ===
// Keyed by "source:event". The `what` line is what this event means
// mechanically; `why` is the rule / threshold / instruction that
// triggered it. Kept terse — the panel is narrow. Missing entries
// fall through to a generic "internal" label.
const REASONING: Record<
  string,
  { what: string; why: string }
> = {
  "session:start": {
    what: "Interview session started. Session clock resets to 00:00.",
    why: "Session lifecycle — triggered by Start button.",
  },
  "session:stop": {
    what: "Session ended. Logs persist as debug-logs/prev.log on next start.",
    why: "Session lifecycle — triggered by End button.",
  },
  "session:reset": {
    what: "Log file rotated. latest.log → prev.log, fresh log started.",
    why: "Keeps one previous session recoverable for post-hoc debugging.",
  },
  "utterance:new": {
    what: "Deepgram returned a finalized utterance (speaker + text).",
    why: "Deepgram streaming: nova-3, diarize=true, language=multi. " +
      "Every utterance enters captions + triggers downstream logic.",
  },
  "roles:prompt": {
    what: "New speaker needs a role tag. Popup surfaces to the user.",
    why: "Your instruction: 'manual speaker identification via popup — " +
      "when any speaker first appears, show a popup for the user to tag.'",
  },
  "roles:manual": {
    what: "User clicked a role in the popup. Commentary/classify gates open.",
    why: "Your instruction: 'use user input as source of truth — " +
      "no AI second-guessing after manual confirmation.'",
  },
  "roles:auto": {
    what: "A new speaker was auto-assigned the OPPOSITE role.",
    why: "Your instruction: 'interviews are two-person — one manual " +
      "tag disambiguates the pair, the other side auto-fills.'",
  },
  "classify:request": {
    what: "classify-moment fired (Opus 4.7) to decide state transitions.",
    why: "Debounced 2s after the last utterance OR when silence timer " +
      "elapses. Gated on rolesConfirmed so we don't classify 'Speaker 1/2' " +
      "garbage.",
  },
  "classify:response": {
    what: "Classifier returned a state + optional new question text.",
    why: "Opus 4.7 interprets the recent dialogue vs. current state. " +
      "questionRelation (new_topic | follow_up | same) decides lead vs. probe.",
  },
  "classify:empty": {
    what: "Classifier returned no state — skipped.",
    why: "Best-effort; next classify trigger will retry.",
  },
  "classify:error": {
    what: "classify-moment request failed.",
    why: "Usually an Anthropic API hiccup. Swallowed; next trigger retries.",
  },
  "moment:transit": {
    what: "Moment state machine changed phase (e.g. interviewer_speaking → question_finalized).",
    why: "Drives the top bar: Warm-up / Lead Question / Probe / Candidate Q&A. " +
      "Your instruction: 'only 3 top-bar phases, show if detected.'",
  },
  "question:lead": {
    what: "Lead Question locked. Top bar shows it as the anchor.",
    why: "Your instruction: '面试环节第一行是 Lead Question, 第二行是 question 本身.' " +
      "Triggered by classifier state=question_finalized + rel=new_topic.",
  },
  "question:probe": {
    what: "Probe Question attached under the current Lead.",
    why: "Your instruction: '当然下面有 Probe Question 也要展示.' " +
      "Triggered by classifier rel=follow_up against existing Lead.",
  },
  "commentary:request": {
    what: "Commentary fired against the current candidate answer.",
    why: "Triggers when candidate accumulates 450+ chars of new answer. " +
      "Prompt: 3-4 sentences / ~70 words / ~150 Chinese chars, fits the " +
      "fixed 204px pane. Your instruction: '不要硬凑字数, 一句 sharp 也行.'",
  },
  "commentary:done": {
    what: "Commentary streamed in. Displayed in the Live Commentary pane.",
    why: "Respects a min-display window so the slot isn't immediately " +
      "reclaimed. Newer commentary during that window is dropped — no queue.",
  },
  "commentary:error": {
    what: "Commentary API failed.",
    why: "Check the Anthropic key + proxy config (lib/anthropic-client.ts " +
      "handles the HTTPS_PROXY edge case).",
  },
  "commentary:api-err": {
    what: "Upstream Anthropic API returned an error mid-stream.",
    why: "Stream continues for other deltas but final commentary is partial.",
  },
  "listen-hint:request": {
    what: "Listening hint fired during an interviewer monologue.",
    why: "Triggers when interviewer speaks 400+ chars without finalizing a " +
      "question. Your instruction: '面试官在讲一大段 helpful 内容的时候, " +
      "在 Live Commentary 里说一下.'",
  },
  "listen-hint:done": {
    what: "Listening hint streamed in. Displayed in the Live Commentary pane.",
    why: "Auto-expires after 6s of no new tokens — your instruction: " +
      "'当语音里一个意思结束了, Live Commentary 不要一直展示.'",
  },
  "listen-hint:error": {
    what: "Listening hint API failed.",
    why: "Same root-cause pool as commentary errors.",
  },
  "listen-hint:api-err": {
    what: "Upstream Anthropic API errored during listening-hint stream.",
    why: "Partial hint text may have been written before error.",
  },
  "filter:L1-pass": {
    what: "Layer 1 (text grounding) passed — proposed Q text matches recent interviewer transcript.",
    why: "Local string check: ≥50% of ≥4-char tokens in the Q must appear in the last 30s of interviewer speech. Filters hallucinated Qs.",
  },
  "filter:L1-fail": {
    what: "Layer 1 (text grounding) failed — proposed Q text not in recent transcript.",
    why: "Classifier likely hallucinated a Q the interviewer never said. Discarded silently, UI unchanged.",
  },
  "filter:pending": {
    what: "Proposed Q entered the validation queue. 3-second continuation gate + parallel confirm now running.",
    why: "Your instruction: 'wrong classification must not reach the UI'. Multi-layer filter stalls commits until agreement.",
  },
  "filter:L2-pass": {
    what: "Layer 2 (second-opinion API) confirmed the Q is really 'done'.",
    why: "A focused prompt verified the proposed Q is coherent, not mid-setup, and actually came from the interviewer.",
  },
  "filter:L2-fail": {
    what: "Layer 2 rejected the Q (still_setting_up / not_a_question).",
    why: "Primary classifier + secondary check disagreed. Safer to discard than commit something both couldn't agree on.",
  },
  "filter:L3-pass": {
    what: "Layer 3 (3s continuation gate) passed — interviewer stayed silent. All layers agree → commit.",
    why: "Real questions are followed by silence while the candidate starts to answer. If the interviewer keeps talking, the Q wasn't actually finalized.",
  },
  "filter:discard": {
    what: "Pending Q discarded before commit.",
    why: "Either Layer 2 rejected, interviewer continued talking within the 3s window, or classifier has since changed its mind. Next classify pass gets another shot.",
  },
  "filter:L0-cached-reject": {
    what: "Q proposal matched a recently-rejected text — skipped without running L1/L2/L3.",
    why: "Classifier repeatedly hallucinates the same non-existent question. The cache remembers every rejection until a Lead actually locks, so we don't burn API budget on repeat hallucinations.",
  },
  "filter:restated-Q": {
    what: "Q proposal dropped as a restatement of the just-committed Q.",
    why: "Within 10s of the last Lead/Probe commit, token-Jaccard similarity ≥0.5 → treated as a reworded duplicate and dropped. Fixes the 'Can you speak a little bit…' → 'Can you speak a bit…' two-commit bug.",
  },
  "hysteresis:pending": {
    what: "A new non-question state transition was proposed — starting the 2-vote counter.",
    why: "Classifier wobbles on ambiguous utterances. Requiring 2 consecutive same-direction votes smooths out single-utterance noise before the UI phase flips. question_finalized bypasses this (its own 4-layer filter handles it).",
  },
  "hysteresis:hold": {
    what: "Pending transition still below the 2-vote threshold — state NOT changed.",
    why: "Previous classify proposed this same new state; need one more agreeing vote before committing. If the classifier flips direction, the counter resets.",
  },
  "filter:ignore-empty-q": {
    what: "question_finalized with empty or <5-char question text — ignored.",
    why: "Classifier sometimes emits state=question_finalized with q=\"\", which is internally inconsistent. We keep the current state and just refresh the summary rather than trusting the inconsistent signal.",
  },
  "roles:auto-dup": {
    what: "A new dg speaker appeared while both roles were already filled — silently merged to candidate.",
    why: "Deepgram diarization occasionally splits one person's voice into two dg IDs. Rather than popup the user again, assume it's a candidate-voice dup (the most common case) and keep the session flowing.",
  },
  "commentary:net-err": {
    what: "Commentary stream dropped mid-flight (e.g. ECONNRESET).",
    why: "Retry-once wrapper caught the drop; see attempt count. If retry also fails, the commentary is abandoned for this answer.",
  },
  "listen-hint:net-err": {
    what: "Listening hint stream dropped mid-flight.",
    why: "Retry-once wrapper caught the drop.",
  },
  "warmup-cmt:net-err": {
    what: "Warm-up commentary stream dropped mid-flight.",
    why: "Retry-once wrapper caught the drop.",
  },
  "read-gate:hold-wu": {
    what: "Warm-up commentary held back — previous commentary isn't finished being read.",
    why: "Same reading protection as listening hint. Accumulates new candidate speech in the buffer; fires when it's safe to overwrite the currently-displayed commentary.",
  },
  "warmup-cmt:request": {
    what: "Warm-up commentary fires on candidate's self-introduction.",
    why: "Your instruction: 'warm-up 是一次性环节, 只在最开始'. Gated on no Lead having ever locked this session — once the first Lead commits we never re-enter warm-up, even if the current Lead is archived mid-session.",
  },
  "warmup-cmt:done": {
    what: "Warm-up commentary streamed in.",
    why: "Coaches on how the candidate is presenting in the intro, cross-checked against what the interviewer revealed in their opening.",
  },
  "warmup-cmt:error": {
    what: "Warm-up commentary API call failed.",
    why: "Anthropic API or network hiccup. Swallowed; next candidate utterance may re-trigger.",
  },
};

// Parse one log line into a structured entry. Returns null for header
// lines (starting with `#`) and blank lines.
interface LogEntry {
  lineIdx: number;
  raw: string;
  time: string;        // mm:ss.mmm
  tSec: number;        // seconds from session start
  source: string;      // e.g. "commentary"
  event: string;       // e.g. "request"
  data: string;        // everything after the event tag, trimmed
  key: string;         // source:event
}

function parseLine(raw: string, idx: number): LogEntry | null {
  if (!raw.trim() || raw.startsWith("#")) return null;
  // format: "mm:ss.mmm  [source      ]  event       data..."
  const m = raw.match(
    /^(\d{2}):(\d{2})\.(\d{3})\s+\[([^\]]+)\]\s+(\S+)(.*)$/
  );
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const ss = parseInt(m[2], 10);
  const ms = parseInt(m[3], 10);
  const source = m[4].trim();
  const event = m[5].trim();
  const data = (m[6] || "").trim();
  return {
    lineIdx: idx,
    raw,
    time: `${m[1]}:${m[2]}.${m[3]}`,
    tSec: mm * 60 + ss + ms / 1000,
    source,
    event,
    data,
    key: `${source}:${event}`,
  };
}

interface UserComment {
  id: string;
  time: string;   // mm:ss.mmm
  tSec: number;
  text: string;
}

function fmtTime(sec: number): string {
  const total = Math.max(0, sec);
  const mm = Math.floor(total / 60).toString().padStart(2, "0");
  const ss = Math.floor(total % 60).toString().padStart(2, "0");
  const rest = Math.floor((total - Math.floor(total)) * 1000)
    .toString()
    .padStart(3, "0");
  return `${mm}:${ss}.${rest}`;
}

export function LiveDebugPanel() {
  const elapsedSec = useStore((s) => s.live.elapsedSeconds);

  // Poll the log file. 1.5s is plenty — events are typically seconds
  // apart and this is dev infrastructure, not a production path.
  const [rawLog, setRawLog] = useState<string>("");
  const [mtime, setMtime] = useState<number>(0);
  useEffect(() => {
    let aborted = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/debug-log/read", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          content: string;
          mtime: number;
          size: number;
        };
        if (aborted) return;
        if (data.mtime !== mtime) {
          setRawLog(data.content);
          setMtime(data.mtime);
        }
      } catch {
        /* ignore — log will refresh on next tick */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1500);
    return () => {
      aborted = true;
      clearInterval(id);
    };
  }, [mtime]);

  const entries: LogEntry[] = useMemo(() => {
    const lines = rawLog.split("\n");
    const out: LogEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const e = parseLine(lines[i], i);
      if (e) out.push(e);
    }
    return out;
  }, [rawLog]);

  // Newest-first view of the entries. The user's workflow is "glance
  // at the panel, see what just happened, decide if it's broken" — so
  // the latest event must be visible without scrolling. Scrolling the
  // list only looks BACK in time, never forward, and the comment +
  // copy controls stay pinned at the bottom.
  const reversedEntries = useMemo(
    () => [...entries].reverse(),
    [entries]
  );

  // === User comments ===
  // Stored in local state (session-scoped). Clear on session start by
  // watching for a "session:start" or "session:reset" entry whose
  // tSec < 0.5 — means the log just rotated.
  const [comments, setComments] = useState<UserComment[]>([]);
  const [draft, setDraft] = useState("");
  // Clear comments whenever the log rotates (new session). We detect
  // this by the first entry's key being session:start or session:reset
  // with a very small tSec (<0.5s) and a new mtime — the log just
  // rebooted.
  const lastResetMtimeRef = useRef(0);
  useEffect(() => {
    if (!mtime) return;
    if (mtime === lastResetMtimeRef.current) return;
    const first = entries[0];
    if (
      first &&
      (first.key === "session:reset" || first.key === "session:start") &&
      first.tSec < 0.5
    ) {
      setComments([]);
      lastResetMtimeRef.current = mtime;
    }
  }, [entries, mtime]);

  const addComment = () => {
    const text = draft.trim();
    if (!text) return;
    const id = Math.random().toString(36).slice(2, 10);
    setComments((prev) =>
      [...prev, { id, time: fmtTime(elapsedSec), tSec: elapsedSec, text }].sort(
        (a, b) => a.tSec - b.tSec
      )
    );
    setDraft("");
  };

  const removeComment = (id: string) =>
    setComments((prev) => prev.filter((c) => c.id !== id));

  /** Extract just the utterance events from the parsed log and render
   *  them as a clean chronological transcript. Makes it easy for a
   *  reviewer to correlate events ("classify error at 12:34") with
   *  what was actually being said at that time, without scrolling
   *  through a mixed log. */
  const buildTranscriptSection = (): string => {
    const lines: string[] = [];
    for (const e of entries) {
      if (e.key !== "utterance:new") continue;
      // e.data looks like: {"dg":0,"role":"interviewer","text":"..."}
      try {
        const parsed = JSON.parse(e.data);
        const role = parsed.role || "?";
        const text = parsed.text || "";
        if (!text.trim()) continue;
        lines.push(`[${e.time.slice(0, 5)}] ${role}: ${text}`);
      } catch {
        /* skip malformed */
      }
    }
    return lines.join("\n");
  };

  const copyDebrief = async () => {
    const lines: string[] = [];
    lines.push("# Interview Coach — session debrief\n");
    lines.push("## User comments (pinned to timestamps)\n");
    if (comments.length === 0) {
      lines.push("_no comments_\n");
    } else {
      for (const c of comments) {
        lines.push(`- **${c.time}** — ${c.text}`);
      }
    }
    // Transcript section — utterance events pulled out of the log,
    // formatted chronologically so the reviewer can quickly see what
    // was said at any timestamp they're debugging. Huge quality-of-life
    // improvement over ctrl-F'ing through the raw log.
    const transcript = buildTranscriptSection();
    lines.push("\n## Transcript\n");
    lines.push("```");
    lines.push(transcript || "(no utterances captured)");
    lines.push("```\n");
    lines.push("\n## Debug log\n");
    lines.push("```");
    lines.push(rawLog.trim() || "(empty)");
    lines.push("```\n");
    const text = lines.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      // Flash the button via a tiny state toggle.
      setCopyFlash(true);
      setTimeout(() => setCopyFlash(false), 1400);
    } catch {
      // Fallback: open a prompt window so the user can copy manually.
      window.prompt("Copy this debrief and paste into Claude:", text);
    }
  };
  const [copyFlash, setCopyFlash] = useState(false);

  /**
   * Auto-diagnosis flow. Sends the current log + extracted transcript
   * + user comments to /api/analyze-session, which runs an Opus-4.7
   * pass over everything to identify bugs and improvement opportunities
   * in the orchestrator's behavior. Returns a structured list of
   * findings (severity, category, timestamp, fix proposal) that gets
   * formatted as markdown and copied to clipboard — user pastes into
   * Claude to have the fixes implemented.
   *
   * This is the "auto-improving loop": each session contributes
   * observed bugs, reviewed findings get fixed, the app gets better
   * every session.
   */
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeStatus, setAnalyzeStatus] = useState<string>("");
  const analyzeSession = async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalyzeStatus("Analyzing… (~20-60s)");
    try {
      const transcript = buildTranscriptSection();
      const res = await fetch("/api/analyze-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          log: rawLog,
          transcript,
          userComments: comments.map((c) => ({ time: c.time, text: c.text })),
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        setAnalyzeStatus(
          `Analysis failed (${res.status}). ${errText.slice(0, 120)}`
        );
        return;
      }
      const data = (await res.json()) as {
        summary?: string;
        findings?: Array<{
          severity: "high" | "medium" | "low";
          category: string;
          at: string;
          title: string;
          what: string;
          why: string;
          suggested_fix: string;
        }>;
      };
      const findings = data.findings || [];
      // Format as markdown and copy to clipboard.
      const md: string[] = [];
      md.push("# Interview Coach — auto-diagnosis\n");
      if (data.summary) md.push(`**Summary:** ${data.summary}\n`);
      md.push(`## Findings (${findings.length})\n`);
      if (findings.length === 0) {
        md.push("_No findings. The session looked clean._\n");
      } else {
        for (const f of findings) {
          md.push(`### [${f.severity.toUpperCase()}] ${f.title}`);
          md.push(`- **When:** ${f.at}`);
          md.push(`- **Category:** ${f.category}`);
          md.push(`- **What:** ${f.what}`);
          md.push(`- **Why:** ${f.why}`);
          md.push(`- **Suggested fix:** ${f.suggested_fix}`);
          md.push("");
        }
      }
      md.push("## Raw session debrief\n");
      md.push("_(transcript + log provided for context)_\n");
      md.push("### Transcript\n```");
      md.push(buildTranscriptSection() || "(no utterances)");
      md.push("```\n### Debug log\n```");
      md.push(rawLog.trim() || "(empty)");
      md.push("```\n");
      const text = md.join("\n");
      try {
        await navigator.clipboard.writeText(text);
        setAnalyzeStatus(
          `Copied — ${findings.length} finding${
            findings.length === 1 ? "" : "s"
          }. Paste into Claude.`
        );
      } catch {
        window.prompt("Copy this auto-diagnosis and paste into Claude:", text);
        setAnalyzeStatus(`${findings.length} findings.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setAnalyzeStatus(`Analysis failed: ${msg.slice(0, 120)}`);
    } finally {
      setAnalyzing(false);
      // Clear the status after a while so the button label returns.
      setTimeout(() => setAnalyzeStatus(""), 6000);
    }
  };

  // === Rendering ===
  // Layout contract:
  //   HEADER         — fixed (shrink-0)
  //   EVENT STREAM   — flex-1 min-h-0 overflow-y-auto (grows / shrinks)
  //   COMMENTS BOX   — fixed (shrink-0), always visible at the bottom
  // The event stream is the ONLY scrollable region; the comment input
  // and Copy button are locked to the bottom of the panel and never
  // get pushed off-screen as events accumulate.
  return (
    <div className="h-full flex flex-col border-l border-rule bg-paper-subtle overflow-hidden">
      <div className="px-4 py-3 border-b border-rule flex items-center justify-between shrink-0">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-lighter">
            Live Debug Panel
          </div>
          <div className="text-[10px] text-ink-lighter mt-0.5">
            {entries.length} events · newest first
          </div>
        </div>
        <div className="text-[10px] font-mono text-ink-lighter tabular-nums">
          T+{fmtTime(elapsedSec)}
        </div>
      </div>

      {/* Event stream — newest at top. Scrolls independently of the
          comment section below, which is pinned. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-[11.5px] leading-relaxed font-mono">
        {reversedEntries.length === 0 ? (
          <div className="text-ink-lighter italic mt-4 px-1">
            Waiting for events — start a session or upload a recording.
          </div>
        ) : (
          reversedEntries.map((e) => (
            <LogLine key={e.lineIdx} entry={e} />
          ))
        )}
      </div>

      {/* Comments section — PINNED at the bottom. Internal scroll
          cap keeps the comment list bounded (never pushes the input
          or Copy button off-screen). */}
      <div className="shrink-0 border-t border-rule bg-paper px-3 pt-3 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-lighter mb-1.5">
          Your Comments
        </div>
        <div className="max-h-[100px] overflow-y-auto mb-2 space-y-1">
          {comments.length === 0 ? (
            <div className="text-[11.5px] text-ink-lighter italic px-1">
              No comments yet. Describe what you saw go wrong; the comment pins to the current time.
            </div>
          ) : (
            comments.map((c) => (
              <div
                key={c.id}
                className="group flex gap-2 items-start text-[12px] leading-snug px-1.5 py-1 rounded hover:bg-paper-subtle"
              >
                <span className="font-mono text-[10.5px] text-ink-lighter tabular-nums pt-0.5 shrink-0">
                  {c.time}
                </span>
                <span className="flex-1 text-ink">{c.text}</span>
                <button
                  onClick={() => removeComment(c.id)}
                  className="text-ink-lighter hover:text-rose-600 opacity-0 group-hover:opacity-100 text-[11px]"
                  aria-label="Delete comment"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        <div className="flex gap-1.5 mb-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                addComment();
              }
            }}
            placeholder={`At ${fmtTime(elapsedSec)}: what went wrong?`}
            className="flex-1 min-w-0 text-[12px] px-2 py-1.5 rounded-md border border-rule bg-paper focus:outline-none focus:border-accent"
          />
          <button
            onClick={addComment}
            disabled={!draft.trim()}
            className="px-2.5 py-1.5 text-[11.5px] font-semibold rounded-md bg-accent text-white hover:bg-[#1a73d1] disabled:bg-paper-hover disabled:text-ink-lighter disabled:cursor-not-allowed transition-colors"
          >
            Pin
          </button>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={copyDebrief}
            disabled={entries.length === 0 && comments.length === 0}
            className={`flex-1 px-3 py-2 text-[12px] font-semibold rounded-md transition-colors ${
              copyFlash
                ? "bg-emerald-600 text-white"
                : "bg-ink text-paper hover:bg-[#1f1e1a] disabled:bg-paper-hover disabled:text-ink-lighter"
            }`}
          >
            {copyFlash ? "Copied ✓" : "Copy debrief"}
          </button>
          <button
            onClick={analyzeSession}
            disabled={analyzing || entries.length === 0}
            className="flex-1 px-3 py-2 text-[12px] font-semibold rounded-md bg-accent text-white hover:bg-[#1a73d1] disabled:bg-paper-hover disabled:text-ink-lighter transition-colors"
            title="Run auto-diagnosis: an Opus pass over the session's log + transcript, returns a list of bugs / improvements. Copied as markdown for pasting into Claude."
          >
            {analyzing ? "Analyzing…" : "Analyze & copy"}
          </button>
        </div>
        {analyzeStatus && (
          <div className="mt-1.5 text-[10.5px] text-ink-lighter italic leading-snug">
            {analyzeStatus}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- helpers ----------

function LogLine({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const reasoning = REASONING[entry.key];
  const sourceColor = SOURCE_COLORS[entry.source] ?? "text-ink-light";

  return (
    <div
      className="group py-0.5 px-1 -mx-1 rounded hover:bg-paper cursor-pointer"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex gap-1.5 items-baseline">
        <span className="text-ink-lighter tabular-nums shrink-0 text-[10.5px]">
          {entry.time}
        </span>
        <span className={`font-semibold shrink-0 ${sourceColor}`}>
          {entry.source}
        </span>
        <span className="text-ink">{entry.event}</span>
        <span className="text-ink-light truncate flex-1 min-w-0 text-[11px]">
          {entry.data}
        </span>
        <span className="text-ink-lighter opacity-0 group-hover:opacity-100 text-[10px] shrink-0">
          {expanded ? "▼" : "▶"}
        </span>
      </div>
      {expanded && (
        <div className="mt-1 ml-[52px] pl-2 border-l border-rule text-[11px] font-sans text-ink-light">
          {reasoning ? (
            <>
              <div className="mb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-lighter mr-1">
                  What
                </span>
                {reasoning.what}
              </div>
              <div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-lighter mr-1">
                  Why
                </span>
                {reasoning.why}
              </div>
            </>
          ) : (
            <div className="italic text-ink-lighter">
              Internal event — no user-facing rule.
            </div>
          )}
          {entry.data && (
            <div className="mt-1.5 pt-1.5 border-t border-rule text-[10.5px] font-mono text-ink-lighter break-all">
              {entry.data}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SOURCE_COLORS: Record<string, string> = {
  session: "text-slate-600",
  utterance: "text-ink-lighter",
  roles: "text-violet-600",
  classify: "text-accent",
  filter: "text-orange-600",
  "read-gate": "text-stone-500",
  hysteresis: "text-stone-500",
  moment: "text-amber-600",
  question: "text-emerald-700",
  commentary: "text-rose-600",
  "warmup-cmt": "text-fuchsia-600",
  "listen-hint": "text-sky-600",
};
