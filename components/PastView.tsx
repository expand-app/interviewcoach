"use client";

import { useState, useRef } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { AudioPlayer, PlayerControls } from "./AudioPlayer";

function fmt(sec: number) {
  const mm = Math.floor(sec / 60).toString().padStart(2, "0");
  const ss = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function PastView() {
  const t = useTranslations();
  const selectedPastId = useStore((s) => s.selectedPastId);
  const pastSessions = useStore((s) => s.pastSessions);

  const session = pastSessions.find((s) => s.id === selectedPastId);
  const [currentTime, setCurrentTime] = useState(0);
  const controlsRef = useRef<PlayerControls | null>(null);

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-lighter">
        Session not found.
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
      <div className="mx-auto w-full max-w-[920px] px-24 pt-10 pb-5 max-[900px]:px-5 max-[900px]:pt-6 max-[900px]:pb-3 shrink-0">
        <div className="text-4xl font-bold tracking-tight leading-tight text-ink max-[900px]:text-[28px]">
          {session.title}
        </div>
        <div className="text-[13px] text-ink-lighter mt-2 font-mono">
          {dateStr} · {fmt(session.durationSeconds)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[920px] px-24 pt-5 pb-40 max-[900px]:px-5">
          {session.questions.map((q) => {
            const isPlaying = q.id === activeQId;
            return (
              <div
                key={q.id}
                onClick={() => controlsRef.current?.seekTo(q.askedAtSeconds)}
                className={`flex gap-4 py-5 border-t border-rule first:border-t-0 -mx-3 px-3 rounded-md cursor-pointer transition-colors ${
                  isPlaying ? "bg-accent-bg" : "hover:bg-paper-subtle"
                }`}
              >
                <div className="shrink-0 w-[58px] pt-0.5">
                  <div className={`font-mono text-[13px] font-semibold ${isPlaying ? "text-accent" : "text-ink"}`}>
                    {fmt(q.askedAtSeconds)}
                  </div>
                  <div className="text-[10px] text-ink-lighter mt-0.5 flex items-center gap-0.5">
                    {isPlaying ? "▶ " + t("playing", "播放中") : "⏵ " + t("jump", "跳转")}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-serif text-base font-medium leading-snug mb-2.5 text-ink">
                    {q.text}
                  </div>
                  <div className="text-[14.5px] leading-relaxed text-ink">
                    {q.comments.length === 0 ? (
                      <p className="text-ink-lighter italic">
                        {t("No commentary.", "无评论。")}
                      </p>
                    ) : (
                      q.comments.map((c) => (
                        <p
                          key={c.id}
                          className="mb-2 last:mb-0 prose-live"
                          dangerouslySetInnerHTML={{ __html: c.text }}
                        />
                      ))
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <AudioPlayer
        audioUrl={session.audioUrl}
        durationSec={session.durationSeconds}
        questions={session.questions}
        onTimeChange={setCurrentTime}
        onReady={(c) => (controlsRef.current = c)}
      />
    </>
  );
}
