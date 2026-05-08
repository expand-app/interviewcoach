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

  // Hide the entire dock during the "starting" phase (StartModal
  // Continue clicked → ready-bar shown → user accepting Chrome's
  // share dialog). Audio isn't flowing yet, so showing Pause / End
  // buttons + a ticking timer would falsely advertise an active
  // session. Once handleBeginRecording flips status to "recording",
  // this guard releases and the cluster appears. Topbar logo,
  // language toggle, sidebar, etc. are unaffected — this is the
  // only piece that hides during "starting".
  if (live.status === "starting") return null;

  const isRecording = live.status === "recording";
  const isPaused = live.status === "paused";
  const hasSession = isRecording || isPaused || questions.length > 0;

  const startLabel = isPaused ? t("Resume", "继续") : t("Start", "开始");

  // Three-button control cluster. Per the design system rule "1
  // primary action max per section", only Start is the primary
  // (black) button. Pause and End are secondary (bordered, no fill)
  // so the cluster reads as one control unit.
  //
  // Pause recording-tone: when recording is live, Pause takes a
  // filled error-color background with a pulsing white dot so it
  // visually reads as the active "stop me" affordance.
  //
  // Icons are inline SVGs (not Unicode glyphs) — Unicode chars like
  // `▶` `⏸` `↺` were rendering as `;` on some font fallback stacks
  // (Chinese system fonts in particular), creating a confusing
  // top-left smudge on every protected-app page.
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onStart}
        disabled={isRecording}
        className="btn btn-primary btn-sm"
      >
        <PlayIcon />
        <span>{startLabel}</span>
      </button>

      <button
        onClick={onPause}
        disabled={!isRecording}
        className={isRecording ? "btn btn-sm" : "btn btn-secondary btn-sm"}
        style={
          isRecording
            ? {
                background: "var(--color-error)",
                color: "var(--color-bg)",
                borderColor: "var(--color-error)",
              }
            : undefined
        }
      >
        {isRecording ? (
          <span className="w-2 h-2 rounded-full bg-bg animate-pulse-dot" />
        ) : (
          <PauseIcon />
        )}
        <span>{t("Pause", "暂停")}</span>
      </button>

      <button
        onClick={onEnd}
        disabled={!hasSession}
        className="btn btn-secondary btn-sm"
      >
        <StopIcon />
        <span>{t("End", "结束")}</span>
      </button>

      <div className="w-px h-5 bg-border mx-2" />

      <span
        className="text-xs text-text-muted tabular-nums min-w-[44px] text-center"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {formatTime(live.elapsedSeconds)}
      </span>
    </div>
  );
}

/* Inline SVG icons. Stroke-width 1.5 + currentColor per the design
   rule. Sized to match Lucide icons at 12px (smaller than the 16px
   default since they sit in btn-sm pills). */
function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M3 2v8l7-4z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="3" y="2" width="2.5" height="8" rx="0.5" />
      <rect x="6.5" y="2" width="2.5" height="8" rx="0.5" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="0.5" />
    </svg>
  );
}
