"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import type { Comment, MomentStateKind, Question, Utterance } from "@/types/session";

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
 *   Commentary:  226 px   (heading 28 + pane 198)
 *   Captions:    151 px   (heading 28 + lane 60 + divider 1 + lane 60 + border 2)
 *   ─────────────
 *   Total:       517 px   (≈ 16:9 at 920 px — same overall as before)
 *
 * Captions deliberately got smaller (12-13px text vs 14-15px) so the
 * Phase region could absorb full-text questions without truncation.
 */
const PHASE_MIN_HEIGHT_PX = 140;
const COMMENTARY_TOTAL_HEIGHT_PX = 226;
const COMMENTARY_HEADING_HEIGHT_PX = 28;
const COMMENTARY_PANE_HEIGHT_PX =
  COMMENTARY_TOTAL_HEIGHT_PX - COMMENTARY_HEADING_HEIGHT_PX; // 198
const CAPTIONS_TOTAL_HEIGHT_PX = 151;
const CAPTIONS_HEADING_HEIGHT_PX = 28;
/** Each speaker's caption lane. Smaller (60 vs old 80) since the
 *  caption font also shrunk — same line-count visible per lane. */
const CAPTIONS_LANE_HEIGHT_PX = 60;

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

/** Shared renderer for the four commentary slot variants (Q-A, listen
 *  hint, warmup, candidate-question). Splits the streamed text on the
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
}: {
  html: string;
  tone: "commentary" | "hint";
}) {
  const { commentary, suggestion } = splitCommentary(html);
  // Until the model has emitted any commentary text yet, render the
  // raw streaming buffer as-is so the user sees tokens appearing.
  const mainHtml = commentary || html || "…";

  const SuggestionBlock = suggestion ? (
    <div className="mt-2 pt-2 border-t border-accent/30 text-[12.5px] leading-relaxed text-ink-light">
      <span className="font-semibold text-accent text-[11px] uppercase tracking-wider mr-1.5">
        💬 Try
      </span>
      <em
        className="not-italic"
        // Re-italicize via inline style so <strong> tags inside the
        // suggestion stay non-italic per typographic convention while
        // the plain text reads italic.
        style={{ fontStyle: "italic" }}
        dangerouslySetInnerHTML={{ __html: suggestion }}
      />
    </div>
  ) : null;

  if (tone === "hint") {
    return (
      <div className="w-full h-full flex border-l-[3px] border-accent bg-accent-bg/40 animate-appear">
        <div className="pl-3 pr-1 pt-3 text-[15px] leading-none shrink-0 select-none">
          💡
        </div>
        <div className="flex-1 min-w-0 pr-4 py-3 overflow-y-auto no-scrollbar text-[13.5px] leading-relaxed text-ink prose-live">
          <div dangerouslySetInnerHTML={{ __html: mainHtml }} />
          {SuggestionBlock}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 w-full h-full overflow-y-auto no-scrollbar text-[14.5px] leading-relaxed text-ink prose-live animate-appear">
      <div dangerouslySetInnerHTML={{ __html: mainHtml }} />
      {SuggestionBlock}
    </div>
  );
}

export function LiveView() {
  const t = useTranslations();
  const questions = useStore((s) => s.liveQuestions);
  const live = useStore((s) => s.live);
  const utterances = useStore((s) => s.liveUtterances);
  const speakerRoles = useStore((s) => s.liveSpeakerRoles);
  const moment = useStore((s) => s.liveMomentState);
  const displayedComment = useStore((s) => s.liveDisplayedComment);
  const listeningHint = useStore((s) => s.liveListeningHint);
  const warmupCommentary = useStore((s) => s.liveWarmupCommentary);
  const candidateQuestionCommentary = useStore(
    (s) => s.liveCandidateQuestionCommentary
  );
  const timeline = useStore((s) => s.liveTimeline);
  const playbackTime = useStore((s) => s.livePlaybackTime);
  const isUploadMode = useStore((s) => s.liveIsUploadMode);

  const [interim, setInterim] = useState("");
  useEffect(() => {
    const handler = (e: Event) => setInterim((e as CustomEvent).detail as string);
    window.addEventListener("ic:interim", handler);
    return () => window.removeEventListener("ic:interim", handler);
  }, []);

  // Upload-mode playback: PlaybackSession emits "ic:playback-started"
  // carrying the HTMLAudioElement in event.detail when it begins. We
  // hold a ref so the LivePlayerStrip can render a scrubber bound to
  // the same audio element the session is driving — seeking in the UI
  // advances the session naturally (PlaybackSession listens to its own
  // audio element's timeupdate event, so UI seeks trigger utterance
  // flushes automatically).
  const [playbackAudio, setPlaybackAudio] = useState<HTMLAudioElement | null>(
    null
  );
  useEffect(() => {
    const onStart = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail instanceof HTMLAudioElement) setPlaybackAudio(detail);
    };
    const onStop = () => setPlaybackAudio(null);
    window.addEventListener("ic:playback-started", onStart);
    window.addEventListener("ic:playback-stopped", onStop);
    return () => {
      window.removeEventListener("ic:playback-started", onStart);
      window.removeEventListener("ic:playback-stopped", onStop);
    };
  }, []);

  // ReviewPanel dispatches `ic:seek-to` with a seconds number when the
  // user clicks an entry. We own the audio element here, so we do the
  // actual seek — keeps ReviewPanel decoupled from the playback source.
  useEffect(() => {
    if (!playbackAudio) return;
    const handler = (e: Event) => {
      const sec = (e as CustomEvent).detail;
      if (typeof sec !== "number" || !isFinite(sec)) return;
      playbackAudio.currentTime = Math.max(0, sec);
    };
    window.addEventListener("ic:seek-to", handler);
    return () => window.removeEventListener("ic:seek-to", handler);
  }, [playbackAudio]);

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

  // Earlier-in-interview: every question that is NOT in the current main's
  // tree. Group by main.
  const archivedMains = useMemo(() => {
    const currentMainId = currentMainQ?.id;
    return questions.filter(
      (q) => !q.parentQuestionId && q.id !== currentMainId
    );
  }, [questions, currentMainQ]);

  const followUpsByParent = useMemo(() => {
    const map = new Map<string, Question[]>();
    for (const q of questions) {
      if (!q.parentQuestionId) continue;
      const list = map.get(q.parentQuestionId) ?? [];
      list.push(q);
      map.set(q.parentQuestionId, list);
    }
    return map;
  }, [questions]);

  const hasStarted = live.status !== "idle" || questions.length > 0;

  if (!hasStarted) {
    return (
      <>
        <PageTitle />
        <div className="flex-1 overflow-y-auto">
          <div className="text-center py-20 px-5 text-ink-lighter">
            <div className="text-[44px] mb-3.5 opacity-50">🎙️</div>
            <div className="text-sm">
              {t("Click ", "点 ")}<b>Start</b>{t(" to begin.", " 开始")}
            </div>
          </div>
        </div>
      </>
    );
  }

  // Map timeline phase → MomentStateKind so existing subcomponents can
  // render without knowing about timeline mode. When no timeline,
  // straight-through from store moment.state.
  const phaseToMomentState = (p?: { kind: string }): MomentStateKind => {
    switch (p?.kind) {
      case "chitchat":
      case "between_questions":
        return "chitchat";
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

  return (
    <>
      <PageTitle />

      {/* Uploaded-recording playback controls. Only mounts when an upload
          session is actively driving playback. The scrubber works on the
          same HTMLAudioElement the PlaybackSession listens to, so seeks
          naturally flush utterances forward. Seeking backwards is a pure
          listen-along; we don't re-emit already-processed utterances. */}
      {playbackAudio && <LivePlayerStrip audio={playbackAudio} />}

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-24 pt-5 pb-20 max-[900px]:px-5">

          {/* ===== Coaching frame =====
              Three stacked sections. Total height is approximately
              16:9 at 920 px width but the Phase region is allowed to
              grow when a Lead Question text doesn't fit in 2 lines —
              question readability beats holding a perfect rectangle.
              Commentary and Captions are fixed heights; only Phase
              flexes. */}
          <div className="border border-rule rounded-md overflow-hidden bg-paper flex flex-col mb-6">
            {/* (1) Current Question — fixed-height top bar. */}
            <CurrentQuestionBar
              state={effectiveState}
              summary={moment.summary}
              mainQuestion={rolesConfirmed ? currentMainQ : undefined}
              followUp={rolesConfirmed ? currentFollowUpQ : undefined}
              // Fallback Lead — the most recently archived Lead. Used by
              // the bar when `currentMainQ` is undefined (e.g. just
              // exited candidate_questioning, or briefly between
              // archive-and-new-lock). Per spec, the Phase region only
              // ever shows "Lead Question" or "Candidate's Question"
              // during the interview proper — no "Between Questions"
              // gap. archivedMains is chronological; last entry is the
              // most recent.
              fallbackArchivedLead={
                rolesConfirmed && archivedMains.length > 0
                  ? archivedMains[archivedMains.length - 1]
                  : undefined
              }
              rolesConfirmed={rolesConfirmed}
              hasUtterances={hasUtterances}
              hasEverHadLead={
                currentMainQ !== undefined || archivedMains.length > 0
              }
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
              // Live-mode reverse-Q&A text. When the orchestrator's state
              // machine is in `candidate_questioning`, moment carries the
              // candidate's current question text on the MomentState
              // itself (set atomically with the state transition). Pass
              // it down so the Phase region renders the question.
              liveCandidateQuestionText={
                rolesConfirmed && moment.state === "candidate_questioning"
                  ? moment.candidateQuestion
                  : undefined
              }
              labels={{
                leadHeader: t("Lead Question", "主问题"),
                warmupHeader: t(
                  "Warm-up · Interviewer Introduction",
                  "热身 · 面试官介绍"
                ),
                betweenQuestionsHeader: t(
                  "Between Questions · Interviewer Transitioning",
                  "问题间隙 · 面试官切换话题"
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
                interviewerAskingFollowUp: t(
                  "Interviewer is asking a probe question…",
                  "面试官正在追问…"
                ),
              }}
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
              warmupCommentary={rolesConfirmed ? warmupCommentary : ""}
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
            />

            {/* (3) Live Captions — two speaker lanes stacked, fixed. */}
            <LiveCaptions
              utterances={utterances}
              interim={interim}
              isRecording={live.status === "recording"}
              speakerRoles={speakerRoles}
              maxTimeSec={isUploadMode ? playbackTime : undefined}
              labels={{
                heading: t("LIVE CAPTIONS", "实时字幕"),
                live: t("LIVE", "直播中"),
                interviewer: t("Interviewer", "面试官"),
                candidate: t("Candidate", "候选人"),
                speakerPrefix: t("Speaker", "发言者"),
              }}
            />
          </div>

          {/* Earlier in this interview — archived mains, with follow-ups.
              Lives OUTSIDE the 16:9 video frame — a normal scrolling
              list below the block. */}
          {archivedMains.length > 0 && (
            <>
              <div className="mt-7 mb-3 text-[11px] text-ink-lighter font-semibold tracking-wide uppercase">
                {t("Earlier in this interview", "本场之前的问题")}
              </div>
              {archivedMains
                .slice()
                .reverse()
                .map((main, idx) => (
                  <ArchivedMainBlock
                    key={main.id}
                    main={main}
                    followUps={followUpsByParent.get(main.id) ?? []}
                    num={archivedMains.length - idx}
                    defaultOpen={idx === 0}
                    labels={{
                      followUp: t("Probe Question", "追问"),
                      noCommentary: t("No commentary.", "暂无评论。"),
                    }}
                  />
                ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

function PageTitle() {
  // liveTitle is populated after /api/session-title returns — it derives a
  // role-and-company heading from the JD. Until then we show the generic
  // fallback, so the heading never blanks out.
  const liveTitle = useStore((s) => s.liveTitle);
  return (
    <div className="mx-auto w-full max-w-[920px] px-24 pt-10 pb-5 max-[900px]:px-5 max-[900px]:pt-6 max-[900px]:pb-3 shrink-0">
      <div className="text-4xl font-bold tracking-tight leading-tight text-ink max-[900px]:text-[28px]">
        {liveTitle || "Live Interview Session"}
      </div>
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
 * Top bar. Shows which of FOUR phases the interview is currently in:
 *
 *   1. Warm-up / Interviewer Introduction — no Lead has EVER locked yet.
 *      Row 1: "WARM-UP · INTERVIEWER INTRODUCTION"
 *      Row 2: interim summary (what the interviewer is building toward)
 *   2. Between Questions — at least one Lead has locked, current one
 *      has been archived, new one hasn't locked yet. Interviewer is
 *      transitioning between topics.
 *      Row 1: "BETWEEN QUESTIONS · INTERVIEWER TRANSITIONING"
 *      Row 2: interim summary
 *   3. Question (面试中) — a Lead is currently active.
 *      Row 1: "LEAD QUESTION" + question text
 *      Row 2: "PROBE QUESTION" + probe text (only if a probe is active)
 *   4. Candidate Q&A (候选人提问环节) — reverse Q&A tail, end of interview.
 *      Row 1: "CANDIDATE Q&A"
 *      Row 2: candidate's current question
 *
 * Warm-up vs Between-Questions distinction enforces a one-time warm-up:
 * once the first Lead has locked, we never regress to "WARM-UP" even if
 * the current Lead is briefly archived during a topic pivot.
 *
 * Live mode (no timeline) infers the phase from momentState + Lead
 * history. Upload mode uses the timeline's phase.kind directly (so
 * "candidate_asking" only fires when the model has extracted the
 * reverse-Q&A phase, typically at the end of the recording).
 */
function CurrentQuestionBar({
  state,
  summary,
  mainQuestion,
  followUp,
  fallbackArchivedLead,
  rolesConfirmed,
  hasUtterances,
  hasEverHadLead,
  timelinePhaseKind,
  candidateAskingText,
  liveCandidateQuestionText,
  labels,
}: {
  state: MomentStateKind;
  summary: string;
  mainQuestion: Question | undefined;
  followUp: Question | undefined;
  /** Most recently archived Lead — used as the visual fallback when
   *  `mainQuestion` is undefined and we're past warmup. Per the user's
   *  spec, the Phase region must only ever show "Lead Question" or
   *  "Candidate's Question" during the interview, never an empty
   *  "Between Questions" frame. So when there's a transient gap (e.g.
   *  candidate_questioning just ended, or interviewer is mid-pivot
   *  between Leads) we fall back to displaying the previous Lead. */
  fallbackArchivedLead?: Question;
  rolesConfirmed: boolean;
  hasUtterances: boolean;
  /** True once ANY Lead has been locked in this session (including
   *  Leads that have since been archived). Controls warm-up vs
   *  fallback-lead labeling when mainQuestion is undefined. */
  hasEverHadLead: boolean;
  /** Upload-mode only: the kind of the phase segment at the current
   *  playback time. When this is "candidate_asking" we render the
   *  Candidate Q&A layout regardless of mainQuestion state. */
  timelinePhaseKind?: string;
  /** Upload-mode only: text to show in Row 2 of Candidate Q&A phase. */
  candidateAskingText?: string;
  /** Live-mode only: the candidate's current question to the interviewer
   *  during the reverse-Q&A phase. Carried on liveMomentState
   *  .candidateQuestion when state === "candidate_questioning". When
   *  set, the Phase region renders "Candidate's Question" + this text,
   *  parallel to the upload-mode candidate_asking path. */
  liveCandidateQuestionText?: string;
  labels: {
    leadHeader: string;
    warmupHeader: string;
    betweenQuestionsHeader: string;
    candidateAskingHeader: string;
    waitingForFirst: string;
    awaitingIdentity: string;
    probeHeader: string;
    interviewerAskingFollowUp: string;
  };
}) {
  // Pre-confirmation: roles not identified yet → neutral placeholder.
  if (!rolesConfirmed && hasUtterances) {
    return (
      <BarShell>
        <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider animate-pulse-dot">
          {labels.awaitingIdentity}
        </div>
      </BarShell>
    );
  }

  // Pre-start (no utterances yet): silent shell so the bar still has
  // vertical space but doesn't show a stale phase label.
  if (!hasUtterances && !mainQuestion && !summary) {
    return (
      <BarShell>
        <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider">
          {labels.waitingForFirst}
        </div>
      </BarShell>
    );
  }

  // Candidate's Question phase. Two paths into this layout:
  //   (a) Upload mode: timelinePhaseKind === "candidate_asking", text
  //       derived from utterances at current playback position.
  //   (b) Live mode: state === "candidate_questioning", text carried
  //       on the moment as `liveCandidateQuestionText` (set atomically
  //       by the orchestrator when the classifier flips into reverse Q&A).
  // Same visual; only the source of the text differs.
  const inCandidateQuestionPhase =
    timelinePhaseKind === "candidate_asking" ||
    (state === "candidate_questioning" && !!liveCandidateQuestionText);
  if (inCandidateQuestionPhase) {
    const text =
      timelinePhaseKind === "candidate_asking"
        ? candidateAskingText
        : liveCandidateQuestionText;
    return (
      <BarShell>
        <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-1">
          {labels.candidateAskingHeader}
        </div>
        <div className="font-serif text-[17px] leading-snug text-ink font-medium">
          {text && text.trim().length > 0 ? text : "…"}
        </div>
      </BarShell>
    );
  }

  const showAskingFollowUp =
    !followUp && state === "interviewer_speaking" && !!mainQuestion;

  // Question phase (Lead locked). Typography NO LONGER clamped — the
  // full Lead and Probe text wrap naturally. The Phase region uses
  // min-height + py-3 padding so the strip grows when text wraps to
  // 2 or 3 lines. Question readability beats holding a rigid frame.
  if (mainQuestion) {
    return (
      <BarShell>
        <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-0.5">
          {labels.leadHeader}
        </div>
        <div className="font-serif text-[17px] leading-snug text-ink font-medium">
          {mainQuestion.text}
        </div>

        {followUp && (
          <div className="mt-2 pl-3 border-l-2 border-rule">
            <div className="text-[10px] font-semibold text-ink-lighter uppercase tracking-wider mb-0.5">
              {labels.probeHeader}
            </div>
            <div className="font-serif text-[14px] leading-snug text-ink-light">
              {followUp.text}
            </div>
          </div>
        )}

        {showAskingFollowUp && (
          <div className="mt-2 pl-3 border-l-2 border-rule">
            <div className="text-[10px] font-semibold text-ink-lighter uppercase tracking-wider inline-flex items-center gap-1.5">
              <BouncingDots />
              {labels.interviewerAskingFollowUp}
            </div>
            {summary && (
              <div className="text-[12.5px] leading-snug text-ink-light italic">
                {summary}
              </div>
            )}
          </div>
        )}
      </BarShell>
    );
  }

  // No Lead currently locked. Per the user's spec, the Phase region
  // only ever shows a Lead Question or a Candidate's Question during
  // the interview — no "Between Questions" middle state. When we land
  // here:
  //   - hasEverHadLead === true: there's a transient gap (just exited
  //     candidate_questioning, or interviewer is mid-pivot before the
  //     next Lead has actually locked). Render the most recently
  //     archived Lead so the bar stays continuous and the user
  //     doesn't see an empty frame. Visually identical to the locked-
  //     Lead branch above.
  //   - hasEverHadLead === false: genuine warm-up phase before the
  //     first Lead has ever locked. Show the warm-up placeholder.
  if (hasEverHadLead && fallbackArchivedLead) {
    return (
      <BarShell>
        <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-0.5">
          {labels.leadHeader}
        </div>
        <div className="font-serif text-[17px] leading-snug text-ink font-medium">
          {fallbackArchivedLead.text}
        </div>
      </BarShell>
    );
  }
  // Warm-up — no Lead has ever locked, before the interview proper has
  // started. Show a neutral header + summary if available.
  return (
    <BarShell>
      <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-1">
        {labels.warmupHeader}
      </div>
      {summary ? (
        <div className="font-serif text-[15px] leading-snug text-ink-light italic">
          {summary}
        </div>
      ) : (
        <div className="text-[13px] text-ink-lighter italic">—</div>
      )}
    </BarShell>
  );
}

/** Wrapper for the Interview Phase section. Sits at the top of the
 *  coaching frame with a bottom divider. Uses min-height instead of a
 *  fixed height so a Lead Question that wraps to 2-3 lines still
 *  shows in full — readability beats holding a rigid rectangle. The
 *  py-3 padding gives the question text room to breathe regardless of
 *  whether it's 1 line or 3. */
function BarShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="border-b border-rule px-5 py-3 flex flex-col justify-center shrink-0"
      style={{ minHeight: PHASE_MIN_HEIGHT_PX }}
    >
      {children}
    </div>
  );
}

function BouncingDots() {
  return (
    <span className="inline-flex gap-[3px]">
      <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot" />
      <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.15s]" />
      <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.3s]" />
    </span>
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
  warmupCommentary,
  candidateQuestionCommentary,
  overrideText,
  labels,
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
  /** Warm-up coaching commentary streamed in while candidate is speaking
   *  before any Lead Question is locked. Takes the commentary pane when
   *  a Q-A commentary isn't active AND no listening hint is streaming. */
  warmupCommentary: string;
  /** Reverse-Q&A commentary streamed in while state === "candidate_questioning".
   *  Evaluates the candidate's question quality (specific vs. generic, ties
   *  to earlier discussion, suggests follow-up). Takes the commentary pane
   *  in the candidate_questioning phase, beating Q-A / hint / warm-up which
   *  don't apply at that point in the interview. */
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
  //   fresh listening-hint > warm-up > idle
  const showListeningHint =
    !showCandidateQuestionCommentary && !isShowing && listeningHintFresh;

  // Warm-up commentary takes the pane when candidate is speaking in
  // warm-up phase (no Lead Q locked, no Q-A commentary active, no
  // listening hint streaming). This is coaching on the self-intro.
  const showWarmupCommentary =
    !showCandidateQuestionCommentary &&
    !isShowing &&
    !showListeningHint &&
    warmupCommentary.trim().length > 0 &&
    !currentQuestion;

  // Any moment the pane has nothing concrete to show (no Q-A commentary,
  // no listening hint, no warm-up commentary, no candidate-question
  // commentary) we unify on a single "AI is observing…" placeholder
  // with animated dots. Previously we split into five different messages
  // (identifying / waiting-first / waiting-answer / between-Qs /
  // observing) — too noisy, each transition felt like the AI changed
  // its mind. The dots + single short line keeps the pane visually
  // alive and semantically consistent across every idle state.
  const isIdle =
    !showCandidateQuestionCommentary &&
    !isShowing &&
    !showListeningHint &&
    !showWarmupCommentary;

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
  const setLiveWarmupCommentary = useStore((s) => s.setLiveWarmupCommentary);
  const setLiveCandidateQuestionCommentary = useStore(
    (s) => s.setLiveCandidateQuestionCommentary
  );
  type ShownKind = "qa" | "hint" | "warmup" | "candidate-q" | "idle";
  const showingKind: ShownKind = showCandidateQuestionCommentary
    ? "candidate-q"
    : showListeningHint
    ? "hint"
    : isShowing
    ? "qa"
    : showWarmupCommentary
    ? "warmup"
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
      else if (prev === "warmup") setLiveWarmupCommentary("");
      else if (prev === "candidate-q") setLiveCandidateQuestionCommentary("");
    }
    prevShownKindRef.current = showingKind;
  }, [
    showingKind,
    setDisplayedComment,
    setLiveListeningHint,
    setLiveWarmupCommentary,
    setLiveCandidateQuestionCommentary,
  ]);

  // Middle pane of the 16:9 frame. Total height is fixed; heading row +
  // pane together fit exactly COMMENTARY_TOTAL_HEIGHT_PX. The pane itself
  // has overflow-y-auto as a defensive fallback — prompts are tuned to
  // keep content within these bounds (3–4 sentences / ~60 words / ~120
  // Chinese chars) so scrolling is rare.
  return (
    <div
      className="flex flex-col border-b border-rule shrink-0"
      style={{ height: COMMENTARY_TOTAL_HEIGHT_PX }}
    >
      <div
        className="flex items-center px-5 text-[11px] text-ink-lighter tracking-wide font-medium shrink-0"
        style={{ height: COMMENTARY_HEADING_HEIGHT_PX }}
      >
        {labels.heading}
      </div>

      <div className="flex-1 min-h-0 mx-5 mb-3 border border-rule bg-paper-subtle rounded-md overflow-hidden flex">
        {showCandidateQuestionCommentary ? (
          // Candidate-question commentary: same 14.5px black-text look
          // as Q-A commentary. Visually distinct from the listen-hint
          // pane (no 💡 / blue border); contextualized by the Phase bar
          // above showing "Candidate's Question".
          <CommentaryBody
            html={candidateQuestionCommentary || "…"}
            tone="commentary"
          />
        ) : showListeningHint ? (
          // Listening hint visual treatment: 💡 icon column + accent-blue
          // left border + smaller 13.5px font so the user can tell at a
          // glance this is in-the-moment coaching ("listen for X") vs
          // post-answer evaluative commentary.
          <CommentaryBody html={listeningHint} tone="hint" />
        ) : showWarmupCommentary ? (
          <CommentaryBody html={warmupCommentary} tone="commentary" />
        ) : isShowing && displayedComment ? (
          <CommentaryBody
            html={displayedComment.text || "…"}
            tone="commentary"
          />
        ) : isIdle ? (
          // Unified idle state: dots + "AI is observing…" across all
          // sub-cases (role-identification, warm-up, between-Qs,
          // waiting-for-answer, candidate-mid-answer). Same visual for
          // all so transitions feel smooth.
          <div className="m-auto inline-flex items-center gap-2 text-ink-lighter italic text-sm">
            <span className="inline-flex gap-[3px]">
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot" />
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.15s]" />
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.3s]" />
            </span>
            {labels.observing}
          </div>
        ) : null}
      </div>
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
function LiveCaptions({
  utterances,
  interim,
  isRecording,
  speakerRoles,
  maxTimeSec,
  labels,
}: {
  utterances: Utterance[];
  interim: string;
  isRecording: boolean;
  speakerRoles: Record<number, "interviewer" | "candidate">;
  /** When set (upload + timeline mode), treat only utterances whose
   *  `atSeconds + duration` (i.e. end time) ≤ maxTimeSec as visible.
   *  Scrubbing backwards hides later utterances; forward reveals them. */
  maxTimeSec?: number;
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
    const laneA = interviewerDg ?? firstAppearance[0];
    let laneB =
      candidateDg ?? firstAppearance.find((s) => s !== laneA);
    // Dedupe: when only ONE speaker exists in the recording and only the
    // candidate role has been identified, interviewerDg is undefined →
    // laneA falls through to the first (and only) speaker number; then
    // candidateDg refers to that SAME number → laneB collapses to laneA
    // and the UI renders both lanes with identical text. Force laneB
    // empty in that case so the single-speaker recording shows one lane.
    if (laneA !== undefined && laneA === laneB) laneB = undefined;

    // Pre-label empty lanes once the user has tagged one role. If the
    // user marked dg:0 as "interviewer", we logically know the OTHER
    // speaker will be the candidate — but Deepgram hasn't emitted a
    // dg:1 utterance yet, so laneB has no dgSpeaker attached. Reserve
    // the role visually so the user sees "Candidate · waiting to speak"
    // in the second lane instead of a generic "Speaker 2" placeholder.
    const laneAReservedRole: "interviewer" | "candidate" | undefined =
      laneA === undefined
        ? interviewerDg === undefined && candidateDg !== undefined
          ? "interviewer"
          : interviewerDg !== undefined
          ? "interviewer"
          : undefined
        : undefined;
    const laneBReservedRole: "interviewer" | "candidate" | undefined =
      laneB === undefined
        ? candidateDg === undefined && interviewerDg !== undefined
          ? "candidate"
          : candidateDg !== undefined
          ? "candidate"
          : undefined
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
  return (
    <div
      className="bg-paper-subtle flex flex-col shrink-0"
      style={{ height: CAPTIONS_TOTAL_HEIGHT_PX }}
    >
      <div
        className="px-4 border-b border-rule flex items-center gap-2 shrink-0"
        style={{ height: CAPTIONS_HEADING_HEIGHT_PX }}
      >
        <span className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider">
          {labels.heading}
        </span>
        {isRecording && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-accent uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse-dot" />
            {labels.live}
          </span>
        )}
      </div>
      <CaptionLane
        meta={metaA}
        text={textA}
        isSpeakingNow={aSpeaking || firstInterimOrphaned}
        interim={interimForA}
      />
      <div className="h-px bg-rule" />
      <CaptionLane
        meta={metaB}
        text={textB}
        isSpeakingNow={bSpeaking}
        interim={interimForB}
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
function LivePlayerStrip({ audio }: { audio: HTMLAudioElement }) {
  const [time, setTime] = useState(audio.currentTime);
  const [duration, setDuration] = useState(
    isFinite(audio.duration) ? audio.duration : 0
  );
  const [paused, setPaused] = useState(audio.paused);
  const [collapsed, setCollapsed] = useState(false);
  const setLivePlaybackTime = useStore((s) => s.setLivePlaybackTime);

  useEffect(() => {
    const onTime = () => {
      setTime(audio.currentTime);
      // Mirror into the store so timeline-driven UI (phases, current
      // question, commentary, listening hints, captions) can re-derive.
      setLivePlaybackTime(audio.currentTime);
    };
    const onMeta = () =>
      setDuration(isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("loadedmetadata", onMeta);
    audio.addEventListener("durationchange", onMeta);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    // `seeked` fires once a seek completes — useful when the user
    // scrubs while paused (timeupdate may not fire reliably in that
    // state across browsers). Hooked to the same handler so the store
    // sees the new position promptly either way.
    audio.addEventListener("seeked", onTime);
    // Initial sync in case the element is already beyond these events.
    onTime();
    onMeta();
    setPaused(audio.paused);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("loadedmetadata", onMeta);
      audio.removeEventListener("durationchange", onMeta);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("seeked", onTime);
    };
  }, [audio, setLivePlaybackTime]);

  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const fmt = (s: number) => {
    if (!isFinite(s)) return "00:00";
    const mm = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = p * duration;
    setTime(audio.currentTime);
    // IMPORTANT: push the new position into the store immediately. The
    // native `timeupdate` event fires after a seek but sometimes only
    // once and only if the element is playing — if the user scrubs
    // while paused, the timeline-driven UI (phase / question /
    // commentary / captions) could otherwise sit on stale state until
    // they hit play. Direct write keeps everything in sync.
    setLivePlaybackTime(audio.currentTime);
  };

  // Collapsed mode: just a small "show progress bar" pill anchored on
  // the right, so the user can hide the strip but still bring it back.
  if (collapsed) {
    return (
      <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0 pb-3 flex justify-end">
        <button
          onClick={() => setCollapsed(false)}
          className="inline-flex items-center gap-1.5 text-[11px] text-ink-lighter hover:text-ink border border-rule bg-paper-subtle px-2.5 py-1 rounded-md"
        >
          <span className="font-mono tabular-nums">{fmt(time)}</span>
          <span>· Show progress</span>
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0 pb-3">
      <div className="flex items-center gap-3 rounded-md border border-rule bg-paper-subtle px-3 py-2">
        <button
          onClick={() => {
            if (paused) void audio.play();
            else audio.pause();
          }}
          className="w-8 h-8 rounded-full bg-ink hover:bg-[#1f1e1a] text-paper grid place-items-center text-[12px] shrink-0 transition-colors"
          aria-label={paused ? "Play" : "Pause"}
        >
          {paused ? "▶" : "▮▮"}
        </button>
        <span className="font-mono text-[11px] text-ink-light tabular-nums min-w-[74px]">
          <span className="text-ink font-semibold">{fmt(time)}</span>
          <span> / {fmt(duration)}</span>
        </span>
        <div
          onClick={onTrackClick}
          className="flex-1 h-1.5 bg-paper-hover rounded-full relative cursor-pointer"
          role="slider"
          aria-label="Recording progress"
          aria-valuenow={Math.round(time)}
          aria-valuemax={Math.round(duration)}
        >
          <div
            className="absolute left-0 top-0 bottom-0 bg-ink rounded-full"
            style={{ width: `${pct}%` }}
          />
          <div
            className="absolute top-1/2 w-3 h-3 bg-ink rounded-full border-2 border-paper shadow"
            style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
          />
        </div>
        <span className="text-[10.5px] text-ink-lighter tracking-wider uppercase">
          Recording
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="shrink-0 text-ink-lighter hover:text-ink text-[13px] leading-none px-1"
          aria-label="Hide progress bar"
          title="Hide"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function CaptionLane({
  meta,
  text,
  isSpeakingNow,
  interim,
}: {
  meta: { name: string; reserved?: boolean };
  text: string;
  isSpeakingNow: boolean;
  interim: string;
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

  return (
    <div
      className="px-4 py-1.5 flex gap-3 items-start overflow-hidden"
      style={{ height: CAPTIONS_LANE_HEIGHT_PX }}
    >
      <div className="w-[90px] shrink-0">
        <div
          className={`text-[10.5px] font-medium uppercase tracking-wider ${
            isSpeakingNow
              ? "text-accent animate-pulse-label"
              : meta.reserved
              ? "text-ink-lighter"
              : "text-ink"
          }`}
        >
          {meta.name}
        </div>
      </div>
      <div
        ref={ref}
        className="flex-1 min-w-0 text-[12.5px] leading-snug text-ink overflow-y-auto no-scrollbar h-full"
      >
        {meta.reserved ? (
          // Role is known (the other side was tagged) but this speaker
          // hasn't been heard yet. Show an explicit waiting state so the
          // user understands the system is ready — just no voice yet.
          <span className="text-ink-lighter/70 italic inline-flex items-center gap-2">
            <span className="inline-flex gap-[3px]">
              <span className="w-[4px] h-[4px] rounded-full bg-ink-lighter animate-bounce-dot" />
              <span className="w-[4px] h-[4px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.15s]" />
              <span className="w-[4px] h-[4px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.3s]" />
            </span>
            waiting to speak
          </span>
        ) : text ? (
          <>
            {text}
            {interim && (
              <span className="text-ink-lighter/70 italic"> {interim}</span>
            )}
          </>
        ) : interim ? (
          <span className="text-ink-lighter/70 italic">{interim}</span>
        ) : (
          <span className="text-ink-lighter/70 italic">—</span>
        )}
      </div>
    </div>
  );
}

function ArchivedMainBlock({
  main,
  followUps,
  num,
  defaultOpen = false,
  labels,
}: {
  main: Question;
  followUps: Question[];
  num: number;
  defaultOpen?: boolean;
  labels: { followUp: string; noCommentary: string };
}) {
  const [open, setOpen] = useState(defaultOpen);
  const pad = num.toString().padStart(2, "0");

  return (
    <div className="border-t border-rule pt-4 pb-2 first:border-t-0 first:pt-0 mb-1.5">
      <button
        className="w-full flex items-start gap-2.5 cursor-pointer py-1 text-left"
        onClick={() => setOpen(!open)}
      >
        <div
          className={`w-5 h-[26px] grid place-items-center text-ink-lighter text-[10px] shrink-0 pt-0.5 transition-transform ${
            open ? "rotate-90" : ""
          }`}
        >
          ▶
        </div>
        <div className="font-mono text-xs font-semibold text-ink-lighter pt-[5px] min-w-[26px]">
          {pad}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-serif text-base font-medium leading-snug text-ink hover:text-accent transition-colors">
            {main.text}
          </div>
        </div>
      </button>
      {open && (
        <div className="pl-14 pt-2 pr-1">
          <CommentList comments={main.comments} emptyText={labels.noCommentary} />
          {followUps.map((fu) => (
            <div key={fu.id} className="mt-3 border-l-2 border-rule pl-3">
              <div className="text-[10px] font-semibold text-ink-lighter uppercase tracking-wider mb-1">
                {labels.followUp}
              </div>
              <div className="font-serif text-[15px] leading-snug text-ink-light mb-1.5">
                {fu.text}
              </div>
              <CommentList comments={fu.comments} emptyText={labels.noCommentary} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CommentList({
  comments,
  emptyText,
}: {
  comments: Comment[];
  emptyText: string;
}) {
  if (comments.length === 0) {
    return <p className="text-sm text-ink-lighter italic">{emptyText}</p>;
  }
  return (
    <>
      {[...comments].reverse().map((c) => (
        <p
          key={c.id}
          className="text-[14.5px] leading-relaxed text-ink mb-2.5 prose-live"
          dangerouslySetInnerHTML={{ __html: c.text || "…" }}
        />
      ))}
    </>
  );
}
