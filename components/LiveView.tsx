"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import type { Comment, MomentStateKind, Question, Speaker, Utterance } from "@/types/session";

const COMMENTARY_HEIGHT_PX = 140;  // single-comment fixed pane
const CAPTIONS_HEIGHT_PX   = 160;
/** Window of SPEAKING-time (sum of utterance durations) shown in captions. */
const CAPTIONS_WINDOW_S    = 10;
const DEFAULT_UTTERANCE_S  = 2;

export function LiveView() {
  const t = useTranslations();
  const questions = useStore((s) => s.liveQuestions);
  const live = useStore((s) => s.live);
  const utterances = useStore((s) => s.liveUtterances);
  const speakerRoles = useStore((s) => s.liveSpeakerRoles);
  const moment = useStore((s) => s.liveMomentState);
  const displayedComment = useStore((s) => s.liveDisplayedComment);
  const answerInProgress = useStore((s) => s.liveAnswerInProgress);

  const [interim, setInterim] = useState("");
  useEffect(() => {
    const handler = (e: Event) => setInterim((e as CustomEvent).detail as string);
    window.addEventListener("ic:interim", handler);
    return () => window.removeEventListener("ic:interim", handler);
  }, []);

  // Resolve the current main + follow-up Qs from the flat list.
  const currentSubQ = questions.find((q) => q.id === live.currentQuestionId);
  const currentMainQ = currentSubQ?.parentQuestionId
    ? questions.find((q) => q.id === currentSubQ.parentQuestionId)
    : currentSubQ;
  const currentFollowUpQ =
    currentSubQ && currentSubQ !== currentMainQ ? currentSubQ : undefined;

  // The Q that "owns" the live commentary slot is whichever sub-Q is current.
  const commentaryOwnerQ = currentSubQ;

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

  return (
    <>
      <PageTitle />

      {/* (1) Current Question — always present; stable once finalized. */}
      <CurrentQuestionBar
        state={moment.state}
        summary={moment.summary}
        mainQuestion={currentMainQ}
        followUp={currentFollowUpQ}
        labels={{
          finalized: t("Current Question · Interviewer", "当前问题 · 面试官"),
          waitingForFirst: t(
            "Waiting for the interview question…",
            "正在等待面试问题…"
          ),
          interviewerAsking: t(
            "Interviewer is asking…",
            "面试官正在提问…"
          ),
          followUp: t("Follow-up", "追问"),
          interviewerAskingFollowUp: t(
            "Interviewer is asking a follow-up…",
            "面试官正在追问…"
          ),
        }}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-24 pt-5 pb-20 max-[900px]:px-5">

          {/* (2) Live Commentary — fixed-height single-comment pane. */}
          <CommentarySection
            state={moment.state}
            currentQuestion={commentaryOwnerQ}
            displayed={displayedComment}
            answerInProgress={answerInProgress}
            labels={{
              heading: t("LIVE COMMENTARY", "实时评论"),
              observing: t("AI is observing…", "AI 正在观察…"),
              waitingFirstQ: t(
                "No commentary yet — waiting for the first question.",
                "暂无评论 — 等待第一个问题。"
              ),
              waitingAnswer: t(
                "Waiting for candidate's answer…",
                "等待候选人回答…"
              ),
              waitingNextQ: t(
                "Waiting for the next question to finalize…",
                "等待下一个问题定稿…"
              ),
            }}
          />

          {/* (3) Live Captions — newest at top, fixed height, no scrollbar. */}
          {(utterances.length > 0 || interim) && (
            <LiveCaptions
              utterances={utterances}
              interim={interim}
              isRecording={live.status === "recording"}
              speakerRoles={speakerRoles}
              labels={{
                heading: t("LIVE CAPTIONS", "实时字幕"),
                live: t("LIVE", "直播中"),
                interviewer: t("Interviewer", "面试官"),
                candidate: t("Candidate", "候选人"),
                speakerPrefix: t("Speaker", "发言者"),
              }}
            />
          )}

          {/* (4) Earlier in this interview — archived mains, with follow-ups. */}
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
                      followUp: t("Follow-up", "追问"),
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
  return (
    <div className="mx-auto w-full max-w-[920px] px-24 pt-10 pb-5 max-[900px]:px-5 max-[900px]:pt-6 max-[900px]:pb-3 shrink-0">
      <div className="text-4xl font-bold tracking-tight leading-tight text-ink max-[900px]:text-[28px]">
        Live Interview Session
      </div>
    </div>
  );
}

/**
 * Top bar — always present, layered display:
 *
 *   No main Q yet:
 *     - state=interviewer_speaking → "Interviewer is asking…" + summary
 *     - else → "Waiting for the interview question…"
 *
 *   Main Q locked in:
 *     - Big main Q text on top
 *     - If follow-up Q exists → indented "Follow-up: <text>" below
 *     - Else if state=interviewer_speaking → indented
 *       "Interviewer is asking a follow-up…" + summary below
 *     - Else nothing extra (just the main Q)
 */
function CurrentQuestionBar({
  state,
  summary,
  mainQuestion,
  followUp,
  labels,
}: {
  state: MomentStateKind;
  summary: string;
  mainQuestion: Question | undefined;
  followUp: Question | undefined;
  labels: {
    finalized: string;
    waitingForFirst: string;
    interviewerAsking: string;
    followUp: string;
    interviewerAskingFollowUp: string;
  };
}) {
  // Pre-anchored: no main Q yet.
  if (!mainQuestion) {
    if (state === "interviewer_speaking") {
      return (
        <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
          <div className="border-y border-rule py-3.5">
            <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
              <BouncingDots />
              {labels.interviewerAsking}
            </div>
            <div className="font-serif text-[17px] leading-snug text-ink-light italic">
              {summary || ""}
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
        <div className="border-y border-rule py-3.5">
          <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
            <BouncingDots />
            {labels.waitingForFirst}
          </div>
          {summary && (
            <div className="text-[13.5px] leading-snug text-ink-light italic">
              {summary}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Main Q is locked in.
  const showAskingFollowUp =
    !followUp && state === "interviewer_speaking";

  return (
    <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
      <div className="border-y border-rule py-3.5">
        <div className="text-[11px] font-semibold text-accent uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse-dot" />
          {labels.finalized}
        </div>
        <div className="font-serif text-[19px] leading-snug text-ink font-medium">
          {mainQuestion.text}
        </div>

        {followUp && (
          <div className="mt-2 pl-5 border-l-2 border-rule">
            <div className="text-[10.5px] font-semibold text-ink-lighter uppercase tracking-wider mb-0.5">
              {labels.followUp}
            </div>
            <div className="font-serif text-[15.5px] leading-snug text-ink-light">
              {followUp.text}
            </div>
          </div>
        )}

        {showAskingFollowUp && (
          <div className="mt-2 pl-5 border-l-2 border-rule">
            <div className="text-[10.5px] font-semibold text-ink-lighter uppercase tracking-wider mb-0.5 inline-flex items-center gap-1.5">
              <BouncingDots />
              {labels.interviewerAskingFollowUp}
            </div>
            {summary && (
              <div className="text-[13.5px] leading-snug text-ink-light italic">
                {summary}
              </div>
            )}
          </div>
        )}
      </div>
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
  answerInProgress,
  labels,
}: {
  state: MomentStateKind;
  currentQuestion: Question | undefined;
  displayed: { id: string; questionId: string; displayedAt: number; minMs: number } | null;
  answerInProgress: boolean;
  labels: {
    heading: string;
    observing: string;
    waitingFirstQ: string;
    waitingAnswer: string;
    waitingNextQ: string;
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

  // Resolve which comment text to show.
  const displayedComment = useMemo(() => {
    if (!displayed) return null;
    if (!currentQuestion || displayed.questionId !== currentQuestion.id) return null;
    return currentQuestion.comments.find((c) => c.id === displayed.id) ?? null;
  }, [displayed, currentQuestion]);

  // Is the displayed comment still within its min-display window? If so we
  // keep showing it even if the orchestrator's "current displayed" pointer
  // has been cleared (defensive — normally those move in lockstep).
  const isShowing = !!displayedComment;

  // Empty-state branch
  let empty: { kind: "none" | "first" | "answer" | "next"; text: string } | null = null;
  if (!isShowing) {
    if (!currentQuestion) {
      if (state === "interviewer_speaking") {
        empty = { kind: "next", text: labels.waitingNextQ };
      } else {
        empty = { kind: "first", text: labels.waitingFirstQ };
      }
    } else if (answerInProgress) {
      empty = { kind: "none", text: "" }; // dots — no text
    } else {
      empty = { kind: "answer", text: labels.waitingAnswer };
    }
  }

  return (
    <div className="mb-6">
      <div className="text-[11px] text-ink-lighter tracking-wide font-medium mb-2">
        {labels.heading}
      </div>

      <div
        className="border border-rule rounded-md bg-paper overflow-hidden flex"
        style={{ height: COMMENTARY_HEIGHT_PX }}
      >
        {isShowing && displayedComment ? (
          <div
            className="px-4 py-3 m-auto w-full text-[15px] leading-relaxed text-ink prose-live animate-appear"
            dangerouslySetInnerHTML={{ __html: displayedComment.text || "…" }}
          />
        ) : empty?.kind === "none" ? (
          <div className="m-auto inline-flex items-center gap-2 text-ink-lighter italic text-sm">
            <span className="inline-flex gap-[3px]">
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot" />
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.15s]" />
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.3s]" />
            </span>
            {labels.observing}
          </div>
        ) : (
          <div className="m-auto px-6 text-sm text-ink-lighter italic text-center">
            {empty?.text}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Tencent-Meeting / Teams style live caption pane.
 *
 *   - Newest at TOP. New utterances push older content downward; overflow
 *     trims from the bottom (oldest clipped off).
 *   - Window: utterances whose summed `duration` (Deepgram per-segment
 *     speaking time) sums to ≥ CAPTIONS_WINDOW_S, walking back from the
 *     latest. Silence doesn't consume budget.
 */
function LiveCaptions({
  utterances,
  interim,
  isRecording,
  speakerRoles,
  labels,
}: {
  utterances: Utterance[];
  interim: string;
  isRecording: boolean;
  speakerRoles: Record<number, "interviewer" | "candidate">;
  labels: {
    heading: string;
    live: string;
    interviewer: string;
    candidate: string;
    speakerPrefix: string;
  };
}) {
  const speakerIndex = useMemo(() => {
    const map = new Map<number, number>();
    let next = 1;
    for (const u of utterances) {
      if (u.dgSpeaker === undefined) continue;
      if (!map.has(u.dgSpeaker)) map.set(u.dgSpeaker, next++);
    }
    return map;
  }, [utterances]);

  const visibleUtterances = useMemo(() => {
    let sum = 0;
    const out: Utterance[] = [];
    for (let i = utterances.length - 1; i >= 0; i--) {
      const u = utterances[i];
      out.unshift(u);
      sum += u.duration ?? DEFAULT_UTTERANCE_S;
      if (sum >= CAPTIONS_WINDOW_S) break;
    }
    return out;
  }, [utterances]);

  // Group consecutive same-speaker utterances; reverse so newest is first.
  const paragraphs = useMemo(() => {
    const out: Array<{ key: string; dgSpeaker: number | undefined; text: string }> = [];
    for (const u of visibleUtterances) {
      const last = out[out.length - 1];
      if (last && last.dgSpeaker === u.dgSpeaker) {
        last.text += " " + u.text;
      } else {
        out.push({ key: u.id, dgSpeaker: u.dgSpeaker, text: u.text });
      }
    }
    return out.reverse();
  }, [visibleUtterances]);

  const resolveLabel = (dg: number | undefined): { name: string; role: Speaker } => {
    if (dg === undefined) return { name: labels.speakerPrefix, role: "unknown" };
    const role = speakerRoles[dg];
    if (role === "interviewer") return { name: labels.interviewer, role: "interviewer" };
    if (role === "candidate") return { name: labels.candidate, role: "candidate" };
    const idx = speakerIndex.get(dg) ?? dg + 1;
    return { name: `${labels.speakerPrefix} ${idx}`, role: "unknown" };
  };

  const colorFor = (role: Speaker) =>
    role === "interviewer"
      ? "text-accent"
      : role === "candidate"
      ? "text-ink"
      : "text-ink-lighter";

  // Interim text appends to the NEWEST paragraph (which is now index 0 since
  // we reversed).
  const newestIndex = 0;

  return (
    <div className="border border-rule rounded-md bg-paper-subtle overflow-hidden">
      <div className="px-4 pt-2.5 pb-1.5 border-b border-rule flex items-center gap-2">
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
      <div
        className="px-4 py-3 overflow-hidden"
        style={{ height: CAPTIONS_HEIGHT_PX }}
      >
        {paragraphs.map((p, i) => {
          const { name, role } = resolveLabel(p.dgSpeaker);
          return (
            <p key={p.key} className="mb-3 last:mb-0 text-[14.5px] leading-relaxed">
              <span className={`font-semibold mr-1.5 ${colorFor(role)}`}>
                {name}:
              </span>
              <span className="text-ink">{p.text}</span>
              {i === newestIndex && interim && (
                <span className="text-ink-lighter/70 italic"> {interim}</span>
              )}
            </p>
          );
        })}
        {paragraphs.length === 0 && interim && (
          <p className="mb-0 text-[14.5px] leading-relaxed">
            <span className="font-semibold mr-1.5 text-ink-lighter">
              {labels.speakerPrefix}:
            </span>
            <span className="text-ink-lighter/70 italic">{interim}</span>
          </p>
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
