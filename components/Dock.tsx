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

/**
 * Live-session controls rendered inline inside the Topbar (right side).
 * Hidden when viewing a past session — the topbar has nothing to control
 * there.
 */
export function Dock({ onStart, onPause, onEnd }: Props) {
  const t = useTranslations();
  const live = useStore((s) => s.live);
  const questions = useStore((s) => s.liveQuestions);
  const selectedPastId = useStore((s) => s.selectedPastId);

  if (selectedPastId !== null) return null;

  const isRecording = live.status === "recording";
  const isPaused = live.status === "paused";
  const hasSession = isRecording || isPaused || questions.length > 0;

  const startLabel = isPaused ? t("Resume", "继续") : t("Start", "开始");

  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={onStart}
        disabled={isRecording}
        className="bg-accent hover:bg-[#1a73d1] disabled:opacity-40 disabled:cursor-not-allowed text-white px-2.5 py-[5px] rounded-md text-[12.5px] font-medium inline-flex items-center gap-1.5 transition-colors"
      >
        <span>▶</span>
        <span>{startLabel}</span>
      </button>

      <button
        onClick={onPause}
        disabled={!isRecording}
        className={`px-2.5 py-[5px] rounded-md text-[12.5px] font-medium inline-flex items-center gap-1.5 transition-colors ${
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

      <button
        onClick={onEnd}
        disabled={!hasSession}
        className="text-ink hover:bg-paper-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent px-2.5 py-[5px] rounded-md text-[12.5px] font-medium inline-flex items-center gap-1.5 transition-colors"
      >
        <span>↺</span>
        <span>{t("End", "结束")}</span>
      </button>

      <div className="w-px h-5 bg-rule mx-1.5" />

      <span className="font-mono text-xs text-ink-light tabular-nums min-w-[44px] text-center">
        {formatTime(live.elapsedSeconds)}
      </span>
    </div>
  );
}
