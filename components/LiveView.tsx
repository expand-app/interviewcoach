"use client";

import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import type { Comment, MomentStateKind, Question, Speaker, Utterance } from "@/types/session";

const COMMENTARY_HEIGHT_PX = 380;
const CAPTIONS_HEIGHT_PX   = 160;
/** Window of SPEAKING-time (sum of utterance durations) shown in captions. */
const CAPTIONS_WINDOW_S    = 10;
/** Fallback when an utterance has no duration field (e.g. legacy data). */
const DEFAULT_UTTERANCE_S  = 2;

export function LiveView() {
  const t = useTranslations();
  const questions = useStore((s) => s.liveQuestions);
  const live = useStore((s) => s.live);
  const utterances = useStore((s) => s.liveUtterances);
  const speakerRoles = useStore((s) => s.liveSpeakerRoles);
  const moment = useStore((s) => s.liveMomentState);

  // Live interim transcript via window event (noisy state, kept out of store).
  const [interim, setInterim] = useState("");
  useEffect(() => {
    const handler = (e: Event) => setInterim((e as CustomEvent).detail as string);
    window.addEventListener("ic:interim", handler);
    return () => window.removeEventListener("ic:interim", handler);
  }, []);

  const currentQ = questions.find((q) => q.id === live.currentQuestionId);
  const earlierQs = questions.filter((q) => q.id !== live.currentQuestionId);
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

      {/* (1) Current Question area — always present, three text states. */}
      <CurrentQuestionBar
        state={moment.state}
        summary={moment.summary}
        currentQuestion={currentQ}
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
        }}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-24 pt-5 pb-20 max-[900px]:px-5">

          {/* (2) Live Commentary box — fixed height, terminal-tail behavior,
                only the CURRENT question's commentary. */}
          <CommentarySection
            state={moment.state}
            currentQuestion={currentQ}
            isRecording={live.status === "recording"}
            labels={{
              heading: t("LIVE COMMENTARY · on this answer", "实时评论 · 针对本题回答"),
              listening: t("listening…", "正在听…"),
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

          {/* (3) Live Captions — last 10s of speaking time, fixed height. */}
          {(utterances.length > 0 || interim) && (
            <LiveCaptions
              utterances={utterances}
              interim={interim}
              isRecording={live.status === "recording"}
              speakerRoles={speakerRoles}
              labels={{
                heading: t("Live Captions · last 10s", "实时字幕 · 最近 10 秒"),
                live: t("LIVE", "直播中"),
                interviewer: t("Interviewer", "面试官"),
                candidate: t("Candidate", "候选人"),
                speakerPrefix: t("Speaker", "发言者"),
              }}
            />
          )}

          {/* (4) Earlier in this interview — collapsible archive. */}
          {earlierQs.length > 0 && (
            <>
              <div className="mt-7 mb-3 text-[11px] text-ink-lighter font-semibold tracking-wide uppercase">
                {t("Earlier in this interview", "本场之前的问题")}
              </div>
              {earlierQs
                .slice()
                .reverse()
                .map((qa, idx) => (
                  <QABlock
                    key={qa.id}
                    q={qa}
                    num={earlierQs.length - idx}
                    defaultOpen={idx === 0}
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
 * The Current Question bar — always present, three visual states:
 *   A. No question yet (chitchat / idle / interviewer_speaking before first Q)
 *      → "Waiting for the interview question…" gray + bouncing dots
 *   B. Interviewer is mid-question (interviewer_speaking, no current Q)
 *      → "Interviewer is asking…" + AI summary, gray + bouncing dots
 *   C. Question finalized
 *      → cleaned question text in black + red LIVE dot. Stays here until a
 *        clearly NEW topical question is detected.
 */
function CurrentQuestionBar({
  state,
  summary,
  currentQuestion,
  labels,
}: {
  state: MomentStateKind;
  summary: string;
  currentQuestion: Question | undefined;
  labels: {
    finalized: string;
    waitingForFirst: string;
    interviewerAsking: string;
  };
}) {
  // C — finalized
  if (state === "question_finalized" && currentQuestion) {
    return (
      <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
        <div className="border-y border-rule py-3.5 relative">
          <div className="text-[11px] font-semibold text-accent uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse-dot" />
            {labels.finalized}
          </div>
          <div className="font-serif text-[19px] leading-snug text-ink font-medium">
            {currentQuestion.text}
          </div>
        </div>
      </div>
    );
  }

  // B — interviewer is asking (no Q locked in yet)
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

  // A — chitchat / idle (also covers the case where state === "question_finalized"
  //     but currentQuestion is somehow undefined — falls back to A safely)
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
 * Fixed-height commentary box. Newest comment pinned at the bottom; older
 * comments scroll off the top and are clipped (no scrollbar). Only the
 * CURRENT question's comments render here — when a new question arrives,
 * the previous question's comments archive into "Earlier in this interview"
 * and this box resets.
 */
function CommentarySection({
  state,
  currentQuestion,
  isRecording,
  labels,
}: {
  state: MomentStateKind;
  currentQuestion: Question | undefined;
  isRecording: boolean;
  labels: {
    heading: string;
    listening: string;
    waitingFirstQ: string;
    waitingAnswer: string;
    waitingNextQ: string;
  };
}) {
  const comments = currentQuestion?.comments ?? [];

  // Empty-state copy
  let emptyText: string | null = null;
  if (!currentQuestion) {
    emptyText =
      state === "interviewer_speaking" ? labels.waitingNextQ : labels.waitingFirstQ;
  } else if (comments.length === 0) {
    emptyText = labels.waitingAnswer;
  }

  return (
    <div className="mb-6">
      <div className="text-[11px] text-ink-lighter tracking-wide font-medium mb-2 inline-flex items-center gap-2">
        {labels.heading}
        {isRecording && currentQuestion && (
          <span className="inline-flex items-center gap-1 text-accent normal-case">
            <span className="inline-flex gap-[3px]">
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot" />
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.15s]" />
              <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.3s]" />
            </span>
            <span className="text-[10.5px] italic">{labels.listening}</span>
          </span>
        )}
      </div>

      <div
        className="border border-rule rounded-md bg-paper overflow-hidden flex flex-col justify-end"
        style={{ height: COMMENTARY_HEIGHT_PX }}
      >
        {emptyText ? (
          <div className="m-auto px-6 text-sm text-ink-lighter italic text-center">
            {emptyText}
          </div>
        ) : (
          <div className="px-4 py-3 flex flex-col gap-0">
            {comments.map((c, i) => (
              <CommentRow key={c.id} comment={c} isLast={i === comments.length - 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CommentRow({ comment, isLast }: { comment: Comment; isLast: boolean }) {
  return (
    <div
      className={`text-[15px] leading-relaxed text-ink prose-live animate-appear py-2.5 ${
        isLast ? "" : "border-b border-dashed border-rule"
      }`}
      dangerouslySetInnerHTML={{ __html: comment.text || "…" }}
    />
  );
}

/**
 * Tencent-Meeting / Teams style live caption pane.
 *
 * Window: shows utterances whose total `duration` (Deepgram per-segment
 * speaking time) sums to >= CAPTIONS_WINDOW_S, walking back from the
 * latest. Silence doesn't consume budget, so a quiet stretch keeps the
 * caption pane populated. Fixed height, no scrollbar — overflow upward is
 * clipped, content pinned to bottom.
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
  // Stable 1-indexed speaker number per Deepgram label, in first-heard order.
  const speakerIndex = useMemo(() => {
    const map = new Map<number, number>();
    let next = 1;
    for (const u of utterances) {
      if (u.dgSpeaker === undefined) continue;
      if (!map.has(u.dgSpeaker)) map.set(u.dgSpeaker, next++);
    }
    return map;
  }, [utterances]);

  // Take the tail of utterances whose summed duration >= CAPTIONS_WINDOW_S.
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

  // Group consecutive same-speaker utterances into paragraphs.
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
    return out;
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
        className="px-4 py-3 overflow-hidden flex flex-col justify-end"
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
              {i === paragraphs.length - 1 && interim && (
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

function QABlock({
  q,
  num,
  defaultOpen = false,
}: {
  q: { id: string; text: string; comments: { id: string; text: string }[] };
  num: number;
  defaultOpen?: boolean;
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
            {q.text}
          </div>
        </div>
      </button>
      {open && (
        <div className="pl-14 pt-2 pr-1">
          {q.comments.length === 0 ? (
            <p className="text-sm text-ink-lighter italic">No commentary.</p>
          ) : (
            [...q.comments].reverse().map((c) => (
              <p
                key={c.id}
                className="text-[14.5px] leading-relaxed text-ink mb-2.5 prose-live"
                dangerouslySetInnerHTML={{ __html: c.text || "…" }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
