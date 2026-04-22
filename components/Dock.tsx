"use client";

import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";

interface Props {
  onStart: () => void;
  onPause: () => void;
  onEnd: () => void;
}

function formatTime(s: number) {
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export function Dock({ onStart, onPause, onEnd }: Props) {
  const t = useTranslations();
  const live = useStore((s) => s.live);
  const questions = useStore((s) => s.liveQuestions);
  const selectedPastId = useStore((s) => s.selectedPastId);

  // Hide entirely when viewing a past session
  if (selectedPastId !== null) return null;

  const isRecording = live.status === "recording";
  const isPaused = live.status === "paused";
  const hasSession = isRecording || isPaused || questions.length > 0;

  // Start button label adapts: Start → Resume (after pause)
  const startLabel = isPaused ? t("Resume", "继续") : t("Start", "开始");

  return (
    <div
      className="fixed bottom-6 transform -translate-x-1/2 bg-paper border border-rule-strong rounded-lg shadow-[0_4px_16px_rgba(15,15,15,0.08),0_1px_3px_rgba(15,15,15,0.06)] p-1.5 flex items-center gap-0.5 z-10"
      style={{ left: "calc(50% + 120px)" }}
    >
      {/* Start / Resume */}
      <button
        onClick={onStart}
        disabled={isRecording}
        className="bg-accent hover:bg-[#1a73d1] disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-[7px] rounded-md text-[13.5px] font-medium inline-flex items-center gap-1.5 transition-colors"
      >
        <span>▶</span>
        <span>{startLabel}</span>
      </button>

      {/* Pause */}
      <button
        onClick={onPause}
        disabled={!isRecording}
        className={`px-3 py-[7px] rounded-md text-[13.5px] font-medium inline-flex items-center gap-1.5 transition-colors ${
          isRecording
            ? "bg-live hover:bg-[#c73434] text-white"
            : "text-ink hover:bg-paper-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        }`}
      >
        {isRecording ? (
          <span className="w-2 h-2 rounded-full bg-white animate-pulse-dot" />
        ) : (
          <span>⏸</span>
        )}
        <span>{t("Pause", "暂停")}</span>
      </button>

      {/* End & Save */}
      <button
        onClick={onEnd}
        disabled={!hasSession}
        className="text-ink hover:bg-paper-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent px-3 py-[7px] rounded-md text-[13.5px] font-medium inline-flex items-center gap-1.5 transition-colors"
      >
        <span>↺</span>
        <span>{t("End & Save", "结束并保存")}</span>
      </button>

      <div className="w-px h-5 bg-rule mx-1" />

      {/* Timer */}
      <span className="font-mono text-xs text-ink-light px-2.5 tabular-nums min-w-[60px] text-center">
        {formatTime(live.elapsedSeconds)}
      </span>
    </div>
  );
}
