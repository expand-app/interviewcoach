"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { getMockInterviewer } from "@/lib/mockInterviewer";

interface Props {
  /** End-call button pressed — page owns the confirm + save flow. */
  onEndRequest: () => void;
}

/**
 * MockInterviewView — the Zoom-style call surface for a Retake.
 *
 * Mounted as the third branch in app/app/page.tsx (retake active +
 * no past session selected). Deliberately minimal: a dark call
 * canvas, the AI interviewer tile (speaking ring / thinking dots
 * driven by retakePhase), the user's camera self-view, a caption bar
 * with the current question, and call controls. NO live coaching UI
 * — comments generate silently and appear in PastView after the call.
 */
export function MockInterviewView({ onEndRequest }: Props) {
  const t = useTranslations();
  const retake = useStore((s) => s.retake);
  const phase = useStore((s) => s.retakePhase);
  const caption = useStore((s) => s.retakeCaption);
  const micMuted = useStore((s) => s.retakeMicMuted);
  const elapsed = useStore((s) => s.live.elapsedSeconds);
  const status = useStore((s) => s.live.status);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [camReady, setCamReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  // "Hearing you" plumbing. The controller dispatches ic:retake-speech
  // on every candidate interim/final — we track recency to (a) pulse a
  // green dot on the self tile while the user talks and (b) surface a
  // "can't hear you" warning if a listening phase goes 8s+ without a
  // single speech signal (dead mic / wrong input device / suspended
  // audio graph — the field report was exactly this, invisible).
  const [lastHeardAt, setLastHeardAt] = useState(0);
  const [listenStartedAt, setListenStartedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const onSpeech = () => setLastHeardAt(Date.now());
    window.addEventListener("ic:retake-speech", onSpeech);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener("ic:retake-speech", onSpeech);
      clearInterval(tick);
    };
  }, []);
  useEffect(() => {
    if (phase === "listening") setListenStartedAt(Date.now());
  }, [phase]);
  const hearingYou = now - lastHeardAt < 2000;
  // Dead-mic warning: only when we've NEVER heard the candidate the
  // whole call. Once any speech signal has arrived, the mic works —
  // re-warning on every 8s pause (thinking time, speaker-echo VAD
  // quirks) just nags a healthy setup, which was the field report
  // ("the red warning keeps appearing").
  const micLooksDead =
    phase === "listening" &&
    !micMuted &&
    listenStartedAt > 0 &&
    now - listenStartedAt > 8000 &&
    lastHeardAt === 0;

  // Attach the webcam stream to the self-view tile. The camera is
  // acquired inside MockInterviewer.start() (async, after mount), so
  // poll briefly until it shows up; stop polling once attached or
  // after ~15s (denied → avatar fallback stays).
  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    const attach = () => {
      if (cancelled) return;
      const stream = getMockInterviewer().getCameraStream();
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream;
        setCamReady(true);
        return;
      }
      if (++tries < 30) setTimeout(attach, 500);
    };
    attach();
    return () => {
      cancelled = true;
    };
  }, [status]);

  const mm = Math.floor(elapsed / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(elapsed % 60)
    .toString()
    .padStart(2, "0");

  const aiSpeaking =
    phase === "greeting" || phase === "asking" || phase === "wrapup";
  const aiThinking = phase === "thinking";

  const interviewer = getMockInterviewer();

  return (
    <div
      className="relative flex flex-col h-full min-h-0 rounded-lg overflow-hidden"
      style={{ background: "#111214" }}
    >
      {/* ===== Top bar: title / timer / REC ===== */}
      <div className="flex items-center justify-between px-4 py-2.5 shrink-0">
        <span
          className="truncate text-[12.5px] font-medium"
          style={{ color: "rgba(255,255,255,0.75)" }}
        >
          {t("Retake of", "重练")}: {retake?.parentTitle ?? ""}
        </span>
        <span className="flex items-center gap-3 shrink-0">
          <span className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ background: "#e5484d" }}
            />
            <span
              className="text-[11px] font-semibold tracking-wide"
              style={{ color: "rgba(255,255,255,0.55)" }}
            >
              REC
            </span>
          </span>
          <span
            className="text-[12.5px] font-mono tabular-nums"
            style={{ color: "rgba(255,255,255,0.75)" }}
          >
            {mm}:{ss}
          </span>
        </span>
      </div>

      {/* ===== Call canvas ===== */}
      <div className="relative flex-1 min-h-0 grid place-items-center px-6">
        {/* Interviewer tile */}
        <div className="flex flex-col items-center gap-4">
          <div className="relative grid place-items-center">
            {/* speaking ring */}
            {aiSpeaking && (
              <>
                <span
                  className="absolute rounded-full animate-ping"
                  style={{
                    width: 128,
                    height: 128,
                    background: "rgba(94,234,159,0.12)",
                  }}
                />
                <span
                  className="absolute rounded-full"
                  style={{
                    width: 116,
                    height: 116,
                    border: "2px solid rgba(94,234,159,0.45)",
                  }}
                />
              </>
            )}
            <div
              className="grid place-items-center rounded-full font-semibold select-none"
              style={{
                width: 96,
                height: 96,
                fontSize: 34,
                background: "#2a2c30",
                color: "rgba(255,255,255,0.85)",
              }}
            >
              {t("I", "面")}
            </div>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span
              className="text-[14px] font-medium"
              style={{ color: "rgba(255,255,255,0.9)" }}
            >
              {t("Interviewer", "面试官")}
            </span>
            <span
              className="text-[12px]"
              style={{ color: "rgba(255,255,255,0.45)" }}
            >
              {aiThinking
                ? t("Thinking…", "思考中…")
                : aiSpeaking
                  ? t("Speaking", "正在提问")
                  : phase === "listening"
                    ? t("Listening to you", "正在听你回答")
                    : phase === "ended"
                      ? t("Interview complete", "面试结束")
                      : ""}
              {aiThinking && (
                <span className="inline-flex gap-[3px] ml-1.5 align-middle">
                  <span className="w-[4px] h-[4px] rounded-full bg-current animate-bounce-dot" />
                  <span className="w-[4px] h-[4px] rounded-full bg-current animate-bounce-dot [animation-delay:.15s]" />
                  <span className="w-[4px] h-[4px] rounded-full bg-current animate-bounce-dot [animation-delay:.3s]" />
                </span>
              )}
            </span>
          </div>
        </div>

        {/* Self-view tile (bottom-right) */}
        <div
          className="absolute bottom-4 right-4 rounded-lg overflow-hidden border"
          style={{
            width: 200,
            height: 122,
            background: "#1b1d20",
            borderColor: "rgba(255,255,255,0.12)",
          }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="w-full h-full object-cover"
            style={{
              transform: "scaleX(-1)",
              display: camReady ? "block" : "none",
            }}
          />
          {!camReady && (
            <div className="w-full h-full grid place-items-center">
              <div
                className="grid place-items-center rounded-full font-semibold"
                style={{
                  width: 40,
                  height: 40,
                  fontSize: 15,
                  background: "#2a2c30",
                  color: "rgba(255,255,255,0.7)",
                }}
              >
                {t("You", "我")[0]}
              </div>
            </div>
          )}
          {micMuted && (
            <span
              className="absolute bottom-1.5 left-1.5 text-[10px] font-medium rounded px-1 py-px"
              style={{ background: "rgba(0,0,0,0.6)", color: "#e5484d" }}
            >
              {t("Muted", "已静音")}
            </span>
          )}
          {!micMuted && hearingYou && (
            <span
              className="absolute bottom-1.5 left-1.5 flex items-center gap-1 text-[10px] font-medium rounded px-1 py-px"
              style={{ background: "rgba(0,0,0,0.6)", color: "#5eea9f" }}
            >
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{ background: "#5eea9f" }}
              />
              {t("Hearing you", "听到了")}
            </span>
          )}
        </div>

        {/* Dead-mic warning: listening 8s+ with zero speech signal. */}
        {micLooksDead && (
          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md px-3.5 py-2 text-[12.5px] font-medium"
            style={{
              background: "rgba(229,72,77,0.15)",
              border: "1px solid rgba(229,72,77,0.5)",
              color: "#ff9b9e",
            }}
          >
            {t(
              "Can't hear you — check that the right microphone is allowed, then click anywhere on this page.",
              "听不到你的声音——请检查麦克风权限/设备是否正确,然后在页面任意处点击一下。"
            )}
          </div>
        )}

        {/* Silent-coaching notice (top-left, quiet) */}
        <span
          className="absolute top-2 left-4 text-[11px]"
          style={{ color: "rgba(255,255,255,0.35)" }}
        >
          {t(
            "Coaching runs silently — comments & score appear after the call.",
            "教练全程静默——通话结束后可查看点评与评分。"
          )}
        </span>
      </div>

      {/* ===== Caption bar ===== */}
      {captionsOn && caption && (
        <div className="px-6 pb-2 shrink-0">
          <div
            className="mx-auto max-w-2xl rounded-md px-4 py-2.5 text-center text-[13.5px] leading-relaxed"
            style={{
              background: "rgba(255,255,255,0.07)",
              color: "rgba(255,255,255,0.92)",
            }}
          >
            {caption}
          </div>
        </div>
      )}

      {/* ===== Control bar ===== */}
      <div
        className="flex items-center justify-center gap-2.5 px-4 py-3 shrink-0"
        style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}
      >
        <CallButton
          label={
            micMuted ? t("Unmute", "取消静音") : t("Mute", "静音")
          }
          active={micMuted}
          onClick={() => interviewer.setUserMuted(!micMuted)}
        />
        <CallButton
          label={captionsOn ? t("Hide captions", "隐藏字幕") : t("Captions", "字幕")}
          active={!captionsOn}
          onClick={() => setCaptionsOn((v) => !v)}
        />
        {process.env.NEXT_PUBLIC_RETAKE_ENGINE !== "openai" && (
          <CallButton
            label={t("Skip question", "跳过这题")}
            disabled={phase !== "listening"}
            onClick={() => interviewer.skipQuestion()}
          />
        )}
        <button
          onClick={onEndRequest}
          className="rounded-md px-4 py-2 text-[13px] font-semibold transition-colors"
          style={{ background: "#e5484d", color: "#fff" }}
        >
          {t("End call", "结束通话")}
        </button>
      </div>
    </div>
  );
}

function CallButton({
  label,
  onClick,
  active,
  disabled,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-3.5 py-2 text-[13px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{
        background: active
          ? "rgba(255,255,255,0.22)"
          : "rgba(255,255,255,0.09)",
        color: "rgba(255,255,255,0.9)",
      }}
    >
      {label}
    </button>
  );
}
