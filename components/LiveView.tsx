"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";

export function LiveView() {
  const t = useTranslations();
  const questions = useStore((s) => s.liveQuestions);
  const live = useStore((s) => s.live);

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

      {/* Sticky current question bar */}
      {currentQ ? (
        <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
          <div className="border-y border-rule py-3.5 relative">
            <div className="text-[11px] font-semibold text-accent uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse-dot" />
              {t("Current Question", "当前问题")}
            </div>
            <div className="font-serif text-[19px] leading-snug text-ink font-medium">
              {currentQ.text}
            </div>
          </div>
        </div>
      ) : (
        /* No question detected yet — show a gentle "waiting" hint in place of the bar */
        <div className="mx-auto w-full max-w-[920px] px-24 max-[900px]:px-5 shrink-0">
          <div className="border-y border-rule py-3.5">
            <div className="text-[11px] font-semibold text-ink-lighter uppercase tracking-wider mb-1.5 inline-flex items-center gap-1.5">
              <span className="inline-flex gap-[3px]">
                <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot" />
                <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.15s]" />
                <span className="w-[5px] h-[5px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.3s]" />
              </span>
              {t("Waiting for the first question", "正在等待第一个问题")}
            </div>
            <div className="text-sm text-ink-light italic leading-snug">
              {interim ||
                t(
                  "Listening to the conversation…",
                  "正在聆听对话…"
                )}
            </div>
          </div>
        </div>
      )}

      {/* Scrollable feed */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-24 pt-5 pb-40 max-[900px]:px-5">
          {currentQ && (
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
