"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import type { Speaker, Utterance } from "@/types/session";

export function LiveView() {
  const t = useTranslations();
  const questions = useStore((s) => s.liveQuestions);
  const live = useStore((s) => s.live);
  const utterances = useStore((s) => s.liveUtterances);
  const speakerRoles = useStore((s) => s.liveSpeakerRoles);
  const moment = useStore((s) => s.liveMomentState);

  // Subscribe to the interim transcript via window events — keeps the event
  // bus out of the Zustand store (this state is noisy and doesn't need to
  // propagate to other components).
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
        <div className="mx-auto w-full max-w-[920px] px-24 pt-10 pb-5 max-[900px]:px-5 max-[900px]:pt-6 max-[900px]:pb-3 shrink-0">
          <div className="text-4xl font-bold tracking-tight leading-tight text-ink max-[900px]:text-[28px]">
            Live Interview Session
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="text-center py-20 px-5 text-ink-lighter">
            <div className="text-[44px] mb-3.5 opacity-50">🎙️</div>
            <div className="text-sm">
              {t("Click ", "点 ")}
              <b>Start</b>
              {t(" to begin.", " 开始")}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Page title */}
      <div className="mx-auto w-full max-w-[920px] px-24 pt-10 pb-5 max-[900px]:px-5 max-[900px]:pt-6 max-[900px]:pb-3 shrink-0">
        <div className="text-4xl font-bold tracking-tight leading-tight text-ink max-[900px]:text-[28px]">
          Live Interview Session
        </div>
      </div>

      {/* Sticky moment bar — three states (chitchat / interviewer_speaking /
          question_finalized) plus an idle bootstrap. */}
      <MomentBar
        state={moment.state}
        summary={moment.summary}
        currentQuestion={currentQ}
        interim={interim}
        labels={{
          finalized: t("Current Question · Interviewer", "当前问题 · 面试官"),
          chitchat: t("Chit-chatting", "闲聊中"),
          interviewerSpeaking: t("Interviewer is speaking", "面试官正在说话"),
          listening: t("Listening to the conversation…", "正在聆听对话…"),
        }}
      />


      {/* Scrollable feed */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-24 pt-5 pb-40 max-[900px]:px-5">
          {(utterances.length > 0 || interim) && (
            <LiveCaptions
              utterances={utterances}
              interim={interim}
              isRecording={live.status === "recording"}
              speakerRoles={speakerRoles}
              labels={{
                heading: t("Live Captions", "实时字幕"),
                live: t("LIVE", "直播中"),
                interviewer: t("Interviewer", "面试官"),
                candidate: t("Candidate", "候选人"),
                speakerPrefix: t("Speaker", "发言者"),
              }}
            />
          )}

          {currentQ && moment.state === "question_finalized" && (
            <div className="pb-6 pt-1">
              <div className="text-[11px] text-ink-lighter tracking-wide font-medium mb-2">
                {t(
                  "LIVE COMMENTARY · on this answer",
                  "实时评论 · 针对本题回答"
                )}
              </div>

              {/* Listening indicator at top (newest things on top) */}
              {live.status === "recording" && (
                <div className="flex items-center gap-2 py-2.5 text-ink-lighter italic text-sm">
                  <span className="inline-flex gap-[3px]">
                    <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot" />
                    <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.15s]" />
                    <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.3s]" />
                  </span>
                  {t("listening…", "正在听…")}
                </div>
              )}

              {/* Comments, newest first */}
              {[...currentQ.comments].reverse().map((c) => (
                <div
                  key={c.id}
                  className="py-2.5 border-b border-dashed border-rule last:border-b-0 text-[15px] leading-relaxed text-ink prose-live animate-appear"
                  dangerouslySetInnerHTML={{ __html: c.text || "…" }}
                />
              ))}

              {currentQ.comments.length === 0 && live.status !== "recording" && (
                <div className="py-2.5 text-sm text-ink-lighter italic">
                  {t(
                    "No commentary yet for this question.",
                    "这个问题还没有评论。"
                  )}
                </div>
              )}
            </div>
          )}

          {/* Earlier questions in this session */}
          {earlierQs.length > 0 && (
            <>
              <div className="mt-7 mb-3 text-[11px] text-ink-lighter font-semibold tracking-wide uppercase">
                {t("Earlier in this interview", "本场之前的问题")}
              </div>
              {earlierQs
                .slice()
                .reverse()
                .map((qa, idx) => (
                  <QABlock key={qa.id} q={qa} num={earlierQs.length - idx} defaultOpen={idx === 0} />
                ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The sticky bar above the scrollable feed. Renders one of four layouts
 * based on the moment state — idle (waiting for first transcript), chitchat,
 * interviewer-speaking (mid-question), or question-finalized.
 */
function MomentBar({
  state,
  summary,
  currentQuestion,
  interim,
  labels,
}: {
  state: import("@/types/session").MomentStateKind;
  summary: string;
  currentQuestion: { text: string } | undefined;
  interim: string;
  labels: {
    finalized: string;
    chitchat: string;
    interviewerSpeaking: string;
    listening: string;
  };
}) {
  // Layout 1 — finalized question (existing red-dot look)
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

  // Layout 2 — chitchat
  if (state === "chitchat") {
    return (
      <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
        <div className="border-y border-rule py-3.5 bg-paper-subtle/60">
          <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
            <span>💬</span>
            {labels.chitchat}
          </div>
          <div className="text-[15px] leading-snug text-ink-light">
            {summary || labels.listening}
          </div>
        </div>
      </div>
    );
  }

  // Layout 3 — interviewer speaking (mid-question)
  if (state === "interviewer_speaking") {
    return (
      <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
        <div className="border-y border-rule py-3.5 bg-accent-bg/60">
          <div className="text-[11px] font-semibold text-accent uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
            <span>🎙️</span>
            {labels.interviewerSpeaking}
          </div>
          <div className="text-[15px] leading-snug text-ink">
            {summary || labels.listening}
          </div>
        </div>
      </div>
    );
  }

  // Layout 4 — idle bootstrap (no classify result yet)
  return (
    <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
      <div className="border-y border-rule py-3.5">
        <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
          <span className="inline-flex gap-[3px]">
            <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot" />
            <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.15s]" />
            <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.3s]" />
          </span>
          {labels.listening}
        </div>
        <div className="text-sm text-ink-light italic leading-snug">
          {interim || ""}
        </div>
      </div>
    </div>
  );
}

/**
 * Tencent-Meeting / Teams style live caption pane.
 *
 * - Each utterance carries its raw Deepgram speaker number; the role
 *   (interviewer / candidate) is derived at render time from speakerRoles,
 *   so when Haiku finishes identifying speakers the historical paragraphs
 *   re-label automatically (no second pass over the data).
 * - Consecutive utterances from the same speaker number merge into one
 *   paragraph (grouping is by raw speaker, not derived role — so the same
 *   visual paragraphing holds even before identification completes).
 * - Until a speaker is identified, the label shows "Speaker 1", "Speaker 2"
 *   (1-indexed). After identification, it switches to "Interviewer" /
 *   "Candidate" with the appropriate color.
 * - Interim text appends to the LAST paragraph in muted italic, then gets
 *   replaced by styled final text when Deepgram finalizes.
 * - Sticky-bottom auto-scroll with read-up tolerance.
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
  // Stable 1-indexed speaker number per Deepgram label, in the order we
  // first heard each speaker. So Speaker 1 is whoever spoke first, Speaker 2
  // is the next new voice, etc. This is independent of role.
  const speakerIndex = useMemo(() => {
    const map = new Map<number, number>();
    let next = 1;
    for (const u of utterances) {
      if (u.dgSpeaker === undefined) continue;
      if (!map.has(u.dgSpeaker)) {
        map.set(u.dgSpeaker, next++);
      }
    }
    return map;
  }, [utterances]);

  // Group consecutive same-speaker utterances into paragraphs (by raw
  // dgSpeaker, not derived role).
  const paragraphs = useMemo(() => {
    const out: Array<{ key: string; dgSpeaker: number | undefined; text: string }> = [];
    for (const u of utterances) {
      const last = out[out.length - 1];
      if (last && last.dgSpeaker === u.dgSpeaker) {
        last.text += " " + u.text;
      } else {
        out.push({ key: u.id, dgSpeaker: u.dgSpeaker, text: u.text });
      }
    }
    return out;
  }, [utterances]);

  // Auto-scroll to bottom when new content arrives, but only if the user is
  // already near the bottom — lets them scroll up to re-read without being
  // yanked back down on the next utterance.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distanceFromBottom < 32;
  };
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [paragraphs, interim, speakerRoles]);

  const resolveLabel = (dg: number | undefined): { name: string; role: Speaker } => {
    if (dg === undefined) {
      return { name: labels.speakerPrefix, role: "unknown" };
    }
    const role = speakerRoles[dg];
    if (role === "interviewer") return { name: labels.interviewer, role: "interviewer" };
    if (role === "candidate") return { name: labels.candidate, role: "candidate" };
    const idx = speakerIndex.get(dg) ?? dg + 1;
    return { name: `${labels.speakerPrefix} ${idx}`, role: "unknown" };
  };

  const colorFor = (role: Speaker) =>
    role === "interviewer" ? "text-accent" : role === "candidate" ? "text-ink" : "text-ink-lighter";

  return (
    <div className="mb-6 border border-rule rounded-md bg-paper-subtle overflow-hidden">
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
        ref={scrollRef}
        onScroll={onScroll}
        className="px-4 py-3 max-h-80 overflow-y-auto"
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
