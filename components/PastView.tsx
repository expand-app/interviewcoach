"use client";

import { useState, useRef, useEffect } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { splitCommentary } from "@/lib/commentary";
import {
  createSessionShare,
  getSessionShare,
  type SessionShare,
} from "@/lib/client-api";
import type {
  Session,
  SessionScore,
  Utterance,
  Question,
} from "@/types/session";

/** Trims a raw interviewer-speech blob into a short sentence-aligned
 *  quote that matches what the AI was actually reacting to when it
 *  generated the listening hint.
 *
 *  Strategy: LENGTH-anchored tail extraction, NOT sentence-count.
 *
 *  An earlier sentence-count approach ("keep last 2 sentences") got
 *  defeated by trailing filler — sessions routinely end an interviewer
 *  monologue with "Yeah. Yeah." or "Right. OK." and those tiny
 *  one-word "sentences" would dominate the final 2-sentence keep,
 *  pushing the substantive content out of view. A user complained that
 *  a hint about "set agenda: 25 minutes, intro → resume → Q&A"
 *  rendered with the quote literally just "Yeah. Yeah." because two
 *  trailing acknowledgement utterances were the last 2 segmented
 *  sentences.
 *
 *  Length-anchored: take the LAST ~220 chars, then walk forward to the
 *  first sentence boundary so the kept body opens cleanly. 220 chars
 *  is enough to span 2-4 substantive sentences AND any trailing filler
 *  — the filler is included but doesn't crowd out the meat. Prepend
 *  "…" to honestly mark the truncation; suffix "…" if the kept tail
 *  itself ends mid-sentence (the time window cut off the speaker).
 *
 *  Why 220:
 *    - At normal interviewer speech density (~10-15 chars/sec) this is
 *      ~15-22 seconds of speech, which matches the typical interviewer
 *      monologue chunk a listening hint reacts to.
 *    - Comfortable to read in 2-3 lines on mobile, 1-2 lines on
 *      desktop — doesn't crowd the listening hint below it.
 *    - Long enough that filler tail ("Yeah. OK.") is just decoration
 *      around the main content, not the entire quote.
 *
 *  Return: cleaned-up tail quote. Empty input → empty string. */
function tidyInterviewerQuote(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "";

  // Sentence-ending punctuation we recognize. Both Latin and CJK.
  const SENT_END = /[.!?。！？]/;
  const TARGET_LEN = 220;

  // Short input — show as-is. With a quick mid-sentence cleanup so a
  // window that opens on a fragment doesn't read like a transcription
  // glitch.
  if (text.length <= TARGET_LEN) {
    const startsCleanly = /^[A-Z一-鿿\d]/.test(text);
    if (startsCleanly) {
      const lastChar = text[text.length - 1];
      const trailing = !SENT_END.test(lastChar);
      return text + (trailing ? "…" : "");
    }
    // Skip lead-in fragment to first sentence end + space
    const m = text.match(/[.!?。！？]\s*/);
    if (m && typeof m.index === "number" && m.index + m[0].length < text.length) {
      const body = text.slice(m.index + m[0].length).trim();
      if (body) {
        const lastChar = body[body.length - 1];
        const trailing = !SENT_END.test(lastChar);
        return "… " + body + (trailing ? "…" : "");
      }
    }
    return text;
  }

  // Long input — take last TARGET_LEN chars, then advance to the first
  // sentence-end so the displayed body opens at a clean sentence start.
  const tail = text.slice(text.length - TARGET_LEN);
  const m = tail.match(/[.!?。！？]\s*/);
  if (m && typeof m.index === "number" && m.index + m[0].length < tail.length) {
    const body = tail.slice(m.index + m[0].length).trim();
    if (body) {
      const lastChar = body[body.length - 1];
      const trailing = !SENT_END.test(lastChar);
      return "… " + body + (trailing ? "…" : "");
    }
  }
  // Fallback: no clean sentence boundary found in the tail. Return the
  // raw tail with leading ellipsis (and trailing if mid-sentence).
  const trimmedTail = tail.trim();
  const lastChar = trimmedTail[trimmedTail.length - 1];
  const trailing = lastChar ? !SENT_END.test(lastChar) : false;
  return "… " + trimmedTail + (trailing ? "…" : "");
}

function fmt(sec: number) {
  const mm = Math.floor(sec / 60).toString().padStart(2, "0");
  const ss = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

/** Small text button anchored next to the verdict chip, lets the user
 *  re-fire /api/score-session against the same Session. While in flight,
 *  swaps the icon for a pulsing dot and disables clicks so a user
 *  spamming the button doesn't queue duplicate requests. Notion-style:
 *  no border, hover underlines, sits as a quiet affordance rather than
 *  competing with the chip. */
function RefreshScoreButton({
  onClick,
  isRefreshing,
}: {
  onClick: () => void;
  isRefreshing: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={isRefreshing}
      className="print:hidden shrink-0 inline-flex items-center gap-1.5 text-[11px] text-text-subtle hover:text-text disabled:opacity-60 disabled:cursor-not-allowed transition-colors group"
      title="Re-score this session"
    >
      {isRefreshing ? (
        <>
          <span className="inline-flex gap-[2px]">
            <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot" />
            <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.15s]" />
            <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.3s]" />
          </span>
          <span>Re-scoring…</span>
        </>
      ) : (
        <>
          {/* Refresh icon — SVG to avoid `↻` U+21BB font-fallback
              rendering issues. Inherits the group's hover-rotate
              transition. */}
          <span className="leading-none group-hover:rotate-180 transition-transform duration-300">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 7a4 4 0 1 1 1.2 2.85" />
              <polyline points="3 6 3 9.5 6.5 9.5" />
            </svg>
          </span>
          <span className="group-hover:underline underline-offset-2">
            Re-score
          </span>
        </>
      )}
    </button>
  );
}

/** Inline-formats a single line of model-emitted score / improvement
 *  text into HTML safe to drop into dangerouslySetInnerHTML.
 *
 *  Steps, in order:
 *    1. Escape `&`, `<`, `>` so any unexpected raw markup the model
 *       might emit (a stray `<div>`, an HTML quote in a code snippet)
 *       can't inject real DOM.
 *    2. Whitelist `<strong>...</strong>` by un-escaping ONLY those
 *       exact tag strings. The model is instructed (in the
 *       score-session prompt's tone examples) to wrap key numbers /
 *       claims in `<strong>` directly —without this restoration, the
 *       tags end up as literal `&lt;strong&gt;` text in the rendered
 *       improvement detail / fix copy, which is what the user
 *       reported. Only the bare open/close tags are restored —any
 *       attributes (`<strong onclick="...">`) stay escaped.
 *    3. Convert markdown `**word**` to `<strong>word</strong>` for the
 *       rare cases the model uses markdown emphasis instead.
 *
 *  Used both inside ImprovementBody and by the small <RichText>
 *  helper for short single-line fields (summary, justification,
 *  titles). */
export function renderInlineRichText(s: string): string {
  const escaped = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withStrong = escaped
    .replace(/&lt;strong&gt;/g, "<strong>")
    .replace(/&lt;\/strong&gt;/g, "</strong>");
  return withStrong.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/** Compact wrapper for any inline LLM-generated string that may
 *  contain `<strong>` or `**bold**`. Avoids repeating the
 *  dangerouslySetInnerHTML boilerplate at every call site. */
export function RichText({
  text,
  as = "span",
  className,
}: {
  text: string;
  as?: "span" | "p" | "div";
  className?: string;
}) {
  const html = { __html: renderInlineRichText(text) };
  if (as === "p")
    return <p className={className} dangerouslySetInnerHTML={html} />;
  if (as === "div")
    return <div className={className} dangerouslySetInnerHTML={html} />;
  return <span className={className} dangerouslySetInnerHTML={html} />;
}

/** Renders the long-form `detail` / `fix` strings inside the Score
 *  Session improvement card. The model is instructed (see
 *  /api/score-session/route.ts system prompt) to emit:
 *    - paragraph breaks via real newlines (`\n\n` between blocks)
 *    - bullet lists as lines starting with `- ` whenever there are
 *      3+ distinct points, so the reader can scan instead of parsing
 *      a wall of text.
 *
 *  Plain-text fallback (single paragraph, no bullets) still renders
 *  cleanly as one <p>. Inline formatting (markdown `**bold**` and
 *  whitelisted `<strong>` tags) is handled by renderInlineRichText. */
function ImprovementBody({ text }: { text: string }) {
  const renderInline = renderInlineRichText;

  // The model emits multi-section content (lead-in paragraph + bullets
  // + closing paragraph) and is instructed to separate them with real
  // newlines. In practice Sonnet uses a MIX of `\n\n` paragraph breaks
  // and bare `\n` line breaks even within the same response, and
  // sometimes runs the lead-in / bullets / closing all together with
  // single `\n` between them.
  //
  // Strategy: collapse the whole text into ONE flat array of lines
  // (split on EITHER \n\n or \n), then walk through and group
  // consecutive bulleted lines into <ul> blocks and consecutive
  // non-bulleted lines into <p> blocks. This makes the rendering
  // robust to whichever break style the model picked, without
  // requiring the prompt to enforce a single style.
  const allLines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (allLines.length === 0) return null;

  // Group consecutive lines by "is this a bullet?". A bullet line
  // starts with "- " or "* " (some Sonnet variants emit "* "); the
  // dash/asterisk is followed by whitespace.
  type Group = { kind: "ul" | "p"; lines: string[] };
  const groups: Group[] = [];
  for (const line of allLines) {
    const isBullet = /^[-*]\s+/.test(line);
    const last = groups[groups.length - 1];
    if (isBullet) {
      if (last && last.kind === "ul") last.lines.push(line);
      else groups.push({ kind: "ul", lines: [line] });
    } else {
      if (last && last.kind === "p") last.lines.push(line);
      else groups.push({ kind: "p", lines: [line] });
    }
  }

  return (
    <div className="space-y-2.5">
      {groups.map((g, i) => {
        if (g.kind === "ul") {
          return (
            <ul
              key={i}
              className="list-disc pl-5 space-y-1.5 marker:text-text-subtle"
            >
              {g.lines.map((line, j) => (
                <li
                  key={j}
                  dangerouslySetInnerHTML={{
                    __html: renderInline(line.replace(/^[-*]\s+/, "")),
                  }}
                />
              ))}
            </ul>
          );
        }
        // Paragraph group — multiple non-bulleted lines glue together
        // with spaces (the model sometimes hard-wraps a long sentence
        // mid-thought and we don't want to render that as separate
        // paragraphs).
        const para = g.lines.join(" ");
        return (
          <p
            key={i}
            dangerouslySetInnerHTML={{ __html: renderInline(para) }}
          />
        );
      })}
    </div>
  );
}

/** Score-band legend rendered between the score header and the
 *  per-dimension breakdown. Shows what each verdict band means in
 *  plain English with its percentage range, with the current
 *  session's band subtly highlighted (saturated chip background +
 *  bold) so the user can see "we're here" at a glance.
 *
 *  Source of truth for the band cutoffs is verdictForPercent() in
 *  /api/score-session/route.ts; if those thresholds change, update
 *  the BAND_DEFS array below to match. The visual palette mirrors
 *  the verdict chips above (success / warning / error). */
const BAND_DEFS: Array<{
  key: SessionScore["verdict"];
  label: string;
  range: string;
  meaning: string;
  bg: string;
  text: string;
}> = [
  {
    key: "fail",
    label: "Fail",
    range: "< 55",
    meaning: "Clear no — panel passes.",
    bg: "rgba(178, 58, 58, 0.10)",
    text: "var(--color-error)",
  },
  {
    key: "borderline",
    label: "Borderline",
    range: "55–64",
    meaning: "Committee hesitates; could go either way.",
    bg: "rgba(184, 122, 31, 0.10)",
    text: "var(--color-warning)",
  },
  {
    key: "pass",
    label: "Pass",
    range: "65–84",
    meaning: "Advances, with reservations to probe next round.",
    bg: "rgba(31, 122, 77, 0.08)",
    text: "var(--color-success)",
  },
  {
    key: "strong_pass",
    label: "Strong Pass",
    range: "≥ 85",
    meaning: "Panel advances without hesitation.",
    bg: "rgba(31, 122, 77, 0.14)",
    text: "var(--color-success)",
  },
];

function ScoreBandLegend({ verdict }: { verdict: SessionScore["verdict"] }) {
  return (
    <div className="px-6 py-3 border-b border-border bg-surface">
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-text-subtle mb-2">
        What the score bands mean (out of 100)
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {BAND_DEFS.map((b) => {
          const active = b.key === verdict;
          return (
            <div
              key={b.key}
              className="rounded-md px-3 py-2 transition-colors"
              style={{
                background: active ? b.bg : "var(--color-bg)",
                border: active
                  ? `1px solid ${b.text}`
                  : "1px solid var(--color-border)",
              }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="text-[12px] font-semibold"
                  style={{ color: active ? b.text : "var(--color-text)" }}
                >
                  {b.label}
                </span>
                <span
                  className="text-[10.5px] tabular-nums"
                  style={{
                    color: active ? b.text : "var(--color-text-subtle)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {b.range}
                </span>
              </div>
              <div
                className="text-[11px] leading-snug mt-1"
                style={{ color: "var(--color-text-muted)" }}
              >
                {b.meaning}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * End-of-session scorecard. Three rendering modes:
 *   - No score yet: loading strip (scoring request in flight).
 *   - verdict === "insufficient_data": no score circle, just the reason — *     the model explicitly declined to judge.
 *   - Normal: score / totalMax with verdict chip, per-dimension bars (N/A
 *     dimensions render as a dash with their reason), and improvements.
 *
 * Refresh: when `onRefresh` is supplied, both the insufficient-data card
 * and the normal scorecard expose a small "Re-score" link button that
 * re-fires /api/score-session against the same Session. Useful when:
 *   - a session was saved before scoring rules tightened up (the
 *     answer-text fix landed mid-week, older sessions show insufficient
 *     even though they have substantive content)
 *   - the user wants a second opinion / refresh after editing the JD or
 *     resume on file
 *   - a transient API hiccup made the first scoring attempt fail
 *
 * `isRefreshing` swaps the chip / button into a spinner state so the
 * user sees the request is in flight; the existing score stays on screen
 * underneath until the new one lands (no flicker to blank).
 */

/** Translate a raw API error string into a user-friendly headline +
 *  subline. The raw error often leaks HTTP codes / API jargon
 *  ("HTTP 400: Missing JD or questions") that look like a system
 *  crash to non-technical users. Pattern-match on known causes and
 *  fall back to a generic message for unknown ones. */
function friendlyScoreError(raw: string): {
  headline: string;
  subline: string;
} {
  const r = raw.toLowerCase();
  // Most common: session was too short / didn't include any locked
  // questions / didn't include a JD. The /api/score-session route
  // returns "Missing JD or questions" for this case.
  if (
    r.includes("missing jd") ||
    r.includes("missing questions") ||
    r.includes("missing jd or questions")
  ) {
    return {
      headline:
        "This session didn't capture enough content to score.",
      subline:
        "Either no Lead Question was locked, or the session ended before any substantive answer landed.",
    };
  }
  if (r.includes("insufficient")) {
    return {
      headline: "Not enough content for a confident score.",
      subline:
        "The transcript was too short or only contained pleasantries.",
    };
  }
  if (r.includes("rate limit") || r.includes("429")) {
    return {
      headline: "AI scoring is temporarily rate-limited.",
      subline: "Wait a moment and retry.",
    };
  }
  if (r.includes("timeout") || r.includes("timed out")) {
    return {
      headline: "Scoring timed out.",
      subline:
        "The AI took too long to respond —usually a transient issue.",
    };
  }
  if (r.includes("network") || r.includes("fetch") || r.includes("econnreset")) {
    return {
      headline: "Couldn't reach the scoring service.",
      subline: "Check your connection and retry.",
    };
  }
  // Generic fallback —don't expose HTTP code or stack to the user.
  return {
    headline: "We couldn't generate scoring for this session.",
    subline:
      "Something on the AI side went wrong. The transcript is still intact.",
  };
}

/** Empty-session placeholder. Renders in place of ScoreCard when the
 *  saved Session has no recordable content —duration < 10s OR no
 *  Lead/Probe questions captured during the live run. Without this
 *  short-circuit, ScoreCard would render its "Scoring this session…
 *  spinner forever (no scoring path ever fires for an empty session,
 *  by design —there's nothing for the model to grade), which the
 *  user reads as a stuck UI.
 *
 *  Two flavors:
 *    - duration < 10s   —"Recording too short to grade."
 *    - questions == 0   —"No interview questions were detected."
 *  Each case is genuinely different content-wise; a longer-than-10s
 *  session that yielded zero questions usually means Deepgram never
 *  produced a final utterance (mic muted / wrong device). Wording
 *  reflects that. */
function EmptySessionCard({
  durationSeconds,
}: {
  durationSeconds: number;
}) {
  const tooShort = durationSeconds < 10;
  const headline = tooShort
    ? "Recording too short to grade."
    : "No interview content was captured.";
  const subline = tooShort
    ? "This session ended before any answers were recorded —typically a misclick or a mic permission denied at the start. Start a fresh session to get scored."
    : "The recording ran but no questions or candidate speech were finalized —usually a muted mic or the wrong audio device. The recording (if any) is still saved below.";
  return (
    <div className="pv-no-break mb-8 rounded-lg border border-border bg-bg overflow-hidden">
      <div className="p-6">
        <div
          className="inline-block text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text-muted)",
          }}
        >
          Empty Session
        </div>
        <p className="mt-3 text-[14.5px] leading-relaxed text-text">
          {headline}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
          {subline}
        </p>
      </div>
    </div>
  );
}

export function ScoreCard({
  score,
  scoreError,
  onRefresh,
  isRefreshing,
}: {
  score?: SessionScore;
  scoreError?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  // Failure state —distinguishes "still scoring" (no error, no score)
  // from "scoring permanently failed" (error set). Without this branch
  // the user sees an indefinite loading strip after a failed scoring
  // request with no way to retry except hard-refreshing. Visual tone
  // is muted-warning, NOT alarming-error: the rest of the session
  // (recording, transcript) is fine —only the AI scoring step
  // couldn't complete. We deliberately do NOT surface the raw error
  // message (HTTP codes, "Missing JD", etc.) —those are engineer-
  // facing strings that confuse non-technical users (the user
  // explicitly asked for them to be hidden). The friendly headline
  // + subline pair plus the Re-score button are enough for the user
  // to know what's going on and what to do.
  if (!score && scoreError) {
    const friendly = friendlyScoreError(scoreError);
    return (
      <div className="pv-no-break mb-10 rounded-lg border border-border bg-surface overflow-hidden">
        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="inline-block text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded bg-surface-2 text-text-muted">
              Scoring unavailable
            </div>
            {onRefresh && (
              <RefreshScoreButton
                onClick={onRefresh}
                isRefreshing={!!isRefreshing}
              />
            )}
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed text-text">
            {friendly.headline}
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
            {friendly.subline} Your recording and transcript are still
            saved below. {onRefresh ? "Click Re-score to try again." : ""}
          </p>
        </div>
      </div>
    );
  }
  if (!score) {
    return (
      <div className="pv-no-break mb-8 rounded-lg border border-border bg-surface px-6 py-4 text-sm text-text-subtle italic animate-pulse-dot">
        Scoring this session…      </div>
    );
  }

  const verdictStyles: Record<
    SessionScore["verdict"],
    { label: string; chipBg: string; chipText: string; ringColor: string }
  > = {
    // Verdict chip palette uses the design system's functional colors
    // (success / warning / error) instead of Tailwind defaults. Subtle
    // surface backgrounds + saturated text reads as a clean "tag"
    // rather than a noisy badge —same approach as the marketing
    // site's social-proof / step-number elements.
    strong_pass: {
      label: "Strong Pass",
      chipBg: "rgba(31, 122, 77, 0.12)",
      chipText: "var(--color-success)",
      ringColor: "var(--color-success)",
    },
    pass: {
      label: "Pass",
      chipBg: "rgba(31, 122, 77, 0.08)",
      chipText: "var(--color-success)",
      ringColor: "var(--color-success)",
    },
    borderline: {
      label: "Borderline",
      chipBg: "rgba(184, 122, 31, 0.10)",
      chipText: "var(--color-warning)",
      ringColor: "var(--color-warning)",
    },
    fail: {
      label: "Fail",
      chipBg: "rgba(178, 58, 58, 0.10)",
      chipText: "var(--color-error)",
      ringColor: "var(--color-error)",
    },
    insufficient_data: {
      label: "Insufficient Data to Score",
      chipBg: "var(--color-surface-2)",
      chipText: "var(--color-text-muted)",
      ringColor: "var(--color-border-strong)",
    },
  };
  const v = verdictStyles[score.verdict];

  // Insufficient-data rendering: no score circle, no dimension bars,
  // just the chip + a short friendly explanation + the server-side
  // summary (which carries actual stats: how many questions, how many
  // were answered, total chars). Improvements are omitted because the
  // endpoint returns none in this case. The Refresh button is anchored
  // top-right of the chip row so the user can retry without starting
  // a new session.
  //
  // Why surface `score.summary` here (we used to suppress it):
  // hardcoding "Run a longer session — at least one full case
  // question..." is actively misleading when the user just recorded a
  // 35-minute interview with 12 answered questions and the MODEL is
  // the one declining to grade (override fell through). The summary
  // text generated server-side ("Captured 6 main questions and 12
  // with substantive candidate answers (15348 chars total). The
  // model assigned weight 0 to every rubric dimension.") makes the
  // distinction between "you didn't record enough" and "the model
  // wobbled" obvious. The first sentence stays as a generic friendly
  // header; the second sentence is now the real summary.
  if (score.verdict === "insufficient_data") {
    const fallback =
      "Run a longer session — at least one full case question, answered end-to-end — and a graded scorecard will appear here.";
    const summary = (score.summary || "").trim() || fallback;
    return (
      <div className="pv-no-break mb-10 rounded-lg border border-border bg-bg overflow-hidden">
        <div className="p-6">
          <div className="flex items-start justify-between gap-3">
            <div
              className="inline-block text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded"
              style={{ background: v.chipBg, color: v.chipText }}
            >
              {v.label}
            </div>
            {onRefresh && (
              <RefreshScoreButton
                onClick={onRefresh}
                isRefreshing={!!isRefreshing}
              />
            )}
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed text-text">
            Not enough was captured to produce a scorecard.
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
            {summary}
          </p>
        </div>
      </div>
    );
  }

  const naCount = score.dimensions.filter((d) => d.score === null).length;

  // Normal score card has NO `pv-no-break` on the outer wrapper —the
  // card with 5 dimensions + improvements is taller than the space left
  // on page 1 after the title block, and `break-inside: avoid` on the
  // wrapper would force the whole card onto page 2, leaving page 1
  // mostly empty. Instead we let the browser split the card across
  // pages naturally and apply `break-inside: avoid` to smaller atomic
  // sections inside (verdict header, individual dimensions, the main
  // improvement item) so those don't get torn mid-row.
  return (
    <div className="mb-10 rounded-lg border border-border bg-bg overflow-hidden">
      {/* Header: score + verdict + summary */}
      <div className="pv-no-break flex items-start gap-6 p-6 border-b border-border">
        <div
          className="shrink-0 w-[92px] h-[92px] rounded-full grid place-items-center bg-surface"
          style={{
            boxShadow: `0 0 0 4px ${v.ringColor}`,
          }}
        >
          <div className="text-center leading-none">
            <div className="text-[32px] font-semibold text-text tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
              {score.total}
            </div>
            <div className="text-[10px] text-text-subtle tracking-wider uppercase mt-1">
              / {score.totalMax}
            </div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div
              className="inline-block text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded"
              style={{ background: v.chipBg, color: v.chipText }}
            >
              {v.label} · {score.percent}%
            </div>
            {onRefresh && (
              <RefreshScoreButton
                onClick={onRefresh}
                isRefreshing={!!isRefreshing}
              />
            )}
          </div>
          {/* score.summary may contain <strong>...</strong> from the
              LLM —render via RichText so the bold actually shows. */}
          <RichText
            as="p"
            text={score.summary}
            className="mt-3 text-[14.5px] leading-relaxed text-text"
          />
          {naCount > 0 && (
            <p className="mt-2 text-[12px] leading-relaxed text-text-subtle italic">
              {naCount} dimension{naCount === 1 ? " was" : "s were"}{" "}
              given weight 0 for this session (e.g. Role Fit isn&apos;t
              tested in a pure technical screen). The remaining{" "}
              {5 - naCount} dimension
              {5 - naCount === 1 ? "" : "s"} carry the full 100 points
              between them.
            </p>
          )}
        </div>
      </div>

      {/* Score legend —what each band means.
          Renders the four verdict bands as a horizontal key, with the
          band corresponding to the current score subtly highlighted.
          Helps the user calibrate "is 58% good or bad" without having
          to remember the rubric thresholds —see verdictForPercent in
          /api/score-session/route.ts for the source of truth on the
          band cutoffs. */}
      <ScoreBandLegend verdict={score.verdict} />

      {/* Per-dimension breakdown */}
      <div className="divide-y divide-border">
        {score.dimensions.map((d) => {
          const isNA = d.score === null;
          const pct = isNA || d.max === 0 ? 0 : ((d.score as number) / d.max) * 100;
          // Bar color tracks the same success / warning / error
          // semantic palette as the verdict chips. —0% = success,
          // —0% = warning, otherwise error. Inline styles pull from
          // CSS variables so the bar follows future palette tweaks
          // without code changes.
          const barColor =
            pct >= 80
              ? "var(--color-success)"
              : pct >= 60
              ? "var(--color-warning)"
              : "var(--color-error)";
          return (
            <div key={d.key} className="pv-no-break px-6 py-3">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <div
                  className={`text-[13px] font-medium ${
                    isNA ? "text-text-subtle" : "text-text"
                  }`}
                >
                  {d.label}
                  {isNA && (
                    <span
                      className="ml-2 text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded"
                      style={{
                        background: "var(--color-surface-2)",
                        color: "var(--color-text-muted)",
                      }}
                    >
                      N/A
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-text-muted tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                  {isNA ? `—/ ${d.max}` : `${d.score} / ${d.max}`}
                </div>
              </div>
              {!isNA && (
                <div className="h-1.5 w-full rounded-full overflow-hidden mb-1.5" style={{ background: "var(--color-surface-2)" }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, background: barColor }}
                  />
                </div>
              )}
              <RichText
                as="p"
                text={d.justification}
                className="text-[13px] leading-relaxed text-text-muted"
              />
            </div>
          );
        })}
      </div>

      {/* Improvements —first entry is the MAIN issue (with elaboration
          + fix); subsequent entries are secondary, title only.
          Backward-compat: legacy sessions stored improvements as
          string[]; we render those as title-only entries. */}
      {score.improvements.length > 0 && (
        <div className="px-6 py-6 bg-surface border-t border-border">
          <div className="pv-keep-with-next text-[11px] font-medium uppercase tracking-wider text-text-subtle mb-4">
            Areas of Improvement
          </div>
          {(() => {
            // Normalize: legacy localStorage entries may be plain strings;
            // cast widens the type so the runtime check is reachable.
            const raw = score.improvements as unknown as Array<
              { title: string; detail?: string; fix?: string } | string
            >;
            const items = raw.map((imp) =>
              typeof imp === "string" ? { title: imp } : imp
            );
            const main = items[0];
            const secondaries = items.slice(1);
            return (
              <div className="space-y-6">
                {/* Main issue: title is the headline; detail is the
                    explanation in its own block; fix is a clearly
                    separated "what to do next time" block with its
                    own bordered card so the eye can lock onto each
                    section without scanning a wall of text. */}
                {main && (
                  <div className="pv-no-break">
                    <div className="text-[10px] font-medium uppercase tracking-wider mb-2"
                         style={{ color: "var(--color-warning)" }}>
                      Main Issue
                    </div>
                    <RichText
                      as="div"
                      text={main.title}
                      className="text-[15.5px] font-semibold leading-snug text-text mb-3"
                    />
                    {main.detail && (
                      <div className="text-[13.5px] leading-relaxed text-text-muted mb-4">
                        <ImprovementBody text={main.detail} />
                      </div>
                    )}
                    {main.fix && (
                      <div
                        className="rounded-md px-4 py-3 mt-1"
                        style={{
                          background: "var(--color-bg)",
                          border: "1px solid var(--color-border)",
                          borderLeft: "3px solid var(--color-success)",
                        }}
                      >
                        <div
                          className="text-[10px] font-semibold uppercase tracking-wider mb-1.5"
                          style={{ color: "var(--color-success)" }}
                        >
                          How to Fix
                        </div>
                        <div className="text-[13.5px] leading-relaxed text-text">
                          <ImprovementBody text={main.fix} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* Also worth noting: separated by a thin rule from
                    the main issue so the visual hierarchy is clear. */}
                {secondaries.length > 0 && (
                  <div className="pt-4 border-t border-border">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-text-subtle mb-2.5">
                      Also Worth Noting
                    </div>
                    <ul className="space-y-2">
                      {secondaries.map((imp, i) => (
                        <li
                          key={i}
                          className="text-[13.5px] leading-relaxed text-text-muted flex gap-2.5"
                        >
                          <span
                            className="shrink-0 mt-1.5 w-1 h-1 rounded-full"
                            style={{ background: "var(--color-text-subtle)" }}
                          />
                          <RichText text={imp.title} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * Screen recording playback + download for a past session.
 *
 * Mounted when session.videoUrl is set —the user enabled "Capture
 * system audio" (which transitively enables the new self-tab screen
 * recording) and accepted the second share prompt with a video track.
 * The video element is native HTML5 + browser default controls — * keeps this lightweight and works for whatever WebM (vp9 / vp8 /
 * fallback) the recorder happened to produce.
 *
 * Below the video is a Phase Rail: a clickable timeline showing each
 * Lead Question as a labeled band and Probe Questions as ticks. Lets
 * the user jump between phases without scrubbing blindly. Active band
 * (whichever Lead Q's reign covers the current playback time) is
 * accent-tinted; the rest are muted. A red playhead line tracks
 * currentTime.
 *
 * The download button generates an `<a download>` from the same
 * blob URL the player uses. File name embeds the session title +
 * date for easy file-tree organization.
 */
export function VideoSection({
  videoUrl,
  sessionId,
  sessionTitle,
  questions,
  durationSec,
  currentTime,
  videoRef,
  onTimeUpdate,
  onReload,
  downloadOverrideUserId,
  shareToken,
}: {
  videoUrl: string;
  /** ID of the saved session —used by the Download button to ask the
   *  server for a transcoded MOV via /api/uploads/download. Without
   *  this we'd have nothing to look up the S3 key against. */
  sessionId: string;
  sessionTitle: string;
  /** All questions (Lead + Probe) in chronological order —used to
   *  build the phase rail under the video. Lead Questions become
   *  labeled bands; Probe Questions become small ticks within their
   *  parent's band. */
  questions: Session["questions"];
  /** Total session length used to scale marker positions. We prefer
   *  the session's recorded durationSeconds over the video element's
   *  duration because long WebM blobs assembled across pause/resume
   *  cycles often have unreliable / Infinity-valued metadata until
   *  the user has scrubbed all the way through. */
  durationSec: number;
  /** Live playback time, forwarded from the parent so the rail can
   *  highlight the current band and draw the playhead. */
  currentTime: number;
  /** Forwarded from PastView so the Interview Transcript entries can
   *  drive `videoRef.current.currentTime = ts` to seek the recording
   *  on click. Same ref also gives PastView read-access to currentTime
   *  for the "currently playing" entry highlight. */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /** Called on every video time update so the parent can derive which
   *  Q&A entry is currently playing. */
  onTimeUpdate?: (currentTime: number) => void;
  /** Called when the user clicks "Try again" on the playback-error
   *  overlay. Lets PastView re-sign a fresh GET URL, which recovers
   *  from the most common case (presigned URL TTL expired). */
  onReload?: () => void;
  /** Override the userId sent on the Download button's API call.
   *  In the normal owner-viewing-own-session flow we read the userId
   *  from the Zustand store. The admin debug page renders this same
   *  component for OTHER users' sessions and needs to send the
   *  session-owner's userId so the server-side ownership check
   *  passes. (Admin can reach the route either way thanks to the
   *  isAdminRequest bypass —but sending the correct user_id keeps
   *  audit logs sensible and avoids accidentally falling back to the
   *  admin's own user_id.) */
  downloadOverrideUserId?: string;
  /** When set, the Download button uses /api/share/[token]/download
   *  instead of the authenticated /api/uploads/get flow. The public
   *  share viewer at /share/[token] passes this so an anonymous
   *  visitor (no x-user-id) can still save the recording. The token
   *  IS the auth —same trust model as the JSON endpoint above. */
  shareToken?: string;
}) {
  const storeUserId = useStore((s) => s.user?.userId);
  const userId = downloadOverrideUserId || storeUserId;
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Tracks the most recent <video> onError event so the overlay can
  // explain why playback didn't start. Cleared by onLoadedMetadata /
  // onTimeUpdate (a successful play recovers the player), and by
  // a fresh URL coming in via the videoUrl prop (see effect below).
  const [loadError, setLoadError] = useState<string | null>(null);
  // Reset error when the URL changes —gives the new URL a chance to
  // load before re-rendering the overlay.
  useEffect(() => {
    setLoadError(null);
  }, [videoUrl]);
  // No more Transcoding state —click Download —presigned URL of the
  // ORIGINAL S3 object (whatever the recorder produced, .mp4 or .webm)
  // —browser native download. Zero wait.
  //
  // The MOV/MP4 transcode pipeline still exists server-side for the
  // (rare) WeChat-compat use case but no longer gates the Download
  // button: serving raw is always faster, and "raw recording is
  // MP4 fragmented" plays everywhere except WeChat / iOS / iMovie.
  // If we later need a "Convert for WeChat" affordance, we'll surface
  // it as a separate explicit action rather than blocking the
  // primary Download flow on it.

  /** Click handler —fetch a presigned URL for the ORIGINAL S3
   *  recording (kind=video) and trigger a native browser download
   *  via a synthesized anchor. No transcoding, no blob buffering,
   *  no spinner —the file streams direct from S3 / CloudFront.
   *
   *  Branches on `shareToken`: with one set we hit the public
   *  /api/share/[token]/download endpoint (token-auth, no
   *  x-user-id). Without one we hit /api/uploads/get and require a
   *  signed-in userId. */
  const handleDownload = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (!shareToken && !userId) {
      setDownloadError("Sign in first.");
      return;
    }
    setDownloadError(null);
    try {
      // Critical: pass `filename` so the server signs a URL whose
      // S3 response carries Content-Disposition: attachment. Without
      // that header, browsers ignore the `<a download>` attribute on
      // cross-origin links and play the video inline instead of
      // saving it. With the header, the browser always saves.
      let r: Response;
      if (shareToken) {
        const params = new URLSearchParams({
          kind: "video",
          filename: downloadFilename,
        });
        r = await fetch(
          `/api/share/${encodeURIComponent(shareToken)}/download?${params.toString()}`,
          { cache: "no-store" }
        );
      } else {
        const params = new URLSearchParams({
          sessionId,
          kind: "video",
          filename: downloadFilename,
        });
        r = await fetch(`/api/uploads/get?${params.toString()}`, {
          headers: { "x-user-id": userId! },
          cache: "no-store",
        });
      }
      if (!r.ok) {
        throw new Error(`Download URL not available (${r.status}).`);
      }
      const data = (await r.json()) as { url?: string };
      if (!data.url) {
        throw new Error("Server didn't return a download URL.");
      }
      // Navigate to the URL —S3's Content-Disposition: attachment
      // forces download, the browser tab does NOT navigate away.
      // We still create an anchor (vs window.location) so the
      // download is treated as a user gesture properly.
      const a = document.createElement("a");
      a.href = data.url;
      a.download = downloadFilename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Download failed.";
      setDownloadError(msg);
      console.warn("[VideoSection] download failed:", err);
    }
  };
  // Sanitized filename. Suffix derived from the actual recording
  // format on S3 —.mp4 for sessions recorded after the MP4 switch,
  // .webm for older sessions. The blob's MIME governs playback
  // regardless of suffix; the suffix is just a hint to the OS.
  const downloadFilename = (() => {
    const safe = sessionTitle
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const stamp = new Date().toISOString().slice(0, 10);
    let ext = "mp4";
    try {
      const m = new URL(videoUrl).pathname.match(/\.([a-z0-9]{2,5})$/i);
      if (m) ext = m[1].toLowerCase();
    } catch {
      /* blob: URLs fall here —keep mp4 default for new VP9-replaced
       * recordings */
    }
    return `${safe || "interview-recording"} —${stamp}.${ext}`;
  })();

  // Split into Leads vs Probes for rendering. Leads anchor each phase
  // band; Probes are sub-markers within their parent's band.
  const leads = questions.filter((q) => !q.parentQuestionId);
  const probes = questions.filter((q) => !!q.parentQuestionId);

  // Helper: seek the video to a timestamp and (best-effort) play.
  const seek = (ts: number) => {
    if (!videoRef?.current) return;
    videoRef.current.currentTime = ts;
    void videoRef.current.play().catch(() => {
      /* autoplay blocked —user can press play */
    });
  };

  // Pct positioning. Guard against durationSec being 0 (in-flight
  // metadata) so we don't divide by zero —markers collapse to 0%
  // until duration is known.
  const pct = (sec: number) =>
    durationSec > 0 ? Math.max(0, Math.min(100, (sec / durationSec) * 100)) : 0;

  // Active phase = latest Lead Q whose timestamp is <= currentTime.
  const activeLeadIdx = leads.reduce(
    (acc, q, i) => (q.askedAtSeconds <= currentTime ? i : acc),
    -1
  );

  return (
    // print:hidden — the video frame, phase rail, and Recording chrome
    // don't translate to a printed page (a still video frame is just a
    // black box; the phase rail is interactive and useless on paper).
    // Hiding the entire block keeps Export PDF clean: title → score
    // card → transcript, no leftover empty media block. Applies to all
    // three callers (PastView, admin debug, share viewer); only the
    // PDF flows print, so on-screen display is unchanged.
    <div className="rounded-lg border border-border overflow-hidden bg-bg mb-8 print:hidden">
      <div className="px-5 py-3 border-b border-border flex items-center justify-between">
        <div className="eyebrow">Recording</div>
        {/* Download affordance is suppressed in the public share viewer
            (shareToken is set). The recording is still reachable
            programmatically via the JSON API + /api/share/:token/download
            endpoint, but the UI button doesn't belong on a read-only
            external surface —keeps the share view feeling like a
            review experience rather than an asset-extraction page. */}
        {!shareToken && (
          <div className="flex items-center gap-3">
            {downloadError && (
              <span
                className="text-[11px]"
                style={{ color: "var(--color-error)" }}
                title={downloadError}
              >
                {downloadError.length > 40
                  ? downloadError.slice(0, 40) + "…"
                  : downloadError}
              </span>
            )}
            <a
              href="#"
              onClick={handleDownload}
              className="text-[12px] font-medium text-text hover:underline inline-flex items-center gap-1.5"
              title="Download the original recording from cloud storage."
            >
              Download
            </a>
          </div>
        )}
      </div>
      {/* Video frame wrapper —fixed 16:9 aspect-ratio so the panel
          height is stable BEFORE metadata loads. Without this, the
          native <video> element collapses to a thin controls-only
          strip while the file is being fetched, then suddenly
          expands when metadata arrives —produces a layout jump and
          looks like the video is broken. With aspect-video, the
          frame reserves its full height immediately. */}
      <div className="relative w-full bg-black aspect-video">
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          // playsInline keeps the video playing INSIDE our player on
          // mobile Safari. By default, mobile Safari hijacks <video>
          // playback into its native fullscreen viewer the moment the
          // user presses play, which on some sessions silently fails
          // (looks broken —tap play, screen flashes, nothing
          // happens). Inline playback also lets the phase-rail
          // seek-on-click affordance keep working without dropping
          // out of fullscreen between every tap. iOS 10+ honors the
          // standard playsInline; the legacy `webkit-playsinline`
          // alias is unnecessary for any device that can run our app.
          playsInline
          // Suppress the browser's built-in download / picture-in-
          // picture / playback-rate items in the right-click overflow
          // menu — the dedicated Download anchor above gives a single,
          // predictable entry point. controlsList only covers a subset
          // (download / fullscreen / playbackrate / remoteplayback) so
          // we ALSO disable the right-click context menu entirely
          // below. That hides the rest of Chrome's video context menu
          // (Open video in new tab, Save video frame as, Save video
          // as, Copy video frame, Copy video address, Picture in
          // picture, Cast, Search with Google Lens) — items that just
          // confuse end users who only want to play / scrub / seek.
          controlsList="nodownload noplaybackrate noremoteplayback"
          disablePictureInPicture
          onContextMenu={(e) => e.preventDefault()}
          preload="metadata"
          onTimeUpdate={(e) => {
            onTimeUpdate?.((e.target as HTMLVideoElement).currentTime);
            if (loadError) setLoadError(null);
          }}
          onLoadedMetadata={() => setLoadError(null)}
          onError={(e) => {
            // MediaError codes: 1=aborted, 2=network, 3=decode,
            // 4=src_not_supported. Common failure modes:
            //   3 —file is corrupted or codec the browser can't
            //       decode (e.g. WebM with VP9 + Opus on Safari).
            //   4 —URL returned non-media (404 / HTML error page) or
            //       MIME type the browser rejects.
            //   2 —CORS / network —fetch failed or stalled.
            const v = e.currentTarget;
            const code = v.error?.code ?? 0;
            const msg = v.error?.message ?? "";
            const friendly =
              code === 4
                ? "Recording file is missing or in a format this browser can't play."
                : code === 3
                  ? "Recording file is corrupted (the player couldn't decode it)."
                  : code === 2
                    ? "Couldn't reach the recording —check your connection and retry."
                    : "Recording couldn't be loaded.";
            setLoadError(friendly);
            console.warn("[VideoSection] video error", {
              code,
              msg,
              src: v.src?.slice(0, 120),
            });
            // Diagnostic HEAD probe: fetch the URL and log what S3
            // actually returned. Tells us at a glance whether the
            // file is missing (404), has the wrong content-type
            // (S3 stored "application/octet-stream" instead of
            // "video/mp4"), or is mysteriously zero bytes despite
            // the upload-time HeadObject check.
            void (async () => {
              try {
                const r = await fetch(v.src, { method: "HEAD" });
                console.warn("[VideoSection] HEAD probe", {
                  status: r.status,
                  contentType: r.headers.get("content-type"),
                  contentLength: r.headers.get("content-length"),
                  acceptRanges: r.headers.get("accept-ranges"),
                });
              } catch (probeErr) {
                console.warn("[VideoSection] HEAD probe failed", probeErr);
              }
            })();
          }}
          className="absolute inset-0 w-full h-full"
        />
        {/* Error overlay —shown when the video element fired its
            onError event. The onClick re-fetches a fresh signed URL,
            which fixes the most common cause (1h presigned URL
            expired while the past view was sitting open). */}
        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 bg-black/85 text-white">
            <div className="text-[12px] uppercase tracking-wider opacity-70 mb-2">
              Playback unavailable
            </div>
            <div className="text-[14px] max-w-[420px] leading-relaxed mb-4">
              {loadError}
            </div>
            <button
              onClick={onReload}
              className="text-[12px] underline opacity-90 hover:opacity-100"
            >
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Phase Rail —only renders when we have questions to mark.
          Two stacked layers:
            (a) Top row: Q-number chips positioned at each Lead Q's
                start. Clickable to seek.
            (b) Bottom bar: continuous band per Lead Q, from its
                askedAtSeconds to the next Lead Q's start (or session
                end). Probe ticks overlay the band. Red playhead line
                tracks currentTime. */}
      {leads.length > 0 && durationSec > 0 && (
        <div className="border-t border-border bg-surface pt-2 pb-2.5 px-1">
          {/* Q-number chips */}
          <div className="relative h-6 mx-1">
            {leads.map((q, i) => (
              <button
                key={q.id}
                onClick={() => seek(q.askedAtSeconds)}
                title={q.text}
                style={{
                  left: `${pct(q.askedAtSeconds)}%`,
                  fontFamily: "var(--font-mono)",
                }}
                className={`absolute top-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums whitespace-nowrap transition-colors ${
                  i === activeLeadIdx
                    ? "bg-text text-bg"
                    : "bg-bg border border-border text-text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                Q{i + 1}
              </button>
            ))}
          </div>
          {/* Bands + probe ticks + playhead. The active band gets a
              denser fill (text-color at low opacity); inactive bands
              are softer. Mono palette throughout. */}
          <div className="relative h-2.5 mx-1 mt-1 bg-surface-2 rounded-sm overflow-hidden">
            {leads.map((q, i) => {
              const startSec = q.askedAtSeconds;
              const endSec =
                leads[i + 1]?.askedAtSeconds ?? durationSec;
              const left = pct(startSec);
              const width = pct(endSec) - left;
              const isActive = i === activeLeadIdx;
              return (
                <button
                  key={q.id}
                  onClick={() => seek(q.askedAtSeconds)}
                  title={q.text}
                  style={{
                    left: `${left}%`,
                    width: `${width}%`,
                    background: isActive
                      ? "rgba(10, 10, 10, 0.4)"
                      : "rgba(10, 10, 10, 0.12)",
                  }}
                  className="absolute top-0 bottom-0 border-r border-bg transition-colors hover:opacity-80"
                />
              );
            })}
            {/* Probe ticks —thin vertical markers at each probe's
                askedAtSeconds. Sit above the bands so they're
                visible regardless of band density. */}
            {probes.map((p) => (
              <div
                key={p.id}
                title={p.text}
                style={{
                  left: `${pct(p.askedAtSeconds)}%`,
                  background: "rgba(10, 10, 10, 0.6)",
                }}
                className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 pointer-events-none"
              />
            ))}
            {/* Playhead —vertical line at currentTime, using
                --color-error so it visually reads as "the live
                position" without competing with the band fills. */}
            {currentTime > 0 && (
              <div
                style={{
                  left: `${pct(currentTime)}%`,
                  background: "var(--color-error)",
                }}
                className="absolute -top-1 -bottom-1 w-[2px] -translate-x-1/2 pointer-events-none"
              />
            )}
          </div>
          {/* Legend —lightweight one-liner so users know what the
              bands and ticks mean without hovering. */}
          <div className="mt-2 px-1 flex items-center gap-3 text-[10.5px] text-text-subtle">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-3 h-2 rounded-sm"
                style={{ background: "rgba(10, 10, 10, 0.4)" }}
              />
              Lead Q
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-0.5 h-2.5"
                style={{ background: "rgba(10, 10, 10, 0.6)" }}
              />
              Probe
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block w-[2px] h-2.5"
                style={{ background: "var(--color-error)" }}
              />
              Playhead
            </span>
            <span className="ml-auto italic">
              Click any chip or band to jump.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * InterviewTranscript —the rich per-question + listening-hint
 * timeline shown in the Past Session view. Extracted from the inline
 * PastView render so the public share viewer (/share/[token]) can
 * display the same review surface without duplicating the rendering
 * logic.
 *
 * Renders, in order:
 *   1. Standalone "Interviewer's Words" entries for any LISTENING-kind
 *      comments on the first Lead Question whose timestamp predates
 *      Q1 —these capture coaching that fired during the interviewer's
 *      setup talk before any question locked. The "question text"
 *      slot pulls from utterances (filtered to non-candidate within
 *      the comment's surrounding window) so the user sees what the
 *      interviewer was saying when the hint fired.
 *   2. One entry per question with: timestamp + jump chip on the
 *      left, phase chip (Lead / Probe), question text, candidate
 *      answer snippet (italic, vertical-bordered), and AI commentary
 *      including any "Try" / "Full answer" callout block.
 *
 * Click anywhere on a row to seek the recording —when videoRef is
 * provided. In the public share viewer the same affordance still
 * works because the page wires up its own videoRef pointing at the
 * standalone <video> element.
 *
 * Display-only —no store coupling. All inputs are passed through.
 */
export function InterviewTranscript({
  questions,
  utterances,
  speakerRoles,
  videoRef,
  currentTime = 0,
}: {
  questions: Question[];
  utterances: Utterance[];
  /** Map from Deepgram speaker number (as string) —role. Looked up
   *  while filtering utterances for the pre-Q1 hints' interviewer
   *  speech. The share endpoint passes this through as `unknown`
   *  (raw JSONB column) so we accept either shape and probe via
   *  bracket-access at runtime. */
  speakerRoles?: Record<string, "interviewer" | "candidate"> | unknown;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  /** Current playback time in seconds. Drives the "playing" highlight
   *  on the active row. Defaults to 0 (no row highlighted) when the
   *  caller doesn't track playback time. */
  currentTime?: number;
}) {
  const t = useTranslations();

  // Active = latest question whose timestamp is <= currentTime.
  const activeQId = questions.reduce<string | null>((acc, q) => {
    if (q.askedAtSeconds <= currentTime) return q.id;
    return acc;
  }, null);

  // Per-question "show full answer" toggle. Default collapsed (only
  // the 280-char preview shown) so the Transcript stays scannable —
  // a long answer can be 1500+ chars and would dominate the layout
  // if every entry rendered in full. Click to expand. Set is
  // ephemeral (component-local) by design: re-opening Past view from
  // the sidebar collapses everything again, matching how the user
  // typically reviews ("scan first, dig into one or two").
  const [expandedAnswers, setExpandedAnswers] = useState<Set<string>>(
    () => new Set()
  );
  const toggleAnswerExpanded = (qid: string) => {
    setExpandedAnswers((prev) => {
      const next = new Set(prev);
      if (next.has(qid)) next.delete(qid);
      else next.add(qid);
      return next;
    });
  };

  // Speaker-role lookup helper. Accepts the typed Record shape OR a
  // raw object from JSON. Returns "interviewer" / "candidate" /
  // undefined.
  const roleOf = (dgSpeaker: number | undefined) => {
    if (dgSpeaker === undefined || speakerRoles == null) return undefined;
    const map = speakerRoles as Record<string, string | undefined>;
    return map[String(dgSpeaker)] ?? map[dgSpeaker as unknown as string];
  };

  // Find Q1 = the earliest LEAD (non-probe) question. Used for the
  // pre-Q1 listening hints block AND to filter those same hint ids
  // out of Q1's per-question render.
  const leads = questions.filter((q) => !q.parentQuestionId);
  const q1 = leads.length
    ? leads.reduce((earliest, q) =>
        q.askedAtSeconds < earliest.askedAtSeconds ? q : earliest
      )
    : null;
  const preQ1Hints = q1
    ? q1.comments
        .filter(
          (c) => c.kind === "listening" && c.atSeconds < q1.askedAtSeconds
        )
        .sort((a, b) => a.atSeconds - b.atSeconds)
    : [];
  const preQ1ListeningCommentIds = new Set(preQ1Hints.map((c) => c.id));

  // Build a single sorted timeline of "anchor events" — every prior
  // question lock and every prior listening hint. For any listening
  // hint at time T, the "what was the interviewer just saying?" window
  // is bounded BELOW by the most recent anchor before T (otherwise the
  // window would bleed into earlier questions' content), and ABOVE by
  // T + 3s (capture the tail of the sentence the hint reacted to).
  //
  // This anchor model unifies pre-Q1 hints and per-question hints into
  // one piece of logic: pre-Q1 hints get bounded by previous pre-Q1
  // hints (anchor=0 at session start); per-question hints get bounded
  // by the question they were drained onto AND any prior hint within
  // the same question; cross-question buffer hints (drained from the
  // gap between Q_n and Q_{n+1}) get bounded by Q_n's lock time.
  const allHints = questions
    .flatMap((q) => q.comments.filter((c) => c.kind === "listening"))
    .sort((a, b) => a.atSeconds - b.atSeconds);
  const sortedQuestionStarts = questions
    .map((q) => q.askedAtSeconds)
    .sort((a, b) => a - b);

  // Compute the interviewer-speech quote for a single listening hint.
  // Window = [previousAnchor, hint.atSeconds + 3s] where previousAnchor
  // is the latest event before `hint.atSeconds` in the merged timeline
  // of question locks + prior hints. Falls back to 0 when the hint is
  // before any anchor (i.e. very early in the session).
  function speechForHint(hintAtSec: number): string {
    let prevAnchor = 0;
    for (const t of sortedQuestionStarts) {
      if (t < hintAtSec) prevAnchor = Math.max(prevAnchor, t);
    }
    for (const h of allHints) {
      if (h.atSeconds < hintAtSec) {
        prevAnchor = Math.max(prevAnchor, h.atSeconds);
      }
    }
    const windowEnd = hintAtSec + 3;
    const rawSpeech = utterances
      .filter((u) => {
        if (u.atSeconds < prevAnchor) return false;
        if (u.atSeconds > windowEnd) return false;
        // Anyone NOT explicitly tagged as candidate is assumed to be
        // the interviewer for the purposes of this quote. Reverse-Q&A
        // is a separate phase where this assumption flips, but
        // listening hints don't fire there (they're keyed to
        // interviewer monologue) so it's safe.
        return roleOf(u.dgSpeaker) !== "candidate";
      })
      .map((u) => u.text.trim())
      .join(" ");
    return tidyInterviewerQuote(rawSpeech);
  }

  // Same snapshot-vs-time-window precedence as the per-question render
  // below: prefer the AI's actual monologue snapshot (contextText)
  // when available, fall back to the time-window heuristic only for
  // legacy hints that predate the column. The label changes accordingly
  // — "Interviewer mentioned" for snapshots, "Interviewer's words" for
  // the legacy reconstructed quote.
  const preQ1Entries = preQ1Hints.map((c) => {
    const hasSnapshot = !!c.contextText?.trim();
    const speech = hasSnapshot
      ? tidyInterviewerQuote(c.contextText!)
      : speechForHint(c.atSeconds);
    return { hint: c, interviewerSpeech: speech, hasSnapshot };
  });

  return (
    <>
      {preQ1Entries.map(({ hint: c, interviewerSpeech, hasSnapshot }) => {
        const { commentary } = splitCommentary(c.text);
        const fullSuggestion = c.expandedSuggestion?.trim();
        const isExpanded = !!fullSuggestion;
        return (
          <div
            key={c.id}
            onClick={() => {
              if (videoRef?.current) {
                videoRef.current.currentTime = c.atSeconds;
                void videoRef.current.play().catch(() => {
                  /* ignore */
                });
              }
            }}
            className="pv-entry flex gap-3 sm:gap-4 py-5 border-t border-border first:border-t-0 -mx-3 px-3 rounded-md cursor-pointer transition-colors hover:bg-surface"
          >
            {/* Desktop-only fixed timestamp column. On mobile (<sm)
                the column is hidden and the timestamp is rendered
                inline next to the chip below — saves the 58px of
                whitespace that crowds the right column on narrow
                viewports. */}
            <div className="hidden sm:block shrink-0 w-[58px] pt-0.5">
              <div
                className="text-[13px] font-medium tabular-nums text-text"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {fmt(c.atSeconds)}
              </div>
              <div className="print:hidden text-[10px] text-text-subtle mt-0.5 flex items-center gap-1">
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M2 1.5v5l3.5-2.5z" />
                </svg>
                {t("jump", "跳转")}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              {/* Mobile-only inline timestamp. Pre-Q1 entries don't
                  have a question-type chip alongside it (unlike the
                  per-question rows below) so the timestamp gets its
                  own row at the top with a small Listening Hint
                  marker for context. */}
              <div className="sm:hidden mb-2">
                <span
                  className="text-[12px] font-medium tabular-nums text-text-subtle"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {fmt(c.atSeconds)}
                </span>
              </div>
              {/* Interviewer's Words quote block — UNIFIED with the
                  per-question hint rendering below so the visual
                  treatment of "Interviewer's Words + Listening Hint"
                  is identical wherever it shows up in the transcript.
                  Previously the Pre-Q1 entries used a chip + bold
                  question-style typography (looked like a heading)
                  while the per-question entries used a gray quote box
                  (looked like supporting context). The latter is more
                  semantically correct — the interviewer's words are
                  CONTEXT for the listening hint, not the main subject
                  — and the user flagged the inconsistency as confusing. */}
              <div
                className="mb-2 px-3 py-2 rounded-md"
                style={{
                  background: "var(--color-surface)",
                  borderLeft: "2px solid var(--color-border)",
                }}
              >
                <div
                  className="text-[10px] font-medium uppercase tracking-wider mb-1"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {hasSnapshot
                    ? t("Interviewer mentioned", "面试官提到")
                    : t("Interviewer's words", "面试官原话")}
                </div>
                {interviewerSpeech ? (
                  <div className="text-[13.5px] leading-snug text-text-muted">
                    {interviewerSpeech}
                  </div>
                ) : (
                  <div className="text-[12.5px] text-text-subtle italic">
                    {t(
                      "(no transcript captured for this segment)",
                      "（这段未捕获到文本）"
                    )}
                  </div>
                )}
              </div>
              <div className="text-[14.5px] leading-relaxed text-text">
                <div
                  className="text-[10px] font-medium uppercase tracking-wider mb-1.5"
                  style={{ color: "var(--color-warning)" }}
                >
                  {t("Listening hint", "聆听提示")}
                </div>
                {commentary && (
                  <p
                    className="prose-live"
                    dangerouslySetInnerHTML={{ __html: commentary }}
                  />
                )}
                {fullSuggestion && (
                  <div
                    className="mt-2.5 rounded-md px-3.5 py-2.5"
                    style={{
                      background: "var(--color-bg)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-text">
                        {isExpanded
                          ? t("Full answer", "完整作答")
                          : t(
                              "Quick hint (full answer generating—",
                              "速记提示（完整答案生成中…）"
                            )}
                      </div>
                    </div>
                    {(() => {
                      const paragraphs = fullSuggestion
                        .split(/\n\s*\n/)
                        .map((p) => p.trim())
                        .filter((p) => p.length > 0);
                      const baseClass =
                        "text-[13.5px] leading-relaxed text-text-muted prose-live " +
                        (isExpanded ? "" : "italic");
                      return paragraphs.map((p, i) => (
                        <p
                          key={i}
                          className={
                            baseClass +
                            (i < paragraphs.length - 1 ? " mb-2.5" : "")
                          }
                          dangerouslySetInnerHTML={{ __html: p }}
                        />
                      ));
                    })()}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {questions.length === 0 && (
        <div className="text-[13px] text-text-subtle italic py-6">
          {t(
            "No interviewer questions were detected for this session.",
            "本次会话未检测到面试官的提问。"
          )}
        </div>
      )}

      {/* Render order: chronological by askedAtSeconds across all
          kinds (interviewer Lead / Probe and candidate reverse-Q&A
          questions interleave naturally — case prompts at minute 18,
          then 30+ minutes of Q-A, then candidate questions at minute
          54+). Sort once here so the Transcript reads as a single
          time-ordered story rather than "all interviewer first, then
          all candidate". */}
      {questions
        .slice()
        .sort((a, b) => a.askedAtSeconds - b.askedAtSeconds)
        .map((q) => {
        const isPlaying = q.id === activeQId;
        const isProbe = !!q.parentQuestionId;
        const isCandidateQ = q.kind === "candidate";
        const answerSnippet = (q.answerText || "").trim();
        const ANSWER_PREVIEW_CAP = 280;
        const answerNeedsExpand = answerSnippet.length > ANSWER_PREVIEW_CAP;
        const answerExpanded = expandedAnswers.has(q.id);
        const answerPreview =
          answerNeedsExpand && !answerExpanded
            ? answerSnippet.slice(0, ANSWER_PREVIEW_CAP).trim() + "…"
            : answerSnippet;
        return (
          <div
            key={q.id}
            onClick={() => {
              if (videoRef?.current) {
                videoRef.current.currentTime = q.askedAtSeconds;
                void videoRef.current.play().catch(() => {
                  /* ignore —autoplay blocked, user can press play */
                });
              }
            }}
            className={`pv-entry flex gap-3 sm:gap-4 py-5 border-t border-border first:border-t-0 -mx-3 px-3 rounded-md cursor-pointer transition-colors ${
              isPlaying ? "bg-surface-2" : "hover:bg-surface"
            }`}
          >
            {/* Desktop-only fixed timestamp column. Hidden on mobile
                — see pre-Q1 block above for rationale. */}
            <div className="hidden sm:block shrink-0 w-[58px] pt-0.5">
              <div
                className="text-[13px] font-medium tabular-nums text-text"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {fmt(q.askedAtSeconds)}
              </div>
              <div className="print:hidden text-[10px] text-text-subtle mt-0.5 flex items-center gap-1">
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M2 1.5v5l3.5-2.5z" />
                </svg>
                {isPlaying ? t("playing", "播放中") : t("jump", "跳转")}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center flex-wrap gap-2 mb-2">
                {/* Mobile-only inline timestamp — shares the chip
                    row so the chip + time fit in one line. */}
                <span
                  className="sm:hidden text-[12px] font-medium tabular-nums text-text-subtle"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {fmt(q.askedAtSeconds)}
                </span>
                {/* Three chip styles, one per kind:
                    - Lead Question:  solid black (highest visual rank)
                    - Probe Question: gray surface (sub-question of Lead)
                    - Candidate Q:    inverted with a colored accent so
                                      the reverse-Q&A visually flips —
                                      reader instantly knows the Q came
                                      from the candidate not interviewer. */}
                <span
                  className={`inline-block text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded ${
                    isCandidateQ
                      ? "bg-bg text-text border border-text"
                      : isProbe
                        ? "bg-surface-2 text-text-muted"
                        : "bg-text text-bg"
                  }`}
                >
                  {isCandidateQ
                    ? t("Candidate's Question", "候选人提问")
                    : isProbe
                      ? t("Probe Question", "追问")
                      : t("Lead Question", "主问题")}
                </span>
              </div>
              <div className="text-[1.0625rem] font-medium leading-snug mb-3 text-text">
                {q.text}
              </div>
              {/* Answer block ONLY for interviewer-asked questions —
                  candidate questions have no "answer" surface (the
                  interviewer's verbal answer isn't structured today;
                  see types/session.ts Question.kind docblock). */}
              {!isCandidateQ &&
                (answerPreview ? (
                  <div className="mb-3 pl-3 border-l-2 border-border">
                    <div className="text-[10px] font-medium uppercase tracking-wider text-text-subtle mb-1">
                      {t("Candidate's answer", "候选人回答")}
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-text-muted italic whitespace-pre-wrap">
                      {answerPreview}
                    </p>
                    {answerNeedsExpand && (
                      // Expand / collapse toggle for long answers.
                      // stopPropagation: the parent row has an onClick
                      // that seeks the video to the question timestamp;
                      // without this, expanding the answer would also
                      // re-seek and start playback, which is jarring
                      // when the user just wants to read more.
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleAnswerExpanded(q.id);
                        }}
                        className="mt-1.5 text-[12px] font-medium underline-offset-2 hover:underline"
                        style={{ color: "var(--color-text)" }}
                      >
                        {answerExpanded
                          ? t("Show less", "收起")
                          : t("Show full answer", "展开完整回答")}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="mb-3 text-[12.5px] text-text-subtle italic">
                    {t(
                      "No answer text captured for this question.",
                      "本题未捕获到回答文本。"
                    )}
                  </div>
                ))}
              <div className="text-[14.5px] leading-relaxed text-text">
                {(() => {
                  const visibleComments = q.comments.filter(
                    (c) => !preQ1ListeningCommentIds.has(c.id)
                  );
                  if (visibleComments.length === 0) {
                    return (
                      <p className="text-text-subtle italic">
                        {t("No commentary.", "无评论。")}
                      </p>
                    );
                  }
                  return visibleComments
                    .slice()
                    .sort((a, b) => a.atSeconds - b.atSeconds)
                    .map((c) => {
                      const { commentary, suggestion } = splitCommentary(c.text);
                      const fullSuggestion =
                        c.expandedSuggestion?.trim() || suggestion;
                      const isExpanded = !!c.expandedSuggestion?.trim();
                      const isListeningHint = c.kind === "listening";
                      const isCandQCmt = c.kind === "cand-q-cmt";
                      // For listening hints, render the interviewer's
                      // ACTUAL monologue snapshot the AI saw (when
                      // available) — that's the substantive content
                      // the coaching reacted to. The time-window
                      // fallback (speechForHint) catches utterances
                      // around the hint's atSeconds, but the tail of
                      // a monologue is usually transitional filler
                      // ("Okay. Yeah.") which is actively misleading
                      // when shown as "what the interviewer was
                      // saying". The snapshot path matches the model's
                      // input verbatim, so the rendered quote can
                      // never disagree with the coaching.
                      //
                      // Legacy listening hints (persisted before the
                      // context_text column landed in May 2026) still
                      // use the time-window method — best-effort, but
                      // we label them differently so the user knows
                      // it's a reconstruction rather than ground truth.
                      const hintHasSnapshot =
                        isListeningHint && !!c.contextText?.trim();
                      const interviewerSpeech = isListeningHint
                        ? hintHasSnapshot
                          ? tidyInterviewerQuote(c.contextText!)
                          : speechForHint(c.atSeconds)
                        : "";
                      return (
                        <div key={c.id} className="mb-4 last:mb-0">
                          {isCandQCmt && (
                            // Distinct accent color for cand-q-cmt — uses
                            // the success/positive variable (typically a
                            // teal/green) to differentiate from the
                            // warning-yellow used for listening hints.
                            // Reader scanning the Transcript can tell at
                            // a glance which kind of coaching this was
                            // ("AI rated MY question" vs "AI heard the
                            // interviewer's monologue").
                            <div
                              className="text-[10px] font-medium uppercase tracking-wider mb-1.5"
                              style={{ color: "var(--color-success, #0a7a52)" }}
                            >
                              {t("Question quality", "问题质量")}
                            </div>
                          )}
                          {isListeningHint && (
                            <>
                              {/* Interviewer's words quote — what was
                                  being said when the hint fired. The
                                  light gray block + small label set it
                                  apart from the AI commentary below
                                  without competing visually with the
                                  question text above. Mobile renders
                                  identically (no layout switch needed
                                  — the block is full-width). */}
                              <div
                                className="mb-2 px-3 py-2 rounded-md"
                                style={{
                                  background: "var(--color-surface)",
                                  borderLeft: "2px solid var(--color-border)",
                                }}
                              >
                                <div
                                  className="text-[10px] font-medium uppercase tracking-wider mb-1"
                                  style={{ color: "var(--color-text-muted)" }}
                                >
                                  {hintHasSnapshot
                                    ? t(
                                        "Interviewer mentioned",
                                        "面试官提到"
                                      )
                                    : t(
                                        "Interviewer's words",
                                        "面试官原话"
                                      )}
                                </div>
                                {interviewerSpeech ? (
                                  <div className="text-[13.5px] leading-snug text-text-muted">
                                    {interviewerSpeech}
                                  </div>
                                ) : (
                                  <div className="text-[12.5px] text-text-subtle italic">
                                    {t(
                                      "(no transcript captured for this segment)",
                                      "（这段未捕获到文本）"
                                    )}
                                  </div>
                                )}
                              </div>
                              <div
                                className="text-[10px] font-medium uppercase tracking-wider mb-1.5"
                                style={{ color: "var(--color-warning)" }}
                              >
                                {t("Listening hint", "聆听提示")}
                              </div>
                            </>
                          )}
                          {commentary && (
                            <p
                              className="prose-live"
                              dangerouslySetInnerHTML={{ __html: commentary }}
                            />
                          )}
                          {fullSuggestion && (
                            <div
                              className="mt-2.5 rounded-md px-3.5 py-2.5"
                              style={{
                                background: "var(--color-bg)",
                                border: "1px solid var(--color-border)",
                              }}
                            >
                              <div className="flex items-baseline justify-between gap-2 mb-1.5">
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-text">
                                  {isExpanded
                                    ? t("Full answer", "完整作答")
                                    : t(
                                        "Quick hint (full answer generating—",
                                        "速记提示（完整答案生成中…）"
                                      )}
                                </div>
                                {!isExpanded && (
                                  <span className="inline-flex gap-[2px] shrink-0 mt-1">
                                    <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot" />
                                    <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.15s]" />
                                    <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.3s]" />
                                  </span>
                                )}
                              </div>
                              {(() => {
                                const paragraphs = fullSuggestion
                                  .split(/\n\s*\n/)
                                  .map((p) => p.trim())
                                  .filter((p) => p.length > 0);
                                const baseClass =
                                  "text-[13.5px] leading-relaxed text-text-muted prose-live " +
                                  (isExpanded ? "" : "italic");
                                return paragraphs.map((p, i) => (
                                  <p
                                    key={i}
                                    className={
                                      baseClass +
                                      (i < paragraphs.length - 1
                                        ? " mb-2.5"
                                        : "")
                                    }
                                    dangerouslySetInnerHTML={{ __html: p }}
                                  />
                                ));
                              })()}
                            </div>
                          )}
                        </div>
                      );
                    });
                })()}
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function PastView() {
  const t = useTranslations();
  const selectedPastId = useStore((s) => s.selectedPastId);
  const pastSessions = useStore((s) => s.pastSessions);
  const pastSessionList = useStore((s) => s.pastSessionList);
  const loadPastSession = useStore((s) => s.loadPastSession);
  const setPastSessionScore = useStore((s) => s.setPastSessionScore);
  // userId is required by requestPlaybackUrl (auth header). When
  // user signs in optimistically, userId is undefined for the first
  // ~15-30s while /api/users/upsert + Aurora wakes —we depend on it
  // explicitly in the video-URL effect below so the effect re-runs
  // once userId arrives, instead of locking in null and never
  // recovering.
  const userId = useStore((s) => s.user?.userId);

  const setPastSessionScoreError = useStore(
    (s) => s.setPastSessionScoreError
  );
  const session = pastSessions.find((s) => s.id === selectedPastId);

  // Phase 2: when the sidebar selects a session that's only in
  // pastSessionList (server-known but not yet locally hydrated),
  // fetch its full detail. Once the GET returns, loadPastSession
  // pushes it into pastSessions and the find() above resolves.
  useEffect(() => {
    if (!selectedPastId) return;
    if (session) return;
    const inList = pastSessionList.some((p) => p.id === selectedPastId);
    if (!inList) return;
    void loadPastSession(selectedPastId);
  }, [selectedPastId, session, pastSessionList, loadPastSession]);

  // Phase 3: derive the effective video URL.
  //
  // Priority order:
  //   1. session.videoUrl  —in-memory blob URL from the just-ended
  //      live session in this tab. Plays instantly; no S3 round-trip.
  //   2. session.videoS3Key set —sign a fresh GET URL via
  //      /api/uploads/get and use that. Survives reloads / cross-
  //      device opens. URL TTL is 1h.
  //
  // We don't currently auto-renew on expiry —a user watching a 1h+
  // recording would need to refresh. (Audio-only sessions have no
  // playback UI today; AudioPlayer was removed in a recent commit.
  // The audio_s3_key still gets stored so we can wire playback back
  // in later without re-uploading.)
  const [signedVideoUrl, setSignedVideoUrl] = useState<string | null>(null);
  // Bumped by VideoSection's "Try again" button —re-fires the signing
  // effect to fetch a FRESH presigned URL. The most common cause of
  // a video failing to play is the 1h URL TTL expiring while the
  // past view sits open; a fresh sign recovers without a hard
  // refresh.
  const [videoSignNonce, setVideoSignNonce] = useState(0);
  useEffect(() => {
    setSignedVideoUrl(null);
    if (!session) return;
    if (session.videoUrl) return;
    if (!session.videoS3Key) return;
    // Wait for userId. requestPlaybackUrl returns null when userId
    // is undefined (no auth header), so firing without it just
    // wastes a render. The deps include userId so this effect
    // re-runs the moment upsertUser lands and userId becomes
    // defined.
    if (!userId) return;
    let aborted = false;
    void (async () => {
      const { requestPlaybackUrl } = await import("@/lib/client-api");
      const url = await requestPlaybackUrl({
        sessionId: session.id,
        kind: "video",
      });
      if (!aborted && url) setSignedVideoUrl(url);
    })();
    return () => {
      aborted = true;
    };
  }, [
    session?.id,
    session?.videoUrl,
    session?.videoS3Key,
    userId,
    videoSignNonce,
  ]);

  const effectiveVideoUrl = session?.videoUrl ?? signedVideoUrl ?? undefined;

  // Lazy-fetch utterances for the EmptySession check + transcript
  // fallback. Sessions where Deepgram captured speech but the
  // classifier never locked a Question (short sessions, mic
  // disambiguation glitches, etc.) end up with questions=[] but
  // utterances populated. Without this fetch, PastView would render
  // the EmptySession card and an empty Transcript section even
  // though there's clear content the user spoke.
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  // Tracks whether the utterance fetch has resolved for the current
  // session. Without this, the empty-state decision races: on first
  // render `utterances` is [] not because the session has none but
  // because the fetch hasn't completed. The render path saw
  // (noQuestions && noUtterances) and briefly flashed the EmptySession
  // card BEFORE flipping to "Not Scored" once utterances arrived.
  // Gating the empty-state branch on `utterancesLoaded` keeps the
  // page in a quiet "not yet" state until we actually know what the
  // session contains.
  const [utterancesLoaded, setUtterancesLoaded] = useState(false);
  useEffect(() => {
    setUtterances([]);
    setUtterancesLoaded(false);
    if (!session) return;
    if (!userId) return;
    let aborted = false;
    void (async () => {
      const { fetchSessionUtterances } = await import("@/lib/client-api");
      const list = await fetchSessionUtterances(session.id);
      if (!aborted) {
        setUtterances(list);
        setUtterancesLoaded(true);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [session?.id, userId]);
  // currentTime is updated by the video element's onTimeUpdate via
  // VideoSection. Drives "currently playing" highlight on the
  // Interview Transcript entries. videoRef gives the entry click
  // handlers a way to set currentTime (= seek the video).
  const [currentTime, setCurrentTime] = useState(0);
  // Refresh state lives in the store keyed by sessionId — NOT in
  // component-level useState — so a re-score that's in-flight stays
  // attached to the original session even when the user switches to
  // another past session in the sidebar. Without this, switching
  // away mid-fetch would (a) phantom-show the spinner on whichever
  // session is now displayed, and (b) block the user from re-scoring
  // the new session until the old request landed (the local
  // isRefreshing guard inside refreshScore would short-circuit).
  // See store.refreshingSessionIds + markRefreshStart/Done.
  const refreshingSessionIds = useStore((s) => s.refreshingSessionIds);
  const markRefreshStart = useStore((s) => s.markRefreshStart);
  const markRefreshDone = useStore((s) => s.markRefreshDone);
  const isRefreshing = refreshingSessionIds.has(selectedPastId ?? "");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Clear inline refresh-error banner when switching sessions. The
  // error belongs to whichever session was open WHEN the failed
  // re-score fired — phantom-displaying it on a different session is
  // confusing. Persisted score_error on the session row still shows
  // its own failure card if applicable.
  useEffect(() => {
    setRefreshError(null);
  }, [selectedPastId]);

  // Share-link state. The kebab menu's "Copy Link" item mints a token
  // (idempotent server-side) and immediately writes the viewer URL to
  // the clipboard, surfacing a brief "Link Copied" toast at the top of
  // the page. We pre-fetch any existing live share on session change so
  // the click is instant when a token already exists. There's no inline
  // panel / Revoke affordance on the regular owner UX —a single
  // copy-and-go action is all the surface we want here.
  const [share, setShare] = useState<SessionShare | null>(null);
  const [linkCopied, setLinkCopied] = useState<
    | null
    | { kind: "ok" }
    | { kind: "err"; message: string }
  >(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const copyToastTimerRef = useRef<number | null>(null);

  // Outside-click closes the kebab menu. Skips when the click target
  // is inside the menu's wrapper so item clicks don't race the close.
  useEffect(() => {
    if (!actionsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!actionsRef.current?.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [actionsOpen]);

  // Re-fetch existing share whenever the user opens a different
  // past session. Failures (network, server) just leave share=null —  // the next Copy Link click mints a new token via the server-side
  // idempotent path. Pre-fetching matters because it lets a click
  // skip the network roundtrip when a token already exists.
  useEffect(() => {
    if (!session?.id) {
      setShare(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const existing = await getSessionShare(session.id);
      if (!cancelled) setShare(existing);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.id]);

  /** Show the "Link Copied" toast for ~2s, replacing any pending
   *  hide-timer so rapid double-clicks don't blink the toast off
   *  mid-display. Cleared by component unmount via the cleanup effect
   *  below. */
  const flashCopyToast = (
    state: { kind: "ok" } | { kind: "err"; message: string }
  ) => {
    if (copyToastTimerRef.current !== null) {
      window.clearTimeout(copyToastTimerRef.current);
      copyToastTimerRef.current = null;
    }
    setLinkCopied(state);
    copyToastTimerRef.current = window.setTimeout(() => {
      setLinkCopied(null);
      copyToastTimerRef.current = null;
    }, 2200);
  };

  // Cleanup the toast timer on unmount so a stale setTimeout doesn't
  // try to setState on an already-unmounted component (React warns).
  useEffect(() => {
    return () => {
      if (copyToastTimerRef.current !== null) {
        window.clearTimeout(copyToastTimerRef.current);
        copyToastTimerRef.current = null;
      }
    };
  }, []);

  /** Click handler for "Copy Link" in the kebab menu. Mints a token
   *  if none exists, then writes the viewer URL to the clipboard and
   *  flashes the top-of-page toast. The destination is the public
   *  viewer page (/share/<token>), not the JSON API —that's what an
   *  end-recipient pasted into a browser actually wants. */
  const handleCopyLink = async () => {
    if (!session?.id) return;
    setActionsOpen(false);
    let live = share;
    if (!live) {
      const result = await createSessionShare(session.id);
      if ("error" in result) {
        flashCopyToast({ kind: "err", message: result.error });
        return;
      }
      live = result;
      setShare(result);
    }
    try {
      await navigator.clipboard.writeText(live.viewerUrl);
      flashCopyToast({ kind: "ok" });
    } catch {
      // Clipboard blocked (rare —user denied permission, or
      // non-secure context). Surface a fallback message rather than
      // silently failing so the user knows the URL was minted but
      // they need to copy from somewhere else.
      flashCopyToast({
        kind: "err",
        message: "Clipboard blocked —try again or copy manually.",
      });
    }
  };

  /** Export-PDF handler —extracted from the inline button onClick so
   *  the kebab menu item can call it directly. Same logic as before:
   *  swap document.title (Chrome's filename source) —window.print()
   *  —restore on afterprint. */
  const handleExportPdf = () => {
    if (!session) return;
    setActionsOpen(false);
    const original = document.title;
    const safe = (session.title || "Interview Session")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    const stamp = new Date(session.startedAt).toISOString().slice(0, 10);
    document.title = `${safe || "Interview Session"} —${stamp}`;
    const restore = () => {
      document.title = original;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };
  // Per-session "have we tried auto-refresh yet" flag. Without this,
  // the lazy auto-refresh effect below would re-fire after every
  // render that happens between the fetch starting and the score
  // landing —the dependency on session?.score would re-trigger the
  // effect when score transitions from undefined to set. Keying on
  // session.id gives us "once per opened session, max".
  const autoScoredRef = useRef<string | null>(null);

  // Re-fire /api/score-session against the same Session payload. Keeps
  // the existing score visible until the new one lands (no flicker to
  // the loading strip). On failure, surfaces a small error line under
  // the card AND writes the error onto the Session's `scoreError` so
  // the persistent failure UI renders even if the user navigates away
  // and back. Mirrors the original post-end-of-session call in
  // app/page.tsx with matching error handling.
  const refreshScore = async () => {
    if (!session) return;
    // Per-session guard: only block if THIS session is already
    // refreshing. Switching to a different session that has its own
    // refresh in flight no longer blocks this click.
    if (refreshingSessionIds.has(session.id)) return;
    // Capture the sessionId at fire time. The closure keeps using
    // `sessionAtFire` for all post-fetch writes (setPastSessionScore,
    // markRefreshDone, etc.) — even if the user navigates away,
    // results land on the original session and the spinner clears
    // for the right id.
    const sessionAtFire = session.id;
    markRefreshStart(sessionAtFire);
    setRefreshError(null);
    console.log("[scoring] refresh", {
      sessionId: sessionAtFire,
      questions: session.questions.length,
    });
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 90_000);
      let resp: Response;
      try {
        resp = await fetch("/api/score-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            // sessionId enables session_events breadcrumbs on the
            // server (begin / override-misjudged-insufficient /
            // complete / fatal-error). Re-score click attempts also
            // get logged so we can correlate "user clicked Re-score
            // 6 times" with the verdicts emitted each call.
            sessionId: session.id,
            jd: session.jd,
            resume: session.resume,
            questions: session.questions,
            durationSeconds: session.durationSeconds,
            // Re-score in whatever language the user is currently
            // set to. Lets the user toggle CN→EN and refresh an old
            // session's score in English without re-running the
            // interview.
            lang: useStore.getState().commentLang,
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!resp.ok) {
        let detail = "";
        try {
          const errBody = (await resp.json()) as {
            error?: string;
            body?: string;
          };
          detail = errBody.error || errBody.body || "";
        } catch {
          /* not json */
        }
        throw new Error(
          detail
            ? `Score request failed (HTTP ${resp.status}): ${detail}`
            : `Score request failed (HTTP ${resp.status})`
        );
      }
      const data = (await resp.json()) as { score?: SessionScore };
      if (data.score) {
        setPastSessionScore(sessionAtFire, data.score);
      } else {
        throw new Error("No score returned from server");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Re-score failed";
      // console.warn (not error) — handled gracefully via the
      // Re-score button in the UI; no need to trigger Next dev's
      // Issue badge.
      console.warn("[scoring] refresh failed:", msg);
      // Only show the inline error banner if the user is still
      // viewing the session that errored. Switching away mid-fetch
      // shouldn't pop a banner on whatever session they're now
      // looking at — that error belongs to the original session.
      if (session && session.id === sessionAtFire) {
        setRefreshError(msg);
      }
      // Persist the failure on the Session so the failure card shows
      // even after navigating away and back.
      setPastSessionScoreError(sessionAtFire, msg);
    } finally {
      markRefreshDone(sessionAtFire);
    }
  };

  // Layer-2 lazy auto-refresh: when a saved session has CONTENT but
  // no score AND no scoreError, scoring never ran (or got lost on an
  // early bug path). Fire refreshScore once when the user opens it
  // so the spinner actually means "scoring in progress" rather than
  // "scoring stuck forever". Empty sessions (Layer 3 below) never
  // reach this —they short-circuit to EmptySessionCard.
  useEffect(() => {
    if (!session) return;
    if (autoScoredRef.current === session.id) return;
    if (session.score) return;
    if (session.scoreError) return;
    // Skip auto-refresh for sessions with no graded questions OR
    // very short ones —no model can produce a useful score from
    // zero questions, and a <10s session is almost certainly an
    // accidental Start+End.
    if (session.questions.length === 0 || session.durationSeconds < 10) return;
    autoScoredRef.current = session.id;
    void refreshScore();
    // refreshScore is stable enough —defined inline but only deps
    // are state setters and `session` itself; the autoScoredRef
    // guard prevents re-fire on the score-landing re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    session?.id,
    session?.score,
    session?.scoreError,
    session?.questions.length,
    session?.durationSeconds,
  ]);

  if (!session) {
    // Distinguish "still loading from server" from "genuinely missing":
    //   - In pastSessionList —user clicked an entry the sidebar
    //     already knows about; loadPastSession() is fetching its
    //     full detail. Show a soft loading state, NOT a scary
    //     "Session not found" flash.
    //   - Not in either list —session actually doesn't exist
    //     (deleted, or stale ID lingering from somewhere). Show
    //     the missing-state.
    const isLoading =
      selectedPastId !== null &&
      pastSessionList.some((p) => p.id === selectedPastId);
    return (
      <div className="flex-1 flex items-center justify-center text-ink-lighter">
        {isLoading ? "Loading session…" : "Session not found."}
      </div>
    );
  }

  // Find the question whose timestamp is nearest-before the current playback time.
  const activeQId = session.questions.reduce<string | null>((acc, q) => {
    if (q.askedAtSeconds <= currentTime) return q.id;
    return acc;
  }, null);

  const dateStr = new Date(session.startedAt).toLocaleDateString(
    t("en-US", "zh-CN"),
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  return (
    <>
      <div className="mx-auto w-full max-w-[920px] px-24 pt-10 pb-5 max-[900px]:px-5 max-[900px]:pt-6 max-[900px]:pb-3 shrink-0 print:px-0 print:pt-0 print:pb-3 print:max-w-none">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {/* In-app page heading. The default <h1> rule in
                globals.css is sized for the marketing hero
                (clamp 32-52px) —too big for a working surface
                where the title is just a label, not the moment.
                Override down to a comfortable page-title scale
                (~28px). Keeps the design-system letter-spacing
                and weight 600. */}
            <h1
              style={{
                fontSize: "1.75rem",
                lineHeight: 1.2,
                letterSpacing: "-0.02em",
              }}
            >
              {session.title}
            </h1>
            <div className="text-[13px] text-text-subtle mt-2" style={{ fontFamily: "var(--font-mono)" }}>
              {dateStr} · {fmt(session.durationSeconds)}
            </div>
          </div>
          {/* Actions menu. Icon-only ghost button (32×32, no border,
              transparent until hover) —same visual language as the
              Sidebar's "More options" affordance on past-session
              rows, just sized up so it balances the page title. The
              previous version used `btn btn-secondary btn-sm` which
              forced a min-width / visible border / pill shape that
              looked wrong as a single-icon control next to a 28px
              title. Horizontal dots (vs. vertical) read more clearly
              as "more actions" in a header context. */}
          <div className="relative shrink-0 print:hidden" ref={actionsRef}>
            <button
              type="button"
              onClick={() => setActionsOpen((v) => !v)}
              className={`w-8 h-8 grid place-items-center rounded-md transition-colors ${
                actionsOpen
                  ? "bg-surface text-text"
                  : "text-text-muted hover:bg-surface hover:text-text"
              }`}
              aria-label={t("Session actions", "更多操作")}
              aria-expanded={actionsOpen}
              title={t("Share, export, …", "分享、导出 …")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="3.5" cy="8" r="1.4" />
                <circle cx="8" cy="8" r="1.4" />
                <circle cx="12.5" cy="8" r="1.4" />
              </svg>
            </button>
            {actionsOpen && (
              <div
                className="absolute right-0 mt-1 bg-bg border border-border-strong rounded-md p-1 z-[60]"
                style={{
                  minWidth: 200,
                  boxShadow: "var(--shadow-lg)",
                }}
              >
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="w-full text-left text-sm px-2.5 py-1.5 rounded hover:bg-surface"
                >
                  {t("Copy Link", "复制链接")}
                </button>
                <button
                  type="button"
                  onClick={handleExportPdf}
                  className="w-full text-left text-sm px-2.5 py-1.5 rounded hover:bg-surface"
                >
                  {t("Export PDF", "导出 PDF")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* "Link Copied" toast. Fixed at top-center of the viewport so
          it's visible regardless of where in the Past Session page the
          user clicked the kebab. Slides down + fades in via the
          .toast-flash CSS animation; auto-hides after ~2s via the
          flashCopyToast timer. Print-hidden so the toast can't bleed
          into a same-time PDF export. */}
      {linkCopied && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] print:hidden toast-flash"
          role="status"
          aria-live="polite"
        >
          <div
            className="px-4 py-2 rounded-md text-sm border flex items-center gap-2"
            style={{
              background:
                linkCopied.kind === "ok"
                  ? "var(--color-bg)"
                  : "rgba(178, 58, 58, 0.06)",
              borderColor:
                linkCopied.kind === "ok"
                  ? "var(--color-border-strong)"
                  : "rgba(178, 58, 58, 0.3)",
              color:
                linkCopied.kind === "ok"
                  ? "var(--color-text)"
                  : "var(--color-error)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {linkCopied.kind === "ok" ? (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3 8.5 6.5 12 13 4.5" />
                </svg>
                <span>{t("Link Copied", "链接已复制")}</span>
              </>
            ) : (
              <span>{linkCopied.message}</span>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto pv-scroll">
        <div className="mx-auto w-full max-w-[920px] px-24 pt-5 pb-40 max-[900px]:px-5 print:px-0 print:pt-2 print:pb-0 print:max-w-none">
          {(() => {
            // EmptySession is shown when there's nothing to grade
            // AND nothing to transcribe. A session with utterances
            // captured but no locked Questions (classifier didn't
            // form question structures —common on short sessions
            // or fast-spoken intros) still has reviewable content
            // and renders below as a Raw Transcript.
            const noQuestions = session.questions.length === 0;
            const tooShort = session.durationSeconds < 10;
            const noUtterances = utterances.length === 0;
            // Don't decide "empty session" until utterances have
            // been fetched. utterances starts as [] on mount and
            // turns into the real list once fetchSessionUtterances
            // resolves; gating on `utterancesLoaded` means we
            // never flash the EmptySession card during that
            // ~100-300ms window. Sessions with `tooShort` are
            // definitively empty regardless of the fetch state,
            // so they short-circuit immediately.
            const isEmpty =
              tooShort || (utterancesLoaded && noQuestions && noUtterances);
            if (isEmpty) {
              return (
                <EmptySessionCard durationSeconds={session.durationSeconds} />
              );
            }
            // While utterances are still loading AND there are no
            // questions, show nothing for the score-card slot. The
            // utterance fetch typically resolves in <300ms. On
            // resolve we'll either render Not Scored (utterances
            // present, no questions) or fall through to the regular
            // ScoreCard (questions present).
            if (!utterancesLoaded && noQuestions) return null;
            if (noQuestions) {
              // Has utterances but no questions —show a soft
              // "scoring not available" note instead of the regular
              // ScoreCard (which would spinner forever for zero
              // questions). The transcript-fallback section
              // downstream renders the actual speech.
              return (
                <div className="pv-no-break mb-8 rounded-lg border border-border bg-bg overflow-hidden">
                  {/* Same chip + copy as the score-side
                      "insufficient_data" card above (in ScoreCard).
                      "Not enough data to grade" is the same user-
                      facing concept whether the model rejected a
                      thin transcript or the classifier never locked
                      a question —unified label avoids the user
                      seeing two near-identical states under
                      different names. */}
                  <div className="p-6">
                    <div
                      className="inline-block text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded"
                      style={{
                        background: "var(--color-surface-2)",
                        color: "var(--color-text-muted)",
                      }}
                    >
                      Insufficient Data to Score
                    </div>
                    <p className="mt-3 text-[14.5px] leading-relaxed text-text">
                      Not enough was captured to produce a scorecard.
                    </p>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
                      Run a longer session —at least one full case
                      question, answered end-to-end —and a graded
                      scorecard will appear here.
                    </p>
                  </div>
                </div>
              );
            }
            return (
              <ScoreCard
                score={session.score}
                scoreError={session.scoreError}
                onRefresh={refreshScore}
                isRefreshing={isRefreshing}
              />
            );
          })()}
          {refreshError && (
            // Re-score retry failed. Same muted-warning treatment as
            // the ScoreCard's failure card. Deliberately NOT showing
            // the raw error —engineer-facing strings ("HTTP 400:
            // Missing JD") are hostile to non-technical users. A
            // simple "try again" line is all the user needs; if the
            // problem persists they'll see the same message and know
            // it's not transient.
            <div className="-mt-7 mb-8 text-[12px] text-text-muted bg-surface border border-border rounded-md px-3 py-2">
              <span className="font-semibold text-text">Re-score didn&apos;t complete.</span>{" "}
              <span className="text-text-subtle">
                Try again in a moment, or use Re-score above.
              </span>
            </div>
          )}

          {/* Screen recording —shown only when the session was captured
              with "Also record screen video" enabled AND the user shared
              a tab/window with a video track. The blob URL is in-memory
              and dies on tab close / refresh; download is the only way
              to keep it long-term.
              Hidden from PDF export —videos can't be embedded in a
              printed PDF, and a placeholder image of the video poster
              would just be noise. */}
          {(() => {
            // Three rendering states for the Recording panel:
            //
            //   1. videoConcatPending —server-side ffmpeg `-c copy`
            //      is stitching the multi-segment MP4 (typical 3-7s).
            //      Show "Preparing recording— placeholder. Even if
            //      session.videoUrl exists (first-segment blob URL),
            //      we deliberately DON'T play it —partial-recording
            //      playback is more confusing than waiting a few
            //      seconds for the full video.
            //
            //   2. effectiveVideoUrl ready —render the player.
            //
            //   3. videoS3Key set but signed URL still in flight —            //      "Loading recording— placeholder. Same 16:9 frame
            //      so layout doesn't shuffle when the URL arrives.
            if (session.videoConcatPending) {
              return (
                <div className="print:hidden mb-8 rounded-lg border border-border overflow-hidden bg-bg">
                  <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                    <div className="eyebrow">Recording</div>
                  </div>
                  <div className="relative w-full bg-black aspect-video flex flex-col items-center justify-center text-white">
                    <div className="inline-flex gap-[3px] mb-2">
                      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse-dot" />
                      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse-dot [animation-delay:.2s]" />
                      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse-dot [animation-delay:.4s]" />
                    </div>
                    <div className="text-[12px] uppercase tracking-wider opacity-70">
                      {t("Preparing recording…", "正在准备录像…")}
                    </div>
                  </div>
                </div>
              );
            }
            if (effectiveVideoUrl) {
              return (
                <div className="print:hidden">
                  <VideoSection
                    videoUrl={effectiveVideoUrl}
                    sessionId={session.id}
                    sessionTitle={session.title}
                    questions={session.questions}
                    durationSec={session.durationSeconds}
                    currentTime={currentTime}
                    videoRef={videoRef}
                    onTimeUpdate={setCurrentTime}
                    onReload={() => setVideoSignNonce((n) => n + 1)}
                  />
                </div>
              );
            }
            if (session.videoS3Key) {
              return (
                <div className="print:hidden mb-8 rounded-lg border border-border overflow-hidden bg-bg">
                  <div className="px-5 py-3 border-b border-border flex items-center justify-between">
                    <div className="eyebrow">Recording</div>
                  </div>
                  <div className="relative w-full bg-black aspect-video flex flex-col items-center justify-center text-white">
                    <div className="inline-flex gap-[3px] mb-2">
                      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse-dot" />
                      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse-dot [animation-delay:.2s]" />
                      <span className="w-[5px] h-[5px] rounded-full bg-white animate-pulse-dot [animation-delay:.4s]" />
                    </div>
                    <div className="text-[12px] uppercase tracking-wider opacity-70">
                      {t("Loading recording…", "正在加载录像…")}
                    </div>
                  </div>
                </div>
              );
            }
            return null;
          })()}

          {/* Context block —short AI summaries of the JD + (when
              provided) the candidate's resume. Generated post-session
              via /api/summarize-context and stored on the Session.
              Both rows are independently optional: if jdSummary is
              missing entirely (still in flight or summarize failed)
              the whole block hides; if resumeSummary is missing the
              row is just skipped. No "Candidate" placeholder when
              there's nothing to show. */}
          {session.jdSummary && (
            <div className="pv-no-break mb-8 rounded-lg border border-border bg-surface px-6 py-5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-text-subtle mb-3">
                {t("Context", "背景")}
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-text mb-1">
                    {t("Role", "职位")}
                  </div>
                  <p className="text-[13.5px] leading-relaxed text-text-muted">
                    {session.jdSummary}
                  </p>
                </div>
                {session.resumeSummary && (
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-text mb-1">
                      {t("Candidate", "候选人")}
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-text-muted">
                      {session.resumeSummary}
                    </p>
                  </div>
                )}
                {/* Prefer the AI-generated summary (clean, ~50 words).
                    Fall back to NOTHING when only the raw paste is
                    available —the raw text is often a hundreds-of-line
                    LinkedIn copy that breaks the Context block layout.
                    The summarize-context call usually returns within
                    ~2-3s of session end, so the row appears shortly
                    after the user lands on the past view. */}
                {session.interviewerProfileSummary && (
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-text mb-1">
                      {t("Interviewer", "面试官")}
                    </div>
                    <p className="text-[13.5px] leading-relaxed text-text-muted">
                      {session.interviewerProfileSummary}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Interview Transcript —per-question entries listed in
              chronological order. Each entry shows: timestamp, phase
              chip (Lead vs Probe), the question text, candidate-answer
              snippet, AI commentary, and (when present) the suggested
              "Try" reply rendered as its own visually distinct block —              not buried inline at the end of the commentary paragraph.
              Click an entry to seek the recording.
              Header used to show entry count + "Copy transcript" button;
              both removed once Export PDF landed —count was clutter,
              copy was redundant with the PDF flow. */}
          <div className="pv-keep-with-next mt-12 mb-4">
            <h2 style={{ fontSize: "1.5rem" }}>
              {t("Interview Transcript", "面试记录")}
            </h2>
          </div>
          <InterviewTranscript
            questions={session.questions}
            utterances={utterances}
            speakerRoles={session.speakerRoles}
            videoRef={videoRef}
            currentTime={currentTime}
          />
        </div>
      </div>
    </>
  );
}
