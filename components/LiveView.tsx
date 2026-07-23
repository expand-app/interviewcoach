"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { ModalShell } from "@/components/modals/ModalShell";
import { Eyebrow, Button, BrandMark } from "@/components/ui";
import type {
  MomentStateKind,
  Question,
  RecordingTimeline,
  Utterance,
} from "@/types/session";

/**
 * The three top sections (Interview Phase, Live Commentary, Live Captions)
 * stack into the main content area. The block is *roughly* 16:9 at
 * 920px width but the Phase region is allowed to grow slightly when a
 * Lead Question's text exceeds 2 lines — readability of the question
 * is more important than holding a perfect rectangle. Commentary and
 * Captions stay at fixed heights below.
 *
 * Target sizes at 920px width:
 *   Phase:      ~140 px   (min; grows for long questions)
 *   Commentary:  280 px   (heading 28 + pane 252)
 *   Captions:    151 px   (heading 28 + lane 60 + divider 1 + lane 60 + border 2)
 *   ─────────────
 *   Total:       571 px   (fits inside the 580 px ic-capture-region)
 *
 * Commentary was 226 px through the BBox-stability fix, but the fixed
 * height clipped the bottom of the "Try this instead" suggestion
 * whenever both the commentary paragraph AND the suggestion block were
 * present (a common case). Bumped to 280 px so the suggestion fits
 * comfortably; the value is still FIXED (BBox stays stable for Region
 * Capture), and the inner card adds overflow-y-auto as a fallback for
 * unusually long combinations.
 *
 * Captions deliberately got smaller (12-13px text vs 14-15px) so the
 * Phase region could absorb full-text questions without truncation.
 */
const PHASE_MIN_HEIGHT_PX = 140;
const COMMENTARY_TOTAL_HEIGHT_PX = 280;
const COMMENTARY_HEADING_HEIGHT_PX = 28;
const COMMENTARY_PANE_HEIGHT_PX =
  COMMENTARY_TOTAL_HEIGHT_PX - COMMENTARY_HEADING_HEIGHT_PX; // 198
const CAPTIONS_TOTAL_HEIGHT_PX = 151;
const CAPTIONS_HEADING_HEIGHT_PX = 28;
/** Each speaker's caption lane. Smaller (60 vs old 80) since the
 *  caption font also shrunk — same line-count visible per lane. */
const CAPTIONS_LANE_HEIGHT_PX = 60;

// ── "Live 演示" phone layout ──────────────────────────────────────
// A pre-recording presentation toggle: the two output boxes (LIVE
// COMMENTARY + LIVE CAPTIONS) switch from the default wide-flat
// (iPad-ish) shape to a narrow-tall (iPhone-ish) shape, staying
// vertically stacked. ONLY the two boxes change — the question bar
// (header), side rails, and everything else stay put.
//
// Safe w.r.t. Region Capture because the toggle is LOCKED during
// recording (same gate as the fullscreen button): the layout is set
// before Begin, the crop bbox is computed once at that stable size,
// and each box keeps a FIXED height (content overflows internally,
// never resizes the box) — so nothing shifts mid-recording and no
// 花屏 can occur.
const PHONE_BOX_MAX_WIDTH_PX = 760; // narrow column, sized so the enlarged phone
// commentary (24px) + "Try this" (21px) fit the fixed pane with NO clipping across
// all real comments (validated 0/635), while staying ~3/4 the wide layout's 1032px.
// FIXED height for the commentary pane in phone mode. Holds a full-budget
// comment (≈80 字 / 40 words, measured ~160 字) + the 15-30 word "Try
// this" at the enlarged phone font. Content past this clips internally
// rather than resizing the pane — required so the card's Region Capture
// bbox stays stable. Sized (with the capped question bar below) so the
// captions section always stays visible inside the fixed card.
const COMMENTARY_PHONE_HEIGHT_PX = 620;
// Cap on the phone-mode question bar (Lead + Probe). Without a cap a very
// long question would grow unbounded and push the captions (+ Re-tag,
// which the user needs) off the bottom of the fixed card. Beyond this the
// question scrolls internally; captions always stays put. ~6-7 lines at
// the enlarged phone font.
const PHONE_QUESTION_MAX_HEIGHT_PX = 260;
// Phone-mode card is a FIXED height (not auto) for the same reason wide
// mode is: the card IS the Region Capture crop target, and ANY size
// change during recording (e.g. the question bar growing when a new
// question arrives) moves its bounding box → 花屏 in the saved video.
// Sized so the CAPPED question bar + commentary pane + captions all fit
// with slack, so captions/Re-tag are always visible:
//   question ≤ (mt-4 16 + 260) + commentary (mt-4 16 + 620) + captions 151
//   ≈ 1063 → 1080 leaves ~17px slack.
const PHONE_CARD_HEIGHT_PX = 1080;
// Wide-mode max-width the boxes animate FROM. A concrete px (not
// `none`/`100%`) so the max-width transition is smooth in both
// directions. ≈ the card's inner content width (max-w-1080 − px-6).
const WIDE_BOX_MAX_WIDTH_PX = 1032;
const LAYOUT_TRANSITION =
  "max-width 340ms cubic-bezier(0.4,0,0.2,1), height 340ms cubic-bezier(0.4,0,0.2,1)";

/** Split commentary text on the `---SAY---` marker that the model
 *  emits at the end of every commentary / hint, separating the
 *  observation from the English suggested-answer script. The marker is
 *  exact-string; surrounding whitespace varies. Returns the leading
 *  commentary HTML and the suggested-answer text (after `Try:` prefix
 *  if present). Streaming-safe: when the marker hasn't arrived yet, the
 *  whole input is treated as commentary and `suggestion` is empty. */
function splitCommentary(text: string): {
  commentary: string;
  suggestion: string;
} {
  if (!text) return { commentary: "", suggestion: "" };
  const marker = /\s*---SAY---\s*/;
  const parts = text.split(marker);
  if (parts.length < 2) return { commentary: text, suggestion: "" };
  const commentary = parts[0].trim();
  // Everything after the marker is the suggested answer. Strip a leading
  // `Try:` / `Try ` prefix if the model included one (it's redundant
  // with the UI label).
  let suggestion = parts.slice(1).join(" ").trim();
  suggestion = suggestion.replace(/^Try[:\s]+/i, "");
  return { commentary, suggestion };
}

/** Length-based reading time for a piece of pane content. Per the
 *  user's spec:
 *    CJK chars  at 4/sec → 250ms each
 *    English words at 2/sec → 500ms each
 *    minDisplayMs = readingTimeMs + 1500ms buffer
 *
 *  CRITICAL: strip HTML tags first. Commentary text comes pre-rendered
 *  as `<strong>Python</strong>` style markup — the user sees "Python"
 *  but a naive word counter sees `<strong>` and `</strong>` as English
 *  tokens, doubling/tripling the count. For mixed CJK + English, the
 *  reading times ADD (you read both halves), not max. The previous
 *  Math.max(...) under-counted by ignoring the secondary language.
 *
 *  Floor 4s (even a one-word comment gets time to read), ceiling 90s
 *  (matches orchestrator's COMMENT_MAX_DISPLAY_MS).
 *
 *  Examples (no HTML):
 *    200 CJK chars      → 50s + 1.5s = 51.5s
 *    50  CJK chars      → 12.5s + 1.5s = 14s
 *    20 English words   → 10s + 1.5s = 11.5s
 *    50 CJK + 5 English → 12.5 + 2.5 + 1.5 = 16.5s  (additive)
 */
function computePaneMinDisplayMs(text: string): number {
  const FLOOR = 4000;
  const CEIL = 90000;
  const BUFFER = 1500;
  if (!text) return FLOOR;
  // Strip HTML tags + collapse whitespace so the pre-rendered <strong>
  // markup doesn't inflate the word count. Also strip the SAY-block
  // suggested-answer (everything after `---SAY---`) since it gets
  // counted separately in its own visual region — counting it twice
  // makes the min-display almost double what's reasonable.
  const beforeSay = text.split(/\s*---SAY---\s*/)[0] ?? text;
  const stripped = beforeSay
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .trim();
  if (!stripped) return FLOOR;
  const cjk = (stripped.match(/[一-鿿]/g) || []).length;
  const englishWords = stripped
    .split(/\s+/)
    .filter((w) => /[a-zA-Z]/.test(w)).length;
  const readingMs = (cjk / 4 + englishWords / 2) * 1000;
  return Math.min(CEIL, Math.max(FLOOR, readingMs + BUFFER));
}

/** Shared renderer for the three commentary slot variants (Q-A, listen
 *  hint, candidate-question). Splits the streamed text on the
 *  `---SAY---` marker so the LLM-emitted English suggested-answer
 *  shows below the main observation in italic. The user's spec:
 *  observation in standard prose, then a thin divider + 12.5px italic
 *  English script the candidate can actually utter, with `...` for
 *  elision.
 *
 *  `tone="hint"` adds the 💡 icon column + accent-blue left border;
 *  `tone="commentary"` is the plain 14.5px-black layout. Both use the
 *  same SAY-block rendering. */
function CommentaryBody({
  html,
  tone,
  phoneMode = false,
}: {
  html: string;
  tone: "commentary" | "hint";
  /** "Live 演示" layout: enlarge the text so mobile livestream
   *  viewers (watching a cropped narrow slice) can read it clearly. */
  phoneMode?: boolean;
}) {
  const { commentary, suggestion } = splitCommentary(html);
  // Until the model has emitted any commentary text yet, render the
  // raw streaming buffer as-is so the user sees tokens appearing.
  const mainHtml = commentary || html || "…";

  // "Try this" suggestion block. Matches the marketing site's
  // .try-this pattern: bordered inset card inside the commentary
  // stream with a small UPPERCASE TRY label. No emoji per the design
  // rule (UI copy stays text-only); visual differentiation comes
  // from the boxed treatment + label. Label was originally "Try this
  // instead" — shortened to drop the redundant "instead" word
  // (the boxed callout already implies a contrast with what was
  // said). Saves a few px of vertical space too, which matters
  // inside the fixed-height commentary panel.
  const SuggestionBlock = suggestion ? (
    <div
      className={
        "mt-3 rounded-sm leading-relaxed text-text-muted " +
        (phoneMode ? "text-[21px]" : "text-[14.5px]")
      }
      style={{
        padding: "var(--space-3)",
        background: "var(--color-bg)",
        border: "1px solid var(--color-border)",
      }}
    >
      <Eyebrow as="div" className="mb-1" style={{ fontSize: "0.625rem", color: "var(--color-text)", fontWeight: 600 }}>
        Try this
      </Eyebrow>
      <em
        className="not-italic"
        style={{ fontStyle: "italic" }}
        dangerouslySetInnerHTML={{ __html: suggestion }}
      />
    </div>
  ) : null;

  if (tone === "hint") {
    // Listening-hint tone — a thicker left rule + warmer surface
    // tells the user this is in-the-moment coaching ("listen for X")
    // distinct from post-answer Q-A commentary.
    //
    // No internal scroll: the section grows to fit the entire hint
    // text. Listening hints can be 200-300 chars on long monologues;
    // requiring users to mouse-wheel inside this pane while they're
    // also listening to the interview is the wrong UX.
    return (
      <div
        className="w-full flex animate-appear"
        style={{
          borderLeft: "3px solid var(--color-text)",
          background: "var(--color-surface-2)",
        }}
      >
        {/* Same 17px / leading-normal as the commentary tone below.
            Hint and commentary share the same fixed display pane;
            keeping their font sizes aligned avoids a jarring size
            jump every time the panel switches between them. Same
            content-budget caps apply (40 words / 80 字 — see
            /api/commentary listening-hint prompt). */}
        <div
          className={
            "flex-1 min-w-0 px-4 py-4 leading-normal text-text prose-live " +
            (phoneMode ? "text-[24px]" : "text-[17px]")
          }
        >
          <div dangerouslySetInnerHTML={{ __html: mainHtml }} />
          {SuggestionBlock}
        </div>
      </div>
    );
  }

  // Q-A commentary tone. Auto-height — no internal scrollbar.
  // Section expands to show all commentary text without requiring
  // the user to scroll. See parent CommentarySection for the
  // min-height / no-overflow rationale.
  return (
    // Commentary body bumped 15.5px → 17px per UX feedback (still
    // too small at the previous size). Switched leading from
    // leading-relaxed (1.625) to leading-normal (1.5) so the
    // bigger font doesn't lose line capacity: 17px × 1.5 = 25.5px
    // line-height, virtually identical to the previous 15.5 ×
    // 1.625 = 25.2px. Net effect: text is visually larger but
    // fits the same ~4-5 lines in the fixed 88px commentary area
    // alongside the Try-this block. /api/commentary budgets
    // trimmed to 80 字 / 40 words so the model doesn't overshoot
    // and produce content that gets clipped.
    <div
      className={
        "w-full px-4 py-4 leading-normal text-text prose-live animate-appear " +
        (phoneMode ? "text-[24px]" : "text-[17px]")
      }
    >
      <div dangerouslySetInnerHTML={{ __html: mainHtml }} />
      {SuggestionBlock}
    </div>
  );
}

export function LiveView({
  isFullscreen = false,
  onToggleFullscreen,
  phoneMode = false,
  onTogglePhoneMode,
  onStartRequest,
}: {
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** "Live 演示" layout — the two output boxes go narrow + tall.
   *  Set before recording; locked once recording starts. */
  phoneMode?: boolean;
  onTogglePhoneMode?: () => void;
  /** Called when the empty-state "Start a new session" button is
   *  clicked. Same handler the Topbar Start button calls — opens
   *  StartModal. Optional so LiveView still works in isolation. */
  onStartRequest?: () => void;
} = {}) {
  const t = useTranslations();
  const questions = useStore((s) => s.liveQuestions);
  const live = useStore((s) => s.live);
  const utterances = useStore((s) => s.liveUtterances);
  const speakerRoles = useStore((s) => s.liveSpeakerRoles);
  const moment = useStore((s) => s.liveMomentState);
  const displayedComment = useStore((s) => s.liveDisplayedComment);
  const listeningHint = useStore((s) => s.liveListeningHint);
  const candidateQuestionCommentary = useStore(
    (s) => s.liveCandidateQuestionCommentary
  );
  const lockedCandidateQuestion = useStore(
    (s) => s.liveLockedCandidateQuestion
  );
  const lockedProbeQuestion = useStore((s) => s.liveLockedProbeQuestion);
  // Upload mode was removed. These bound to upload-only store fields
  // before; hard-coded so existing branches that read them collapse to
  // the live-mode path without a deeper refactor. The cast keeps the
  // surviving `timelineView` useMemo (gated on `if (!timeline)`) typed
  // against the RecordingTimeline shape — without it, TS would narrow
  // `timeline` to `null` and reject `.phases` etc. inside the dead
  // truthy branch.
  const timeline = null as RecordingTimeline | null;
  const playbackTime = 0;
  const isUploadMode = false;
  const forceSetSpeakerRole = useStore((s) => s.forceSetSpeakerRole);
  const [retagModalOpen, setRetagModalOpen] = useState(false);

  const [interim, setInterim] = useState("");
  useEffect(() => {
    const handler = (e: Event) => setInterim((e as CustomEvent).detail as string);
    window.addEventListener("ic:interim", handler);
    return () => window.removeEventListener("ic:interim", handler);
  }, []);

  // === Timeline-driven resolution (upload + preanalyze) ===
  // When a timeline is present, every piece of derived state — phase,
  // current lead/probe, displayed commentary, listening hint — is a
  // lookup against `playbackTime` rather than store-accumulated state.
  // This is what makes seeking correct: scrubbing just moves the time
  // forward or back, and everything re-renders from the same snapshot.
  const timelineView = useMemo(() => {
    if (!timeline) return null;
    // Universal 5-second display lag. Without this, everything reveals
    // the instant its timestamp is crossed — the UI feels psychic,
    // showing the question as soon as the interviewer starts asking.
    // Lag = "I heard it, I understood it, now I'm showing it."
    const DISPLAY_LAG_SEC = 5;
    const t = Math.max(0, playbackTime - DISPLAY_LAG_SEC);

    // Phase at time t = latest phase segment whose fromSec <= t
    const phaseSeg = [...timeline.phases]
      .reverse()
      .find((p) => p.fromSec <= t);

    /** For a question asked at `askedAtSec`, compute the time at which
     *  it should REVEAL in the UI. Reveal is at the END of the asking
     *  turn, not the beginning — otherwise users see the question
     *  materialize while the interviewer is still articulating it.
     *  Heuristic: find the next phase after askedAtSec whose kind is
     *  candidate_answering with matching questionId — that's when the
     *  interviewer has handed off. Fallback to askedAtSec + 10s if no
     *  such phase exists (covers extraction gaps). */
    const questionRevealAt = (q: {
      id: string;
      askedAtSec: number;
    }): number => {
      const nextAnswerPhase = timeline.phases.find(
        (p) =>
          p.fromSec > q.askedAtSec &&
          p.kind === "candidate_answering" &&
          p.questionId === q.id
      );
      if (nextAnswerPhase) return nextAnswerPhase.fromSec;
      // Fallback: assume ~10s interviewer speech + hand-off.
      return q.askedAtSec + 10;
    };

    // Latest LEAD question whose reveal-time <= t
    const leadsSorted = timeline.questions
      .filter((q) => !q.parentId)
      .slice()
      .sort((a, b) => a.askedAtSec - b.askedAtSec);
    const lead = leadsSorted
      .slice()
      .reverse()
      .find((q) => questionRevealAt(q) <= t);

    // Latest PROBE question (parent = lead) whose reveal-time <= t
    const probe = lead
      ? timeline.questions
          .filter((q) => q.parentId === lead.id)
          .slice()
          .sort((a, b) => a.askedAtSec - b.askedAtSec)
          .filter((q) => questionRevealAt(q) <= t)
          .pop()
      : undefined;

    // Per-commentary "reveal time": the playback moment when we
    // actually want to surface the comment, which is NOT `atSec`
    // directly. atSec is the moment the model observed; we wait until
    // the next natural beat — a ≥ 2.5s silence, or a speaker change —
    // so the UI never pops a comment onto the screen while the
    // candidate is still mid-thought. Capped at atSec + 20s so a
    // non-stop monologue doesn't suppress the comment forever.
    const PAUSE_MIN_SEC = 2.5;
    const MAX_WAIT_SEC = 20;
    const sortedUtterances = [...utterances].sort(
      (a, b) => a.atSeconds - b.atSeconds
    );
    const computeRevealAt = (atSec: number): number => {
      const maxWait = atSec + MAX_WAIT_SEC;
      // Find the first utterance whose END is >= atSec.
      let i = 0;
      while (i < sortedUtterances.length) {
        const u = sortedUtterances[i];
        const uEnd = u.atSeconds + (u.duration ?? 1.5);
        if (uEnd >= atSec) break;
        i++;
      }
      for (; i < sortedUtterances.length; i++) {
        const u = sortedUtterances[i];
        const uEnd = u.atSeconds + (u.duration ?? 1.5);
        if (uEnd > maxWait) break;
        const next = sortedUtterances[i + 1];
        if (!next) {
          // End of recording counts as a natural break.
          return Math.max(atSec, uEnd);
        }
        const gap = next.atSeconds - uEnd;
        const uRole =
          u.dgSpeaker !== undefined ? speakerRoles[u.dgSpeaker] : undefined;
        const nextRole =
          next.dgSpeaker !== undefined
            ? speakerRoles[next.dgSpeaker]
            : undefined;
        const pauseBreak = gap >= PAUSE_MIN_SEC;
        const speakerBreak = uRole && nextRole && uRole !== nextRole;
        if (pauseBreak || speakerBreak) {
          return Math.max(atSec, uEnd);
        }
      }
      // Non-stop speech: give up and force-reveal at the cap.
      return maxWait;
    };

    // Merged commentary stream: commentary + listening hints flattened
    // into a single chronological list. We show whichever is most
    // recent regardless of source, because the UI has already unified
    // them under a single "Live Commentary" label.
    type MergedEntry = {
      atSec: number;
      revealAtSec: number;
      text: string;
      questionId?: string;
      id: string;
    };
    const merged: MergedEntry[] = [
      ...timeline.commentary.map((c) => ({
        atSec: c.atSec,
        revealAtSec: computeRevealAt(c.atSec),
        text: c.text,
        questionId: c.questionId,
        id: c.id,
      })),
      ...timeline.listeningHints.map((h) => ({
        atSec: h.atSec,
        revealAtSec: computeRevealAt(h.atSec),
        text: h.text,
        id: h.id,
      })),
    ].sort((a, b) => a.revealAtSec - b.revealAtSec);

    // Current displayed entry. Pick the latest whose revealAtSec <= t
    // (i.e. the next natural beat after the model's atSec has already
    // passed). Then EXPIRE if the conversation has clearly moved on:
    //   - If the next entry's reveal is within 60s, keep showing (handoff).
    //   - Else, after 45s of playback-time age, consider it stale.
    //   - For question-anchored entries: also expire when the current
    //     Lead has advanced past that entry's parent question.
    const COMMENT_MAX_AGE_SEC = 45;
    let candidateIdx = -1;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].revealAtSec <= t) {
        candidateIdx = i;
        break;
      }
    }
    const candidate = candidateIdx >= 0 ? merged[candidateIdx] : undefined;
    let lastComment: MergedEntry | undefined = candidate;
    if (candidate) {
      const next = merged[candidateIdx + 1];
      const nextGap = next
        ? next.revealAtSec - candidate.revealAtSec
        : Infinity;
      const age = t - candidate.revealAtSec;
      if (nextGap > 60 && age > COMMENT_MAX_AGE_SEC) {
        lastComment = undefined;
      }
      // Only apply topic-change expiry to question-anchored entries.
      // Free-standing listening hints (no questionId) are about the
      // interviewer's moment, not a question answer, and don't need
      // lead-tracking expiry.
      if (lastComment && lead && candidate.questionId) {
        const commentQ = timeline.questions.find(
          (q) => q.id === candidate.questionId
        );
        const commentLeadId = commentQ?.parentId ?? commentQ?.id;
        if (commentLeadId && commentLeadId !== lead.id) {
          lastComment = undefined;
        }
      }
    }

    // `lastHint` kept for backwards-compat but no longer used for display —
    // listening hints are in the merged stream now. Set to undefined.
    const lastHint = undefined;

    return { phaseSeg, lead, probe, lastComment, lastHint };
  }, [timeline, playbackTime, utterances, speakerRoles]);

  // Resolve the current main + follow-up Qs.
  // Timeline mode: derive from timelineView (reflects playback position).
  // Live mode: derive from the store-tracked currentQuestionId.
  const currentMainQ = timelineView
    ? timelineView.lead
      ? questions.find((q) => q.id === timelineView.lead!.id)
      : undefined
    : (() => {
        const currentSubQ = questions.find(
          (q) => q.id === live.currentQuestionId
        );
        return currentSubQ?.parentQuestionId
          ? questions.find((q) => q.id === currentSubQ.parentQuestionId)
          : currentSubQ;
      })();

  const currentFollowUpQ = timelineView
    ? timelineView.probe
      ? questions.find((q) => q.id === timelineView.probe!.id)
      : undefined
    : (() => {
        const currentSubQ = questions.find(
          (q) => q.id === live.currentQuestionId
        );
        return currentSubQ && currentSubQ !== currentMainQ
          ? currentSubQ
          : undefined;
      })();

  // The Q that "owns" the live commentary slot — in timeline mode this
  // is whichever Q the current commentary belongs to (falls back to the
  // current lead/probe). In live mode, whichever sub-Q is current.
  const commentaryOwnerQ = timelineView
    ? timelineView.lastComment
      ? questions.find((q) => q.id === timelineView.lastComment!.questionId)
      : currentFollowUpQ ?? currentMainQ
    : questions.find((q) => q.id === live.currentQuestionId);

  const hasStarted = live.status !== "idle" || questions.length > 0;

  if (!hasStarted) {
    // Empty state — pre-session. Centered card with brand mark,
    // short copy, and a primary "Start a new session" button. The
    // button calls onStartRequest (the same StartModal-opening
    // handler the Topbar's Start button uses) so users have a clear
    // primary CTA without having to scan the chrome for the small
    // Start button. Replaces the previous mic-emoji + "Click Start
    // to begin" placeholder, which read as "this surface is empty"
    // rather than "here's how to begin".
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-[420px] text-center">
          <div className="flex justify-center mb-6">
            <BrandMark size={48} />
          </div>
          <h2
            className="text-text mb-2"
            style={{
              fontSize: "1.5rem",
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            {t("Ready when you are.", "随时可以开始。")}
          </h2>
          <p className="text-[13.5px] text-text-muted mb-8 leading-relaxed">
            {t(
              "Start a session to begin live coaching. Have your job description and resume ready to paste.",
              "开始一场会话以启动实时辅导。请准备好职位描述和简历以粘贴。"
            )}
          </p>
          {onStartRequest && (
            <button
              type="button"
              onClick={onStartRequest}
              className="btn btn-primary btn-lg"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="7" y1="3" x2="7" y2="11" />
                <line x1="3" y1="7" x2="11" y2="7" />
              </svg>
              {t("Start a new session", "开始新会话")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Map timeline phase → MomentStateKind so existing subcomponents can
  // render without knowing about timeline mode. When no timeline,
  // straight-through from store moment.state.
  // Note: PhaseKind's "chitchat" and "between_questions" both map to
  // MomentStateKind's "interviewer_speaking" — chitchat was merged into
  // interviewer_speaking in the live state machine; the upload-mode
  // PhaseKind enum kept the chitchat label for post-hoc segmentation but
  // it routes to the same UI state ("Interview Ongoing" via the 5-state
  // collapse) when there's no active mainQuestion.
  const phaseToMomentState = (p?: { kind: string }): MomentStateKind => {
    switch (p?.kind) {
      case "chitchat":
      case "between_questions":
      case "interviewer_asking_first":
      case "interviewer_probing":
        return "interviewer_speaking";
      case "candidate_answering":
        return "question_finalized";
      default:
        return "idle";
    }
  };
  const effectiveState = timelineView
    ? phaseToMomentState(timelineView.phaseSeg)
    : moment.state;

  // Synthetic displayed-comment pointer in timeline mode. The text lives
  // on commentaryOwnerQ.comments (we seeded timeline commentary into
  // liveQuestions during preAnalyze), so the existing lookup in
  // CommentarySection still works.
  const effectiveDisplayed = timelineView
    ? timelineView.lastComment
      ? {
          id: timelineView.lastComment.id,
          questionId: timelineView.lastComment.questionId,
          displayedAt: Date.now(),
          minMs: 0,
        }
      : null
    : displayedComment;

  // Timeline mode folds listening hints into the merged-stream overrideText
  // (handled below in the CommentarySection overrideText prop), so the
  // effective live-mode hint is empty in timeline mode.
  const effectiveListeningHint = timelineView ? "" : listeningHint;

  // Live-mode role-confirmation gate. Upload mode skips this because
  // preIdentify seeds both roles confidently before playback begins,
  // so rolesConfirmed is always true for upload sessions. Live mic
  // sessions sit in the "identifying" state until the user has tagged
  // AT LEAST ONE speaker via the identity prompt — once one role is
  // known, the orchestrator auto-assigns the other role to the next
  // new speaker who shows up (there are only two sides in an
  // interview), so there's no reason to keep blocking the normal UI
  // while waiting for the second person to speak. The identity prompt
  // still appears for any additional unrecognized speakers.
  const rolesConfirmed =
    isUploadMode ||
    Object.values(speakerRoles).some(
      (r) => r === "interviewer" || r === "candidate"
    );
  const hasUtterances = utterances.length > 0;

  // Lock the outer page-scroll while a session is running. The DOM
  // `scroll` event fires identically for user-initiated scrolls and
  // programmatic ones (caption-lane auto-scroll, etc.), so any
  // scroll-driven Region Capture cropTo refresh ends up firing on
  // every utterance — produced ~14s of 花屏 at session start before
  // we removed that listener. Easier path: don't let the user scroll
  // the page during recording or paused state. They're meant to watch
  // the coaching surface (which is sized to one viewport) — there's
  // nothing below the fold that needs scrolling to. The wrapper goes
  // back to overflow-y-auto when status returns to "idle" (after
  // End / Discard) so the empty-state landing still scrolls if it
  // ever overflows.
  const lockScroll = live.status === "recording" || live.status === "paused";
  return (
    <>
      <div className={`flex-1 ${lockScroll ? "overflow-hidden" : "overflow-y-auto"}`}>
        {/* Card wrapper. Page title now lives INSIDE the scrollable
            container (so it scrolls with the rest of the content,
            instead of sitting outside). The card itself uses
            position: sticky; top: 0 — so when the user scrolls down,
            the title scrolls out of view but the card pins to the
            top of the viewport. Two benefits:
              1. Region Capture's cropTo bounds NEVER fluctuate —
                 the card's screen position stays stable while
                 scrolling, eliminating the title-bleeds-into-
                 recording artifact users were seeing during
                 scroll-up gestures.
              2. The user always has the live coaching surface
                 anchored at the top of their view, even after
                 scrolling around. */}
        {/* Page width tuned to give the cropTarget (#ic-capture-region
            below) a 16:9 aspect ratio at its 580px fixed height. The
            recorded video is played back in an `aspect-video` (16:9)
            frame in PastView, so a 16:9 cropTarget eliminates the
            black-bar letterboxing on the left/right of the playback.
            Math: 580 × 16/9 ≈ 1031, so cropTarget needs to be at
            least 1031px wide. With px-6 (24px each side, 48px total)
            of breathing room around it, max-w needs to be ≈1080px. */}
        <div className="mx-auto w-full max-w-[1080px] px-6 pt-5 pb-20 max-[1100px]:px-4">
          {!isFullscreen && <PageTitle />}

          {/* ===== Coaching frame =====
              Three stacked sections. Sticky-pinned to the top of the
              scrollable area so its screen position stays stable for
              Region Capture.

              The `ic-capture-region` id is the Region Capture target
              (see lib/audioSession.ts) — the screen recording crops
              to this element so the saved video shows only the
              coaching panel.

              The fullscreen toggle button is positioned absolute in
              this card's top-right. */}
          <div
            id="ic-capture-region"
            className="sticky top-0 z-10 relative border border-border rounded-lg overflow-hidden bg-bg flex flex-col mb-6"
            style={
              isFullscreen
                ? // Fullscreen: height driven by content; a fullscreen
                  // toggle is a deliberate one-off layout change with its
                  // own crop refresh.
                  undefined
                : phoneMode
                ? // Phone mode: FIXED height (not auto) so the card's
                  // Region Capture bbox never changes mid-recording when
                  // the question bar grows on a new question → no 花屏.
                  // Taller than wide mode to fit the narrow-tall boxes.
                  { height: PHONE_CARD_HEIGHT_PX }
                : {
                    // Fixed height — keeps the element's bounding
                    // box stable while content flows inside
                    // (commentary streaming, captions adding rows,
                    // top-bar phase transitions).
                    //
                    // Without this lock, every internal layout
                    // change re-triggered Chrome's Region Capture
                    // auto-tracking, which produces a visible
                    // garbled-frame ("花屏") at the exact moment
                    // the UI updates — see the 0:32 case where a
                    // moment-state transition glitched the recording
                    // even though no cropTo() refresh fired on our
                    // side. Locking BBox dimensions takes that
                    // failure mode off the table.
                    //
                    // 580px tuned to fit the common layout: top-bar
                    // ≈ 100px + commentary pane ≈ 320px + captions
                    // ≈ 160px. Each inner section has its own
                    // overflow handling, so content past this cap
                    // degrades to internal scrolling rather than
                    // pushing the parent BBox larger. Fullscreen
                    // bypasses the lock — a fullscreen toggle is
                    // a deliberate one-off layout change with its
                    // own crop refresh.
                    height: 580,
                  }
            }
          >
            {/* Fullscreen toggle in the card's top-right corner. Lives
                INSIDE the card (not in the Topbar) per product spec —
                so the user always has a one-click exit even when the
                Topbar is auto-hidden in fullscreen. Ghost-button
                styling so it doesn't compete with the coaching
                content.
                LOCKED during active recording (recording / paused
                statuses). Toggling fullscreen mid-recording causes a
                cropTarget bbox change → MediaRecorder reference-frame
                contamination → brief visual artifact in the saved
                video. To eliminate this entirely we lock the toggle:
                user picks fullscreen BEFORE clicking Begin (ready-bar
                phase, status="starting") and is then committed for
                the duration. Escape key is similarly gated in
                app/page.tsx. */}
            {/* Top-right control cluster. Both toggles are LOCKED during
                active recording (recording / paused) — the user picks
                the layout BEFORE clicking Begin, then it's committed for
                the duration. Toggling either mid-recording would move /
                resize the Region Capture crop target → 花屏 in the saved
                video, so we gate them off. */}
            {(onTogglePhoneMode || onToggleFullscreen) && (() => {
              const controlsLocked =
                live.status === "recording" || live.status === "paused";
              return (
              <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5 print:hidden">
                {/* "Live 演示" — narrow-tall (iPhone-ish) vs default
                    wide-flat (iPad-ish) box layout. */}
                {onTogglePhoneMode && (
                  <button
                    type="button"
                    onClick={controlsLocked ? undefined : onTogglePhoneMode}
                    disabled={controlsLocked}
                    aria-pressed={phoneMode}
                    title={
                      controlsLocked
                        ? t(
                            "Layout is locked during recording — set this before you click Begin.",
                            "录制期间无法切换布局 —— 请在点击 Begin 之前设置好。"
                          )
                        : phoneMode
                          ? t("Switch to wide layout", "切换回宽屏布局")
                          : t("Switch to Live-demo layout", "切换到 Live 演示布局")
                    }
                    className="btn btn-ghost btn-sm"
                  >
                    {/* Phone / tablet frame icon. Portrait rounded rect
                        when we'd switch INTO phone mode; wider rect when
                        we'd switch back to the default layout. */}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {phoneMode ? (
                        /* back-to-wide: landscape frame */
                        <rect x="1.5" y="3.5" width="11" height="7" rx="1.2" />
                      ) : (
                        /* to-phone: portrait frame */
                        <>
                          <rect x="3.5" y="1.5" width="7" height="11" rx="1.5" />
                          <line x1="6" y1="10.7" x2="8" y2="10.7" />
                        </>
                      )}
                    </svg>
                    <span>
                      {phoneMode
                        ? t("Wide", "宽屏")
                        : t("Live demo", "Live 演示")}
                    </span>
                  </button>
                )}
                {/* Fullscreen toggle — lives inside the card so there's
                    always a one-click exit even when the Topbar is
                    auto-hidden in fullscreen. */}
                {onToggleFullscreen && (
                  <button
                    type="button"
                    onClick={controlsLocked ? undefined : onToggleFullscreen}
                    disabled={controlsLocked}
                    title={
                      controlsLocked
                        ? t(
                            "Fullscreen is locked during recording — set this before you click Begin.",
                            "录制期间无法切换全屏 —— 请在点击 Begin 之前设置好。"
                          )
                        : isFullscreen
                          ? t("Exit fullscreen (Esc)", "退出全屏 (Esc)")
                          : t("Fullscreen", "全屏")
                    }
                    className="btn btn-ghost btn-sm"
                  >
                    {/* Fullscreen toggle icon — SVG instead of Unicode
                        `⤡` / `⤢` since those glyphs fall back
                        inconsistently on some font stacks. Two arrows
                        pointing into / out of the corners of a square. */}
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {isFullscreen ? (
                        /* Exit: arrows pointing IN (toward center) */
                        <>
                          <path d="M6 2v3H3M2 6h3V3M8 12V9h3M12 8H9v3" />
                        </>
                      ) : (
                        /* Enter: arrows pointing OUT (toward corners) */
                        <>
                          <path d="M3 6V3h3M11 3h-3v3M3 8v3h3M11 8v3H8" />
                        </>
                      )}
                    </svg>
                    <span>
                      {isFullscreen
                        ? t("Exit", "退出全屏")
                        : t("Fullscreen", "全屏")}
                    </span>
                  </button>
                )}
              </div>
              );
            })()}
            {/* (1) Current Question — fixed-height top bar.
                Five phase states (no fallback-Lead bridging):
                  1. Awaiting Identity — pre-confirmation
                  2. Waiting For First — pre-utterance
                  3. Candidate's Question — reverse Q&A
                  4. Lead Question — currentMainQ active
                  5. Interview Ongoing — everything else (warm-up,
                     between-Leads, wrap-up after reverse Q&A). Shows
                     summary so user sees what's happening even when no
                     Lead is locked. */}
            <CurrentQuestionBar
              state={effectiveState}
              summary={moment.summary}
              mainQuestion={rolesConfirmed ? currentMainQ : undefined}
              followUp={rolesConfirmed ? currentFollowUpQ : undefined}
              rolesConfirmed={rolesConfirmed}
              hasUtterances={hasUtterances}
              timelinePhaseKind={timelineView?.phaseSeg?.kind}
              candidateAskingText={
                timelineView?.phaseSeg?.kind === "candidate_asking"
                  ? deriveCandidateAskingText(
                      utterances,
                      speakerRoles,
                      playbackTime
                    )
                  : undefined
              }
              // Live-mode reverse-Q&A text. Two sources, in priority order:
              //   (1) lockedCandidateQuestion — set by orchestrator when a
              //       cand-q-cmt commit happens (Jaccard + read-gate both
              //       cleared). Stable across rephrasings AND across
              //       moment-state flicker (interviewer mid-answer can
              //       briefly transit out of candidate_questioning).
              //       Cleared when a Lead Question locks.
              //   (2) moment.candidateQuestion — fresh classifier output,
              //       used during the brief window after entering
              //       candidate_questioning but before the first commit
              //       fires (or when read-gate has temporarily blocked
              //       all commits). Reflects the live ticking output;
              //       may flicker among rephrasings.
              // The CurrentQuestionBar renders Candidate's Question
              // phase whenever either source is non-empty AND no
              // mainQuestion is currently locked.
              liveCandidateQuestionText={
                rolesConfirmed && moment.state === "candidate_questioning"
                  ? moment.candidateQuestion
                  : undefined
              }
              lockedCandidateQuestionText={
                rolesConfirmed ? lockedCandidateQuestion ?? undefined : undefined
              }
              lockedProbeQuestionText={
                rolesConfirmed ? lockedProbeQuestion ?? undefined : undefined
              }
              labels={{
                leadHeader: t("Lead Question", "主问题"),
                interviewOngoingHeader: t(
                  "Interview Ongoing",
                  "面试进行中"
                ),
                candidateAskingHeader: t(
                  "Candidate's Question",
                  "候选人提问"
                ),
                waitingForFirst: t(
                  "Waiting for the interview to begin…",
                  "正在等待面试开始…"
                ),
                awaitingIdentity: t(
                  "Awaiting speaker identity confirmation — tag the speaker in the prompt above.",
                  "等待确认说话人身份 — 请在上方提示中标记。"
                ),
                probeHeader: t("Probe Question", "追问"),
              }}
              phoneMode={phoneMode}
            />

            {/* (2) Live Commentary — fixed pane, content tuned to fit.
                Parent gates content props on rolesConfirmed: until the
                user tags at least one speaker, everything renders as the
                unified idle "AI is observing…" placeholder inside. */}
            <CommentarySection
              state={effectiveState}
              currentQuestion={rolesConfirmed ? commentaryOwnerQ : undefined}
              displayed={rolesConfirmed ? effectiveDisplayed : null}
              listeningHint={rolesConfirmed ? effectiveListeningHint : ""}
              candidateQuestionCommentary={
                rolesConfirmed ? candidateQuestionCommentary : ""
              }
              overrideText={
                // Timeline mode: the merged stream may surface a
                // listening hint with no questionId, which the live-mode
                // lookup path can't resolve. Pass the text directly.
                timelineView ? timelineView.lastComment?.text ?? null : null
              }
              labels={{
                heading: t("LIVE COMMENTARY", "实时评论"),
                observing: t("AI is observing…", "AI 正在观察…"),
              }}
              isFullscreen={isFullscreen}
              phoneMode={phoneMode}
            />

            {/* (3) Live Captions — two speaker lanes stacked, fixed.
                Re-tag affordance only in live mode (upload-mode roles
                come from the pre-identify pass which is more reliable
                than a single user click + can be redone via re-upload). */}
            <LiveCaptions
              utterances={utterances}
              interim={interim}
              isRecording={live.status === "recording"}
              speakerRoles={speakerRoles}
              maxTimeSec={isUploadMode ? playbackTime : undefined}
              onRetagClick={
                !isUploadMode ? () => setRetagModalOpen(true) : undefined
              }
              retagLabel={t("Re-tag", "重新标注")}
              labels={{
                heading: t("LIVE CAPTIONS", "实时字幕"),
                live: t("LIVE", "直播中"),
                interviewer: t("Interviewer", "面试官"),
                candidate: t("Candidate", "候选人"),
                speakerPrefix: t("Speaker", "发言者"),
              }}
              isFullscreen={isFullscreen}
            />
          </div>

          {/* Re-tag speakers modal — opens from the LIVE CAPTIONS
              header's "Re-tag" link. Lets the user fix a mis-clicked
              role assignment (e.g. tagged the wrong person as
              interviewer at session start). Per-speaker buttons apply
              immediately via forceSetSpeakerRole; captions re-label
              live so the user can confirm. */}
          <RetagSpeakersModal
            open={retagModalOpen}
            onClose={() => setRetagModalOpen(false)}
            utterances={utterances}
            speakerRoles={speakerRoles}
            onForceRole={(dg, role) => {
              // Apply the user's pick.
              forceSetSpeakerRole(dg, role);
              // Mutually-exclusive flip: a two-person interview means
              // every OTHER known speaker must take the opposite role.
              // Without this, the user has to click both buttons in
              // sequence to swap (and ends up with both speakers tagged
              // the same role mid-flow until the second click). Builds
              // the set of known dgs from utterances rather than from
              // speakerRoles (which can be empty for an unlabeled
              // speaker — that's exactly the case we need to fill).
              const opposite: "interviewer" | "candidate" =
                role === "interviewer" ? "candidate" : "interviewer";
              const seen = new Set<number>();
              for (const u of utterances) {
                if (u.dgSpeaker !== undefined) seen.add(u.dgSpeaker);
              }
              for (const otherDg of seen) {
                if (otherDg === dg) continue;
                if (speakerRoles[otherDg] === opposite) continue;
                forceSetSpeakerRole(otherDg, opposite);
              }
            }}
            labels={{
              title: t(
                "Re-tag Interviewer / Candidate",
                "重新标注面试官 / 候选人"
              ),
              description: t(
                "If you tagged a speaker incorrectly, fix it here. Each change applies immediately — captions update so you can verify.",
                "如果开始时标错了说话人,在这里改正。每次点击立即生效,可以从字幕区确认。"
              ),
              interviewer: t("Interviewer", "面试官"),
              candidate: t("Candidate", "候选人"),
              sample: t("Sample", "示例"),
              unlabeled: t("Not yet labeled", "尚未标注"),
              close: t("Close", "关闭"),
              noSpeakers: t(
                "No speakers detected yet — recording hasn't picked up any voices.",
                "尚未检测到说话人 — 录音还没有采集到声音。"
              ),
            }}
          />

          {/* Note: the previous "Earlier in this interview" block was
              removed. Live mode is now strictly forward-looking — the
              current question / phase / commentary fills the frame and
              past questions are surfaced after End → Save under the
              "Interview Transcript" section in the Past Session view.
              Keeps Live's cognitive load low (no scrolling history while
              an active interview is running) and centralizes the
              chronological view in one place tied to the recording. */}
        </div>
      </div>
    </>
  );
}

function PageTitle() {
  // liveTitle is populated after /api/session-title returns — it derives a
  // role-and-company heading from the JD. Until then we show the generic
  // fallback, so the heading never blanks out.
  //
  // Rendered as <h1> for the document outline, sized down from the
  // global marketing-hero default to a comfortable in-app page-title
  // scale (~28px). The wrapping mx-auto/max-width container that used
  // to live here was removed — PageTitle is now nested inside the
  // outer scrollable card-wrapper which already provides those
  // constraints, so the title shares its horizontal alignment with
  // the card below it.
  const liveTitle = useStore((s) => s.liveTitle);
  return (
    <div className="pt-2 pb-5 max-[900px]:pt-1 max-[900px]:pb-3 shrink-0">
      <h1
        style={{
          fontSize: "1.75rem",
          lineHeight: 1.2,
          letterSpacing: "-0.02em",
        }}
      >
        {liveTitle || "Live Interview Session"}
      </h1>
    </div>
  );
}

/** For the "Candidate Q&A" phase, derive the question the candidate is
 *  currently asking the interviewer. We use the candidate's most recent
 *  run of utterances whose end time ≤ playbackTime (or simply their last
 *  run in live mode) and trim it to the last question-shaped sentence.
 *  No AI call — just a read of the transcript.
 */
function deriveCandidateAskingText(
  utterances: Utterance[],
  speakerRoles: Record<number, "interviewer" | "candidate">,
  currentTime: number
): string {
  // Candidate's dg-speaker number.
  let candidateDg: number | undefined;
  for (const [k, v] of Object.entries(speakerRoles)) {
    if (v === "candidate") {
      candidateDg = Number(k);
      break;
    }
  }
  if (candidateDg === undefined) return "";

  // Visible utterances up to currentTime (ignore clamp when no timeline).
  const visible = utterances.filter(
    (u) =>
      u.atSeconds <= currentTime &&
      (u.atSeconds + (u.duration ?? 0)) <= currentTime + 0.5
  );
  if (visible.length === 0) return "";

  // Walk back to the candidate's most recent contiguous run.
  let endIdx = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].dgSpeaker === candidateDg) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return "";
  let startIdx = endIdx;
  while (
    startIdx > 0 &&
    visible[startIdx - 1].dgSpeaker === candidateDg
  ) {
    startIdx--;
  }
  const runText = visible
    .slice(startIdx, endIdx + 1)
    .map((u) => u.text)
    .join(" ")
    .trim();
  if (!runText) return "";

  // Keep only the final sentence (that's the question). Split on `? `,
  // `. `, `! ` and take the last non-empty chunk. If a `?` exists, prefer
  // the substring that ends in the last `?`.
  const lastQMark = Math.max(
    runText.lastIndexOf("?"),
    runText.lastIndexOf("？")
  );
  if (lastQMark > 0) {
    // Find the start of this question — scan back to a terminator.
    let qStart = 0;
    for (let i = lastQMark - 1; i >= 0; i--) {
      const ch = runText[i];
      if (ch === "." || ch === "?" || ch === "!" || ch === "。" || ch === "？" || ch === "！") {
        qStart = i + 1;
        break;
      }
    }
    return runText.slice(qStart, lastQMark + 1).trim();
  }
  // No question mark yet — just show the last ~180 chars so the user sees
  // the current thrust.
  return runText.length > 180 ? "…" + runText.slice(-180) : runText;
}

/**
 * Top bar. Five phase states, evaluated in order (first match wins):
 *
 *   1. Awaiting Identity — `!rolesConfirmed && hasUtterances`
 *      Pre-session prompt: user hasn't tagged interviewer/candidate yet.
 *   2. Waiting For First — `!hasUtterances && !mainQuestion && !summary`
 *      Pre-session: recording started but no utterance has landed.
 *   3. Candidate's Question — Reverse Q&A. Three sources:
 *        (a) `timelinePhaseKind === candidate_asking` (upload mode)
 *        (b) `state === candidate_questioning && liveCandidateQuestionText`
 *            (live, fresh from classifier; may flicker)
 *        (c) `lockedCandidateQuestionText && !mainQuestion` (live,
 *            persisted lock — set on cand-q-cmt commit, cleared on
 *            Lead-Q lock; survives interviewer mid-answer state flicker
 *            so the Phase bar doesn't fall back to "Interview Ongoing"
 *            while the answer is being delivered)
 *      Row 1: "CANDIDATE'S QUESTION"
 *      Row 2: candidate's question text (locked > live > timeline)
 *   4. Lead Question — `mainQuestion` is currently locked.
 *      Row 1: "LEAD QUESTION" + question text
 *      Row 2 (optional): "PROBE QUESTION" + actual probe question text.
 *        Text source: followUp.text (resolved via currentQuestionId)
 *        ?? lockedProbeQuestionText (lock survives intermediate-frame
 *        flicker between state updates and oscillations between
 *        interviewer_speaking and question_finalized).
 *        ONLY shown when an actual probe question text is available —
 *        no "asking probe…" placeholder with summary text. The summary
 *        is too vague to substitute for the real question; if the probe
 *        hasn't formally landed yet, the sub-row stays hidden.
 *   5. Interview Ongoing — fallthrough. Covers all transitional states
 *      (warm-up, between-Leads, post-reverse-Q&A wrap-up). Shows the
 *      moment summary so the user sees what's happening even when no
 *      Lead is locked. Replaces the older Warm-up / Between-Questions /
 *      Q&A-Wrap-up trio plus the fallback-archived-Lead bridging logic
 *      — those distinctions added complexity (and a "jump back to old
 *      Lead" bug) without giving the user actionable extra information.
 *
 * Live mode infers the phase from momentState + currentMainQ. Upload
 * mode uses timelinePhaseKind for path 3 (so "candidate_asking" only
 * fires when the model has extracted the reverse-Q&A phase from the
 * full recording).
 */
function CurrentQuestionBar({
  state,
  summary,
  mainQuestion,
  followUp,
  rolesConfirmed,
  hasUtterances,
  timelinePhaseKind,
  candidateAskingText,
  liveCandidateQuestionText,
  lockedCandidateQuestionText,
  lockedProbeQuestionText,
  labels,
  phoneMode = false,
}: {
  state: MomentStateKind;
  summary: string;
  mainQuestion: Question | undefined;
  followUp: Question | undefined;
  rolesConfirmed: boolean;
  hasUtterances: boolean;
  /** Upload-mode only: the kind of the phase segment at the current
   *  playback time. When this is "candidate_asking" we render the
   *  Candidate Q&A layout regardless of mainQuestion state. */
  timelinePhaseKind?: string;
  /** Upload-mode only: text to show in Row 2 of Candidate Q&A phase. */
  candidateAskingText?: string;
  /** Live-mode only: the candidate's current question text from the
   *  moment-state machine. Set when state === "candidate_questioning";
   *  reflects the classifier's freshest output and may flicker among
   *  rephrasings of the same logical Q on each 2-3s tick. */
  liveCandidateQuestionText?: string;
  /** Live-mode only: the locked candidate question. Set by orchestrator
   *  on cand-q-cmt commit (gates passed) and cleared on Lead-Q lock.
   *  Stable text, persists across moment-state flicker. Preferred over
   *  liveCandidateQuestionText for display. When set AND no mainQuestion
   *  is locked, the Phase bar renders Candidate's Question phase even
   *  if the moment state has briefly transited out of candidate_
   *  questioning (interviewer mid-answer). */
  lockedCandidateQuestionText?: string;
  /** Live-mode only: the locked Probe Question text. Set by orchestrator
   *  in addFollowUpAndStart (probe formally committed) and cleared on
   *  new-Lead lock or candidate_questioning entry. Used as a fallback
   *  source for the Probe sub-row when the `followUp` Question object
   *  is briefly unresolved (e.g. in the intermediate frame between
   *  state updates during Lead transitions). The lock survives state
   *  oscillations between interviewer_speaking and question_finalized
   *  during long answer flaps, so the Probe sub-row doesn't flicker. */
  lockedProbeQuestionText?: string;
  labels: {
    leadHeader: string;
    interviewOngoingHeader: string;
    candidateAskingHeader: string;
    waitingForFirst: string;
    awaitingIdentity: string;
    probeHeader: string;
  };
  /** "Live 演示" layout: narrow + center the question bar in sync
   *  with the output boxes. */
  phoneMode?: boolean;
}) {
  // Pre-confirmation: roles not identified yet → neutral placeholder.
  if (!rolesConfirmed && hasUtterances) {
    return (
      <BarShell phoneMode={phoneMode}>
        <Eyebrow className="animate-pulse-dot">
          {labels.awaitingIdentity}
        </Eyebrow>
      </BarShell>
    );
  }

  // Pre-start (no utterances yet): silent shell so the bar still has
  // vertical space but doesn't show a stale phase label.
  if (!hasUtterances && !mainQuestion && !summary) {
    return (
      <BarShell phoneMode={phoneMode}>
        <Eyebrow>{labels.waitingForFirst}</Eyebrow>
      </BarShell>
    );
  }

  // Candidate's Question phase. Three paths into this layout:
  //   (a) Upload mode: timelinePhaseKind === "candidate_asking", text
  //       derived from utterances at current playback position.
  //   (b) Live mode (state-driven): state === "candidate_questioning"
  //       and the moment carries the candidate's current question.
  //   (c) Live mode (lock-driven): orchestrator has locked a candidate
  //       question (cand-q-cmt commit gates passed) AND no Lead is
  //       currently locked. Persists across moment-state transitions.
  // Path (c) takes display priority over (b) once it activates, because
  // the locked text is stable and de-flickered.
  const inCandidateQuestionPhase =
    timelinePhaseKind === "candidate_asking" ||
    (state === "candidate_questioning" && !!liveCandidateQuestionText) ||
    (!!lockedCandidateQuestionText && !mainQuestion);
  if (inCandidateQuestionPhase) {
    const text =
      timelinePhaseKind === "candidate_asking"
        ? candidateAskingText
        : lockedCandidateQuestionText ?? liveCandidateQuestionText;
    return (
      <BarShell phoneMode={phoneMode}>
        <Eyebrow className="block mb-2">{labels.candidateAskingHeader}</Eyebrow>
        <QuestionBubble phoneMode={phoneMode}>
          {text && text.trim().length > 0 ? text : "…"}
        </QuestionBubble>
      </BarShell>
    );
  }

  // Question phase (Lead locked). Typography NO LONGER clamped — the
  // full Lead and Probe text wrap naturally. The Phase region uses
  // min-height + py-3 padding so the strip grows when text wraps to
  // 2 or 3 lines. Question readability beats holding a rigid frame.
  if (mainQuestion) {
    return (
      <BarShell phoneMode={phoneMode}>
        <Eyebrow className="block mb-2">{labels.leadHeader}</Eyebrow>
        <QuestionBubble phoneMode={phoneMode}>{mainQuestion.text}</QuestionBubble>

        {/* Probe Question sub-row. Shown whenever EITHER:
            (a) followUp Question object is resolved from currentQuestionId
            (b) lockedProbeQuestionText is set
            Text source: followUp.text (fresher) > lockedProbeQuestionText.
            Cleared by archiveCurrentMainAndStartNew (new Lead) or
            candidate_questioning entry — both clear lockedProbeQuestion
            in the orchestrator, so the sub-row goes away then. */}
        {(followUp || lockedProbeQuestionText) && (
          <div className="mt-3 pl-3 border-l-2 border-border">
            <Eyebrow as="div" className="mb-1">{labels.probeHeader}</Eyebrow>
            <div
              className={
                "leading-snug text-text-muted " +
                // Scale up in phone mode alongside the lead question, but
                // kept a step below it (1.15rem vs the lead's 1.4rem) so
                // the lead-vs-probe hierarchy still reads.
                (phoneMode ? "text-[1.15rem]" : "text-[15px]")
              }
            >
              {followUp?.text ?? lockedProbeQuestionText}
            </div>
          </div>
        )}
      </BarShell>
    );
  }

  // Interview Ongoing — no active Lead, not in reverse Q&A. Single
  // catch-all for warm-up, between-Leads transitions, and the wrap-up
  // tail after reverse Q&A. Shows the moment summary so the user
  // always knows what's happening.
  return (
    <BarShell phoneMode={phoneMode}>
      <Eyebrow className="block mb-2">{labels.interviewOngoingHeader}</Eyebrow>
      {summary ? (
        <div
          className={
            "leading-relaxed text-text-muted " +
            (phoneMode ? "text-[1.3rem]" : "text-[16px]")
          }
        >
          {summary}
        </div>
      ) : (
        <div className="text-[14px] text-text-subtle italic">—</div>
      )}
    </BarShell>
  );
}

/** Question-bubble — plain text, no chrome. Earlier versions used
 *  the marketing-site `.question-bubble` decoration (thick left
 *  rule + surface background) but per user feedback the chrome was
 *  competing with the question content itself. Question reads
 *  cleanest as just bold black text at a slightly elevated size.
 *
 *  Used for both Lead Question and Candidate's Question paths. The
 *  surrounding eyebrow ("LEAD QUESTION" etc.) above provides the
 *  semantic label, so the text doesn't need extra decoration to
 *  signal "this is what's on the table". */
function QuestionBubble({
  children,
  phoneMode = false,
}: {
  children: React.ReactNode;
  /** "Live 演示" layout: enlarge the question text for mobile viewers. */
  phoneMode?: boolean;
}) {
  return (
    <div
      className={
        "leading-snug text-text font-medium " +
        (phoneMode ? "text-[1.4rem]" : "text-[1.0625rem]")
      }
    >
      {children}
    </div>
  );
}

/** Wrapper for the Interview Phase section. Sits at the top of the
 *  coaching frame with a bottom divider. Uses min-height instead of a
 *  fixed height so a Lead Question that wraps to 2-3 lines still
 *  shows in full — readability beats holding a rigid rectangle. The
 *  py-3 padding gives the question text room to breathe regardless of
 *  whether it's 1 line or 3. */
function BarShell({
  children,
  phoneMode = false,
}: {
  children: React.ReactNode;
  /** "Live 演示" layout: the question bar narrows + centers in sync
   *  with the two output boxes below it, forming one narrow column. */
  phoneMode?: boolean;
}) {
  return (
    <div
      className={
        "px-5 py-4 flex flex-col shrink-0 w-full " +
        // Phone mode: top-align + internal scroll so a very long question
        // scrolls WITHIN a capped height instead of pushing the captions
        // (+ Re-tag) off the bottom of the fixed card. Wide mode keeps the
        // original vertically-centered look.
        (phoneMode
          ? "justify-start overflow-y-auto no-scrollbar mx-auto mt-4 rounded-2xl border border-border"
          : "justify-center border-b border-border")
      }
      style={{
        minHeight: PHASE_MIN_HEIGHT_PX,
        // Cap the phone-mode question bar so it can't grow unbounded and
        // shove the captions section out of the fixed-height card.
        maxHeight: phoneMode ? PHONE_QUESTION_MAX_HEIGHT_PX : undefined,
        maxWidth: phoneMode ? PHONE_BOX_MAX_WIDTH_PX : WIDE_BOX_MAX_WIDTH_PX,
        // Phone mode: solid BLACK box border (vs the default light-gray) so the
        // narrow card reads as a crisp bordered panel on the phone crop.
        borderColor: phoneMode ? "var(--color-text)" : undefined,
        transition: LAYOUT_TRANSITION,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Single-comment commentary pane (fixed height, no scrollbar).
 *
 *   - Shows the displayed comment text (live-streamed via patchCommentText
 *     into the underlying Question.comments[], looked up by id here).
 *   - Once displayed, the orchestrator enforces a min-display window before
 *     allowing the slot to be reclaimed by a new comment. Newer commentary
 *     that arrives during that window is dropped — no queue.
 *   - When the slot is empty, shows one of three placeholder copies:
 *       no current Q → "No commentary yet — waiting for the first question."
 *       current Q + candidate has spoken → animated "AI is observing…"
 *       current Q + candidate hasn't spoken → "Waiting for candidate's answer…"
 */
function CommentarySection({
  state,
  currentQuestion,
  displayed,
  listeningHint,
  candidateQuestionCommentary,
  overrideText,
  labels,
  isFullscreen = false,
  phoneMode = false,
}: {
  state: MomentStateKind;
  currentQuestion: Question | undefined;
  /** questionId may be undefined for timeline-synthesized entries that
   *  correspond to free-standing listening hints (no anchoring question).
   *  In that case the comment text flows through the `overrideText` prop
   *  and the displayed.id → currentQuestion.comments lookup is skipped.
   *  Parent nullifies this when roles aren't confirmed yet — so nothing
   *  here has to re-check that gate. */
  displayed: { id: string; questionId?: string; displayedAt: number; minMs: number } | null;
  listeningHint: string;
  /** Reverse-Q&A commentary streamed in while state === "candidate_questioning".
   *  Evaluates the candidate's question quality (specific vs. generic, ties
   *  to earlier discussion, suggests follow-up). Takes the commentary pane
   *  in the candidate_questioning phase, beating Q-A / hint which don't
   *  apply at that point in the interview. */
  candidateQuestionCommentary: string;
  /** Timeline-mode override: when set, render this text directly and
   *  skip the `displayed.id` → `currentQuestion.comments` lookup. Needed
   *  because timeline entries from the merged commentary+hints stream
   *  may not correspond to any question (free-standing listening hints
   *  have no questionId, so the lookup path fails). Live mode doesn't
   *  pass this. */
  overrideText?: string | null;
  labels: {
    heading: string;
    /** Single unified idle placeholder, e.g. "AI is observing…". Used in
     *  every empty state — role-identification, warm-up, between-Qs,
     *  waiting-for-answer, candidate-mid-answer. */
    observing: string;
  };
  /** When true, the section grows to fill its flex parent instead of
   *  using the default 16:9-derived fixed height. Prevents whitespace
   *  below the captions in fullscreen mode. */
  isFullscreen?: boolean;
  /** "Live 演示" layout: this box goes narrow (centered) + taller. */
  phoneMode?: boolean;
}) {
  // Re-render when the displayed comment's min-window expires so the
  // "AI is observing…" indicator can appear.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!displayed) return;
    const remaining = displayed.displayedAt + displayed.minMs - Date.now();
    if (remaining <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), remaining + 50);
    return () => clearTimeout(id);
  }, [displayed]);

  // Listening-hint visibility window: length-based, NOT a fixed 6s.
  //
  // The orchestrator streams tokens into `listeningHint` live. Each time
  // the text changes we refresh `hintChangedAt` — that timestamp anchors
  // the visibility countdown. While the model is still streaming new
  // tokens the anchor keeps moving, so the hint stays visible. After the
  // last token arrives the anchor freezes, and the hint stays on screen
  // for `computePaneMinDisplayMs(finalText)` more — long enough for the
  // user to actually read it (e.g. ~51.5s for a 200-char Chinese hint
  // per the user's spec, vs the old fixed 6s which truncated mid-read).
  //
  // Once the window expires, the hint goes "stale" → freshness flag flips
  // false → the consume-once retire effect (below) clears it from the
  // store so a stale hint can never come back when nothing else is
  // showing.
  const [hintChangedAt, setHintChangedAt] = useState<number>(0);
  const lastHintRef = useRef<string>("");
  useEffect(() => {
    if (listeningHint !== lastHintRef.current) {
      lastHintRef.current = listeningHint;
      setHintChangedAt(Date.now());
    }
  }, [listeningHint]);
  const hintMinDisplayMs = computePaneMinDisplayMs(listeningHint);
  // Schedule a re-render exactly when the visibility window elapses, so
  // the hint visibly clears even if no other state changes nudge us.
  useEffect(() => {
    if (!listeningHint || listeningHint.trim().length === 0) return;
    if (hintChangedAt === 0) return;
    const age = Date.now() - hintChangedAt;
    const remaining = hintMinDisplayMs - age;
    if (remaining <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), remaining + 50);
    return () => clearTimeout(id);
  }, [listeningHint, hintChangedAt, hintMinDisplayMs]);
  const listeningHintFresh =
    listeningHint.trim().length > 0 &&
    hintChangedAt > 0 &&
    Date.now() - hintChangedAt < hintMinDisplayMs;

  // Resolve which comment text to show.
  //   - Timeline mode: use overrideText directly (fast path).
  //   - Live mode: look up displayed.id in currentQuestion.comments.
  const displayedComment = useMemo(() => {
    if (typeof overrideText === "string" && overrideText.trim().length > 0) {
      return { id: "timeline", text: overrideText };
    }
    if (!displayed) return null;
    if (!currentQuestion || displayed.questionId !== currentQuestion.id) return null;
    return currentQuestion.comments.find((c) => c.id === displayed.id) ?? null;
  }, [overrideText, displayed, currentQuestion]);

  // Candidate-question commentary takes the TOP priority slot when the
  // session has shifted into reverse Q&A. The prior Q-A commentary
  // (about the candidate's last answer) is no longer relevant — the
  // candidate is now asking, and the user wants the question-quality
  // evaluation. This intentionally overrides even an in-window Q-A
  // commentary, because the phase has changed.
  const showCandidateQuestionCommentary =
    state === "candidate_questioning" &&
    candidateQuestionCommentary.trim().length > 0;

  // Is the Q-A commentary still inside its minimum-display window?
  // While inside, it's "being read" — absolutely nothing can replace it.
  // Once the window expires AND a fresh listening hint is ready, we let
  // the hint take the pane.
  const qaStillFresh =
    !showCandidateQuestionCommentary &&
    !!displayedComment &&
    displayed !== null &&
    Date.now() - displayed.displayedAt < displayed.minMs;
  // Listen-hint visibility is gated PURELY on freshness (i.e. still
  // within min-display window), NOT on the current moment-state. The
  // orchestrator already ensures hints are only GENERATED during
  // interviewer monologues, so by the time a hint is in
  // `listeningHint`, it's content that was relevant when it was made.
  // Once it's been displayed to the user, it must remain visible for
  // its full reading window — even if the state machine has since
  // moved to closing/chitchat/etc. Otherwise we get the bug seen in
  // the 32-min log: hint at 31:49 (state=closing) was retired
  // immediately because closing wasn't in the eligible-states list,
  // and the user never saw a 261-char hint they had ~67s of reading
  // time for.
  //
  // Higher-priority slots (candidate-q commentary in
  // candidate_questioning state) still override the hint, but a
  // generic state change (interviewer_speaking → closing) does not.
  const shouldYieldToHint = !qaStillFresh && listeningHintFresh;
  const isShowing =
    !showCandidateQuestionCommentary &&
    !!displayedComment &&
    !shouldYieldToHint;

  // Listening-hint takes the commentary slot whenever it's still fresh
  // (i.e. within its content-length-derived min-display window). Priority:
  //   candidate-question commentary > fresh Q-A commentary >
  //   fresh listening-hint > idle
  const showListeningHint =
    !showCandidateQuestionCommentary && !isShowing && listeningHintFresh;

  // Any moment the pane has nothing concrete to show (no Q-A commentary,
  // no listening hint, no candidate-question commentary) we unify on a
  // single "AI is observing…" placeholder with animated dots. Previously
  // we split into five different messages (identifying / waiting-first
  // / waiting-answer / between-Qs / observing) — too noisy, each
  // transition felt like the AI changed its mind. The dots + single
  // short line keeps the pane visually alive and semantically
  // consistent across every idle state.
  const isIdle =
    !showCandidateQuestionCommentary && !isShowing && !showListeningHint;

  // ============================================================
  // Consume-once: each piece of content shows ONCE; once it's been
  // yielded to (or aged out of) the slot, it never comes back.
  //
  // The bug this fixes: previously, if Commentary 1 was showing and a
  // Listening Hint took over, Commentary 1 stayed in `displayedComment`
  // in the store. When the hint went stale, the priority logic re-
  // resolved to Commentary 1 → it popped back. Combined with new hints
  // arriving, the pane visibly flickered Commentary↔Hint↔Commentary↔Hint.
  //
  // Fix: derive a single "shown kind" identifier from the priority logic
  // above, and on every transition AWAY from a non-idle kind, retire that
  // source's underlying state slot (set it to null / ""). Once retired,
  // the source can't reappear unless fresh content actually streams in.
  // ============================================================
  const setDisplayedComment = useStore((s) => s.setDisplayedComment);
  const setLiveListeningHint = useStore((s) => s.setLiveListeningHint);
  const setLiveCandidateQuestionCommentary = useStore(
    (s) => s.setLiveCandidateQuestionCommentary
  );
  type ShownKind = "qa" | "hint" | "candidate-q" | "idle";
  const showingKind: ShownKind = showCandidateQuestionCommentary
    ? "candidate-q"
    : showListeningHint
    ? "hint"
    : isShowing
    ? "qa"
    : "idle";
  const prevShownKindRef = useRef<ShownKind>("idle");
  useEffect(() => {
    const prev = prevShownKindRef.current;
    if (prev !== showingKind && prev !== "idle") {
      // Transitioned AWAY from a non-idle kind → retire that source so
      // it can never re-render (consume-once). Done as a side-effect
      // post-render so we don't fight React's render pipeline.
      if (prev === "qa") setDisplayedComment(null);
      else if (prev === "hint") setLiveListeningHint("");
      else if (prev === "candidate-q") setLiveCandidateQuestionCommentary("");
    }
    prevShownKindRef.current = showingKind;
  }, [
    showingKind,
    setDisplayedComment,
    setLiveListeningHint,
    setLiveCandidateQuestionCommentary,
  ]);

  // Middle pane of the coaching frame. FIXED height — locks
  // dimensions so Region Capture's BBox tracking stays stable as
  // commentary streams in. Earlier this used `minHeight` (auto-grow
  // to fit long comments), but every commentary token streamed in
  // triggered a height change which Chrome's Region Capture saw as
  // a layout event and produced visible garbled frames ("花屏") at
  // exactly those moments.
  //
  // Fixed height + `overflow: hidden` on the inner content means
  // long commentary now CLIPS at the bottom rather than pushing the
  // panel taller. The model is prompted to write 3-4 sentences /
  // ~70 words / ~150 Chinese chars (see api/commentary route) which
  // fits comfortably in 198px (~6-7 lines) at the current font size.
  // A handful of unusually long comments will get a tail-clip — an
  // acceptable trade for rock-stable recording.
  return (
    <div
      className={
        "flex flex-col shrink-0 overflow-hidden w-full " +
        // Phone mode: narrow centered card with its own border/rounding.
        // Wide mode: full-width section divided by a bottom border.
        (phoneMode
          ? "mx-auto mt-4 rounded-2xl border border-border"
          : "border-b border-border")
      }
      style={{
        height: phoneMode
          ? COMMENTARY_PHONE_HEIGHT_PX
          : COMMENTARY_TOTAL_HEIGHT_PX,
        maxWidth: phoneMode ? PHONE_BOX_MAX_WIDTH_PX : WIDE_BOX_MAX_WIDTH_PX,
        // Phone mode: solid BLACK box border (vs the default light-gray).
        borderColor: phoneMode ? "var(--color-text)" : undefined,
        transition: LAYOUT_TRANSITION,
      }}
    >
      <div
        className="flex items-center px-5 shrink-0"
        style={{ height: COMMENTARY_HEADING_HEIGHT_PX }}
      >
        <Eyebrow>{labels.heading}</Eyebrow>
      </div>

      {/* Idle state ("AI is observing…") renders WITHOUT the
          bordered surface card — just centered dots + text floating
          on the section's white background, no chrome. Per user
          feedback: the box was over-decorating an empty waiting
          state. The bordered card returns the moment actual
          commentary starts streaming.

          Dots use the gentler `animate-pulse-dot` keyframe (opacity
          fade) instead of the previous `animate-bounce-dot`
          (vertical bounce) — pulse reads as "thinking quietly",
          bounce read as "loading something". For an ambient
          listening indicator the calmer pulse fits better. */}
      {isIdle ? (
        <div className="flex-1 flex items-center justify-center mb-3">
          <div className="inline-flex items-center gap-2.5 text-text-subtle italic text-sm">
            <span className="inline-flex gap-[3px]">
              <span className="w-[5px] h-[5px] rounded-full bg-text animate-pulse-dot" />
              <span className="w-[5px] h-[5px] rounded-full bg-text animate-pulse-dot [animation-delay:.2s]" />
              <span className="w-[5px] h-[5px] rounded-full bg-text animate-pulse-dot [animation-delay:.4s]" />
            </span>
            {labels.observing}
          </div>
        </div>
      ) : (
        // Bordered card is flex-1 inside the fixed-height
        // CommentarySection above, with min-h-0 + overflow-hidden.
        // No scrollbar (per UX requirement: scrollbars in a live-
        // coaching panel are a friction during an interview). The
        // commentary prompt is sized to the panel's character budget
        // (see /api/commentary route — ~50 words / ~250 chars EN
        // / ~120 Chinese chars + a 15-30 word Try block) so the
        // common case fits without clipping. Rare overflow gets a
        // silent bottom clip rather than introducing a scrollbar.
        <div className="mx-5 mb-3 border border-border bg-surface rounded-md flex flex-1 min-h-0 overflow-hidden">
          {showCandidateQuestionCommentary ? (
            // Candidate-question commentary: same look as Q-A
            // commentary. Visually distinct from the listen-hint pane
            // (no 💡 / blue border); contextualized by the Phase bar
            // above showing "Candidate's Question".
            <CommentaryBody
              html={candidateQuestionCommentary || "…"}
              tone="commentary"
              phoneMode={phoneMode}
            />
          ) : showListeningHint ? (
            // Listening hint visual treatment: thicker left border +
            // smaller font so the user can tell at a glance this is
            // in-the-moment coaching ("listen for X") vs post-answer
            // evaluative commentary.
            <CommentaryBody html={listeningHint} tone="hint" phoneMode={phoneMode} />
          ) : isShowing && displayedComment ? (
            <CommentaryBody
              html={displayedComment.text || "…"}
              tone="commentary"
              phoneMode={phoneMode}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Per-speaker-lane live caption pane.
 *
 * Rationale: a rolling-window, newest-at-top caption list shuffles every
 * time a new utterance lands or an old one ages out — hard to read. This
 * version gives each speaker a fixed lane that only changes when THAT
 * speaker produces new text, so the reader's eye can settle on a single
 * vertical position per speaker.
 *
 *   - Two fixed lanes, stacked: lane A on top, lane B on bottom.
 *   - Lane A binds to the Interviewer's Deepgram speaker id once identified;
 *     lane B binds to the Candidate's. Before identification, lane A =
 *     first-seen speaker, lane B = second-seen speaker.
 *   - Each lane shows the latest continuous run of utterances by its
 *     speaker (i.e. the most recent uninterrupted "turn"). When the OTHER
 *     speaker takes the floor, this lane's text freezes until this speaker
 *     speaks again.
 *   - Interim text appends to whichever lane the current speaker owns.
 */
/** Modal that lets the user correct a mis-assigned speaker role
 *  mid-session. Lists every dgSpeaker that has produced at least one
 *  utterance, alongside their current role and a sample line so the
 *  user can identify who's who. Each speaker has Interviewer /
 *  Candidate buttons that immediately call `forceSetSpeakerRole` —
 *  no save step, the change is live so the user sees the captions
 *  re-label in real time and can confirm. Caveats:
 *    - Utterance role labels in the captions update immediately
 *      (computed from speakerRoles each render).
 *    - Per-question `answerText` accumulated BEFORE the re-tag is
 *      already baked in with the wrong role. For long sessions where
 *      the mistake is caught late, the user should restart. Re-tagging
 *      is most useful for early-session mis-clicks. */
function RetagSpeakersModal({
  open,
  onClose,
  utterances,
  speakerRoles,
  onForceRole,
  labels,
}: {
  open: boolean;
  onClose: () => void;
  utterances: Utterance[];
  speakerRoles: Record<number, "interviewer" | "candidate">;
  onForceRole: (
    dgSpeaker: number,
    role: "interviewer" | "candidate"
  ) => void;
  labels: {
    title: string;
    description: string;
    interviewer: string;
    candidate: string;
    sample: string;
    unlabeled: string;
    close: string;
    noSpeakers: string;
  };
}) {
  // Build per-speaker rows: distinct dgSpeaker numbers seen so far,
  // plus their first utterance text (a short sample to help the user
  // identify which voice this is). Sorted by first-appearance order.
  const speakers = useMemo(() => {
    const firstSeen = new Map<number, Utterance>();
    for (const u of utterances) {
      if (u.dgSpeaker === undefined) continue;
      if (firstSeen.has(u.dgSpeaker)) continue;
      firstSeen.set(u.dgSpeaker, u);
    }
    return Array.from(firstSeen.entries())
      .map(([dg, u]) => ({
        dgSpeaker: dg,
        sample: u.text,
        role: speakerRoles[dg],
      }))
      .sort((a, b) => a.dgSpeaker - b.dgSpeaker);
  }, [utterances, speakerRoles]);

  return (
    <ModalShell open={open} onClose={onClose}>
      <div className="p-7 px-8">
        <h2 className="text-[18px] font-semibold mb-1.5 text-text">
          {labels.title}
        </h2>
        <div className="text-sm text-text-muted mb-5 leading-relaxed">
          {labels.description}
        </div>

        {speakers.length === 0 ? (
          <div className="py-6 text-center text-[13px] text-text-subtle italic">
            {labels.noSpeakers}
          </div>
        ) : (
          <div className="space-y-3 mb-4">
            {speakers.map((s) => (
              <div
                key={s.dgSpeaker}
                className="border border-border rounded-md p-3 bg-surface"
              >
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-text-subtle">
                    Speaker {s.dgSpeaker}
                    {s.role && (
                      <span className="ml-2 normal-case font-normal text-text-muted">
                        · current: <strong className="text-text">{s.role === "interviewer" ? labels.interviewer : labels.candidate}</strong>
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-[12px] text-text-muted italic mb-2.5 leading-snug line-clamp-2">
                  <span className="text-text-subtle not-italic mr-1">
                    {labels.sample}:
                  </span>
                  &ldquo;{s.sample}&rdquo;
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={s.role === "interviewer" ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => onForceRole(s.dgSpeaker, "interviewer")}
                    className="flex-1"
                  >
                    {labels.interviewer}
                  </Button>
                  <Button
                    variant={s.role === "candidate" ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => onForceRole(s.dgSpeaker, "candidate")}
                    className="flex-1"
                  >
                    {labels.candidate}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end mt-4">
          <Button onClick={onClose}>{labels.close}</Button>
        </div>
      </div>
    </ModalShell>
  );
}

function LiveCaptions({
  utterances,
  interim,
  isRecording,
  speakerRoles,
  maxTimeSec,
  onRetagClick,
  retagLabel,
  labels,
  isFullscreen = false,
}: {
  utterances: Utterance[];
  interim: string;
  isRecording: boolean;
  speakerRoles: Record<number, "interviewer" | "candidate">;
  /** When true, captions section uses a taller fixed height so larger
   *  caption text has room to breathe. Default false matches the
   *  16:9-derived sizing of normal mode. */
  isFullscreen?: boolean;
  /** When set (upload + timeline mode), treat only utterances whose
   *  `atSeconds + duration` (i.e. end time) ≤ maxTimeSec as visible.
   *  Scrubbing backwards hides later utterances; forward reveals them. */
  maxTimeSec?: number;
  /** Live-mode only: opens the manual re-tag modal so the user can
   *  fix a mis-clicked role assignment mid-session (no auto-retry
   *  exists for the original speaker prompt). Undefined in upload
   *  mode → button hidden. */
  onRetagClick?: () => void;
  retagLabel?: string;
  labels: {
    heading: string;
    live: string;
    interviewer: string;
    candidate: string;
    speakerPrefix: string;
  };
}) {
  // In timeline mode, filter utterances to those that have "already
  // happened" at maxTimeSec. Utterance.atSeconds is the start; duration
  // is how long the segment was — end = atSeconds + duration.
  const visibleUtterances = useMemo(() => {
    if (maxTimeSec === undefined) return utterances;
    return utterances.filter(
      (u) => u.atSeconds + (u.duration ?? 0) <= maxTimeSec
    );
  }, [utterances, maxTimeSec]);

  const { laneA, laneB, laneBReservedRole, laneAReservedRole } = useMemo(() => {
    let interviewerDg: number | undefined;
    let candidateDg: number | undefined;
    for (const [k, v] of Object.entries(speakerRoles)) {
      const n = Number(k);
      if (!Number.isFinite(n)) continue;
      if (v === "interviewer") interviewerDg = n;
      else if (v === "candidate") candidateDg = n;
    }
    const firstAppearance: number[] = [];
    const seen = new Set<number>();
    for (const u of visibleUtterances) {
      if (u.dgSpeaker === undefined || seen.has(u.dgSpeaker)) continue;
      seen.add(u.dgSpeaker);
      firstAppearance.push(u.dgSpeaker);
    }
    // Lane assignment with role-aware reservation.
    //
    // Convention: lane A = interviewer slot, lane B = candidate slot.
    //
    // Earlier the lane fallback was `interviewerDg ?? firstAppearance[0]`
    // which leaked the first-spoken dg into lane A even when that dg's
    // role was known to be candidate. Concretely: user tags dg:0 as
    // candidate before dg:1 has spoken → laneA falls through to dg:0
    // (the candidate) and laneB dedupes to undefined → lane A shows
    // candidate text under the "Candidate" label, lane B is empty.
    // The user's expected "Interviewer · waiting to speak" placeholder
    // never appears.
    //
    // Fix: when ONE role is tagged but the OPPOSITE dg hasn't spoken
    // yet, leave that lane explicitly undefined so the reserved-role
    // placeholder kicks in. The dg fallback only applies when NO role
    // is tagged (initial state, before the user picks anything).
    const laneA: number | undefined =
      interviewerDg !== undefined
        ? interviewerDg
        : candidateDg !== undefined
        ? // Candidate is tagged, interviewer not yet → reserve laneA
          undefined
        : firstAppearance[0];
    let laneB: number | undefined =
      candidateDg !== undefined
        ? candidateDg
        : interviewerDg !== undefined
        ? // Interviewer is tagged, candidate not yet → reserve laneB
          undefined
        : firstAppearance.find((s) => s !== laneA);
    // Defensive dedupe: a lingering edge case (e.g. role map racing
    // with utterance arrival) could still collapse both lanes onto the
    // same dg. Force laneB empty in that case so we don't render
    // duplicate text.
    if (laneA !== undefined && laneA === laneB) laneB = undefined;

    // Pre-label the empty lane once the user has tagged one role.
    // When laneA is empty AND candidate is tagged, we know laneA is
    // waiting for the interviewer (so reserve "interviewer"). Mirror
    // logic for laneB.
    const laneAReservedRole: "interviewer" | "candidate" | undefined =
      laneA === undefined && candidateDg !== undefined
        ? "interviewer"
        : undefined;
    const laneBReservedRole: "interviewer" | "candidate" | undefined =
      laneB === undefined && interviewerDg !== undefined
        ? "candidate"
        : undefined;

    return { laneA, laneB, laneAReservedRole, laneBReservedRole };
  }, [visibleUtterances, speakerRoles]);

  const lastDgSpeaker =
    visibleUtterances.length > 0
      ? visibleUtterances[visibleUtterances.length - 1].dgSpeaker
      : undefined;

  /**
   * Per-dgSpeaker cache of each speaker's most recent continuous run of
   * utterances. In LIVE mode (maxTimeSec undefined) this is a real cache
   * protecting against the rolling-window trim. In TIMELINE mode each
   * render re-derives from visibleUtterances directly, since scrubbing
   * changes the set and stale cache entries would show ghost text.
   */
  const [textCache, setTextCache] = useState<Record<number, string>>({});

  const latestRunTextFrom = (arr: Utterance[], dg: number): string => {
    let end = -1;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].dgSpeaker === dg) {
        end = i;
        break;
      }
    }
    if (end === -1) return "";
    let start = end;
    while (start > 0 && arr[start - 1].dgSpeaker === dg) start--;
    return arr
      .slice(start, end + 1)
      .map((u) => u.text)
      .join(" ");
  };

  useEffect(() => {
    if (maxTimeSec !== undefined) return; // timeline mode skips the cache
    if (visibleUtterances.length === 0) return;

    setTextCache((prev) => {
      let next = prev;
      const clone = () => {
        if (next === prev) next = { ...prev };
      };

      // Always refresh the speaker currently holding the floor — their
      // run is actively growing.
      if (lastDgSpeaker !== undefined) {
        const fresh = latestRunTextFrom(visibleUtterances, lastDgSpeaker);
        if (prev[lastDgSpeaker] !== fresh) {
          clone();
          next[lastDgSpeaker] = fresh;
        }
      }

      // Seed any speaker we've seen but don't yet have text for. Does
      // nothing on normal turns since the current speaker is handled
      // above; matters only on first appearance or after rehydration.
      const seen = new Set<number>();
      for (const u of visibleUtterances) {
        if (u.dgSpeaker !== undefined) seen.add(u.dgSpeaker);
      }
      for (const dg of seen) {
        if (next[dg] !== undefined) continue;
        const t = latestRunTextFrom(visibleUtterances, dg);
        if (t) {
          clone();
          next[dg] = t;
        }
      }

      return next;
    });
  }, [visibleUtterances, lastDgSpeaker, maxTimeSec]);

  // Text per lane. Timeline mode: derive directly from visibleUtterances
  // so scrubbing updates the captions immediately. Live mode: read from
  // the cache so a quiet speaker's text survives the rolling-window trim.
  const textA =
    laneA === undefined
      ? ""
      : maxTimeSec !== undefined
      ? latestRunTextFrom(visibleUtterances, laneA)
      : textCache[laneA] ?? "";
  const textB =
    laneB === undefined
      ? ""
      : maxTimeSec !== undefined
      ? latestRunTextFrom(visibleUtterances, laneB)
      : textCache[laneB] ?? "";

  const laneName = (
    dg: number | undefined,
    reservedRole: "interviewer" | "candidate" | undefined,
    fallback: string
  ): string => {
    if (dg === undefined) {
      // Lane has no dg attached yet. If we've reserved a role for it
      // (user tagged the other side), show that role name — otherwise
      // fall back to the generic "Speaker N" placeholder.
      if (reservedRole === "interviewer") return labels.interviewer;
      if (reservedRole === "candidate") return labels.candidate;
      return fallback;
    }
    const role = speakerRoles[dg];
    if (role === "interviewer") return labels.interviewer;
    if (role === "candidate") return labels.candidate;
    return fallback;
  };

  const metaA = {
    name: laneName(laneA, laneAReservedRole, `${labels.speakerPrefix} 1`),
    // "reserved" = we know the role but no voice heard yet → render a
    // muted "waiting" state instead of a blank body.
    reserved: laneA === undefined && laneAReservedRole !== undefined,
  };
  const metaB = {
    name: laneName(laneB, laneBReservedRole, `${labels.speakerPrefix} 2`),
    reserved: laneB === undefined && laneBReservedRole !== undefined,
  };

  const aSpeaking = laneA !== undefined && lastDgSpeaker === laneA;
  const bSpeaking = laneB !== undefined && lastDgSpeaker === laneB;

  // Startup-delay fix: Deepgram sends interim transcripts ~1s after the
  // first speech, but diarization only lands a speaker label on the
  // FINAL result (a few seconds later). Without a speaker label, neither
  // lane "owns" the interim text and the captions look dead for the
  // first few seconds. Convention is that the interviewer starts the
  // session, so when we have interim text but no finalized utterances
  // yet, show it in lane A (the interviewer lane by convention).
  const firstInterimOrphaned =
    interim.trim().length > 0 &&
    visibleUtterances.length === 0 &&
    !aSpeaking &&
    !bSpeaking;
  const interimForA = aSpeaking || firstInterimOrphaned ? interim : "";
  const interimForB = bSpeaking ? interim : "";

  // Bottom section of the 16:9 frame. Total height is fixed; the parent
  // provides the outer border so we only contribute an inner divider
  // between the heading and lanes. Always renders two lanes (the second
  // is blank / placeholder when only one speaker exists) so the total
  // height stays constant regardless of speaker count — important for
  // the video aspect ratio.
  // Captions section: fixed sizing in all modes — same layout as
  // before fullscreen mode existed. Fullscreen doesn't change the
  // card's interior, only hides chrome around it.
  return (
    <div
      className="bg-surface flex flex-col shrink-0"
      style={{ height: CAPTIONS_TOTAL_HEIGHT_PX }}
    >
      <div
        className="px-4 border-b border-border flex items-center gap-3 shrink-0"
        style={{ height: CAPTIONS_HEADING_HEIGHT_PX }}
      >
        <Eyebrow>{labels.heading}</Eyebrow>
        {isRecording && (
          // Recording indicator. Uses the functional --color-error red
          // (replaces the old "live" hue) for the dot so all alert/
          // recording reds across the app are the same hue. Eyebrow-
          // sized text in mono color since accent has been collapsed
          // to mono in this design system.
          <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-text uppercase tracking-wider">
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse-dot"
              style={{ background: "var(--color-error)" }}
            />
            {labels.live}
          </span>
        )}
        {onRetagClick && (
          // Manual role re-tagging escape hatch. Sits in the captions
          // header right side so the user knows where to click if they
          // realize they mis-assigned interviewer/candidate at the
          // start. Discoverable but not noisy. Only renders in live
          // mode (upload mode pre-identifies via Haiku).
          <button
            onClick={onRetagClick}
            className="ml-auto inline-flex items-center gap-1 text-[12.5px] text-text-subtle hover:text-text transition-colors"
            title="Re-tag interviewer / candidate"
          >
            {/* Refresh/cycle icon — SVG to avoid `↻` U+21BB
                font-fallback issues. */}
            <svg
              width="11"
              height="11"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7a4 4 0 1 1 1.2 2.85" />
              <polyline points="3 6 3 9.5 6.5 9.5" />
            </svg>
            <span>{retagLabel || "Re-tag"}</span>
          </button>
        )}
      </div>
      <CaptionLane
        meta={metaA}
        text={textA}
        isSpeakingNow={aSpeaking || firstInterimOrphaned}
        interim={interimForA}
        isFullscreen={isFullscreen}
      />
      <div className="h-px bg-border" />
      <CaptionLane
        meta={metaB}
        text={textB}
        isSpeakingNow={bSpeaking}
        interim={interimForB}
        isFullscreen={isFullscreen}
      />
    </div>
  );
}

/**
 * A single caption lane. Strictly fixed height (CAPTIONS_LANE_HEIGHT_PX)
 * with the text area auto-scrolling to the bottom whenever its contents
 * grow — so when a speaker has a long turn, the reader sees the latest
 * words instead of a stale top slice. Scrollbar is hidden to keep the
 * lane looking like a caption strip rather than a list.
 *
 * Speaking indicator: the speaker label itself pulses accent-blue while
 * this lane's speaker has the floor, and is plain black otherwise. No
 * separate "LIVE" badge — the label IS the indicator.
 */
/**
 * Playback control strip shown at the top of the live view while an
 * uploaded recording is playing. Binds to the same HTMLAudioElement the
 * PlaybackSession is driving, so play/pause and seek here propagate to
 * the session (which listens to the element's own timeupdate events and
 * flushes utterances forward as needed).
 */


function CaptionLane({
  meta,
  text,
  isSpeakingNow,
  interim,
  isFullscreen = false,
}: {
  meta: { name: string; reserved?: boolean };
  text: string;
  isSpeakingNow: boolean;
  interim: string;
  /** When true, lane is taller, label column wider, gap and padding
   *  bigger — matches the bumped text scale and gives the speaker
   *  label proper breathing room. */
  isFullscreen?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only auto-scroll while THIS lane's speaker has the floor. When the
    // other speaker is talking, freeze this lane's scroll position
    // completely — otherwise every parent re-render nudges it and the
    // reader sees constant motion even though the text is unchanged.
    if (!isSpeakingNow) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, interim, isSpeakingNow]);

  // Same layout in all modes — fullscreen only hides the page
  // chrome around the card; the card and its lanes keep their
  // original dimensions so Region Capture's recording is consistent.
  return (
    <div
      className="px-4 py-1.5 flex gap-3 items-start overflow-hidden"
      style={{ height: CAPTIONS_LANE_HEIGHT_PX }}
    >
      <div className="w-[90px] shrink-0">
        <div
          className={`text-[12px] font-medium uppercase tracking-wider ${
            isSpeakingNow
              ? "text-text animate-pulse-label"
              : meta.reserved
              ? "text-text-subtle"
              : "text-text"
          }`}
        >
          {meta.name}
        </div>
      </div>
      <div
        ref={ref}
        // Font + line-height locked so EXACTLY two lines fit in the
        // CAPTIONS_LANE_HEIGHT_PX (60px) lane without a 3rd line
        // peeking through at the top. Math:
        //   - lane height       = 60px
        //   - vertical padding  = py-1.5 = 12px
        //   - usable text area  = 48px
        //   - line-height       = 24px (locked, not snug)
        //   - 2 lines           = 48px → exactly fills, line 3 starts
        //                          at 48px → entirely outside the
        //                          visible region (no peek)
        // The font bump 14 → 15.5 makes the captions a touch easier
        // to read at glance distance; the explicit leading-[24px]
        // (vs. snug = 1.375) is what guarantees the clean cutoff
        // regardless of subpixel rounding. Don't change either side
        // in isolation — they're paired.
        className="flex-1 min-w-0 text-[15.5px] leading-[24px] text-text overflow-y-auto no-scrollbar h-full"
      >
        {meta.reserved ? (
          // Role is known (the other side was tagged) but this speaker
          // hasn't been heard yet. Show an explicit waiting state so the
          // user understands the system is ready — just no voice yet.
          <span className="text-text-subtle italic inline-flex items-center gap-2">
            <span className="inline-flex gap-[3px]">
              <span className="w-[4px] h-[4px] rounded-full bg-text-subtle animate-bounce-dot" />
              <span className="w-[4px] h-[4px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.15s]" />
              <span className="w-[4px] h-[4px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.3s]" />
            </span>
            waiting to speak
          </span>
        ) : text ? (
          <>
            {text}
            {interim && (
              <span className="text-text-subtle italic"> {interim}</span>
            )}
          </>
        ) : interim ? (
          <span className="text-text-subtle italic">{interim}</span>
        ) : (
          <span className="text-text-subtle italic">—</span>
        )}
      </div>
    </div>
  );
}

