"use client";

import { useRef, useState, useEffect } from "react";
import type { Question } from "@/types/session";

interface Props {
  audioUrl: string | undefined;
  durationSec: number;
  questions: Question[];
  /** Called when the user jumps via a marker or timestamp click. */
  onTimeChange?: (seconds: number) => void;
  /** Callback ref exposed so parent can trigger jumps programmatically. */
  onReady?: (controls: PlayerControls) => void;
}

export interface PlayerControls {
  seekTo: (seconds: number) => void;
}

function fmt(sec: number) {
  if (!isFinite(sec)) return "00:00";
  const mm = Math.floor(sec / 60).toString().padStart(2, "0");
  const ss = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

const SPEEDS = [1, 1.25, 1.5, 2, 0.75];

export function AudioPlayer({ audioUrl, durationSec, questions, onTimeChange, onReady }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);

  // Wire up the audio element
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setTime(el.currentTime);
    const onEnd = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnd);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnd);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[speedIdx];
  }, [speedIdx]);

  // Expose seek controls to parent
  useEffect(() => {
    if (!onReady) return;
    onReady({
      seekTo: (sec: number) => {
        if (audioRef.current) {
          audioRef.current.currentTime = sec;
          setTime(sec);
        }
      },
    });
  }, [onReady]);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => { /* user gesture likely needed */ });
      setPlaying(true);
    }
  };

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!trackRef.current || !audioRef.current || durationSec === 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const newTime = Math.max(0, Math.min(durationSec, pct * durationSec));
    audioRef.current.currentTime = newTime;
    setTime(newTime);
    onTimeChange?.(newTime);
  };

  const pct = durationSec > 0 ? (time / durationSec) * 100 : 0;

  return (
    <div
      className="fixed bottom-6 transform -translate-x-1/2 bg-bg border border-border-strong p-3 px-4 z-10"
      style={{
        left: "calc(50% + 120px)",
        width: "min(720px, calc(100vw - 280px))",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <audio ref={audioRef} src={audioUrl} preload="metadata" />
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={!audioUrl}
          className="w-9 h-9 rounded-full disabled:opacity-30 grid place-items-center text-sm shrink-0 transition-colors"
          style={{
            background: "var(--color-text)",
            color: "var(--color-bg)",
            border: 0,
          }}
        >
          {playing ? "▮▮" : "▶"}
        </button>

        <div
          className="text-xs text-text-muted min-w-[80px] tabular-nums"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <span className="text-text font-semibold">{fmt(time)}</span>
          <span> / {fmt(durationSec)}</span>
        </div>

        <div
          ref={trackRef}
          onClick={onTrackClick}
          className="flex-1 h-1.5 bg-surface-2 rounded-full relative cursor-pointer"
        >
          <div
            className="absolute left-0 top-0 bottom-0 bg-text rounded-full"
            style={{ width: `${pct}%` }}
          />
          <div
            className="absolute top-1/2 w-3.5 h-3.5 bg-text rounded-full border-2 border-bg"
            style={{ left: `${pct}%`, transform: "translate(-50%, -50%)" }}
          />
          {questions.map((q) => {
            if (durationSec === 0) return null;
            const left = (q.askedAtSeconds / durationSec) * 100;
            return (
              <button
                key={q.id}
                onClick={(e) => {
                  e.stopPropagation();
                  if (audioRef.current) {
                    audioRef.current.currentTime = q.askedAtSeconds;
                    setTime(q.askedAtSeconds);
                  }
                }}
                className="group absolute -top-1 w-0.5 h-3.5 bg-text rounded-sm cursor-pointer hover:h-4 transition-all"
                style={{ left: `${left}%` }}
                title={q.text}
              >
                <span
                  className="hidden group-hover:block absolute bottom-5 left-1/2 -translate-x-1/2 font-sans text-[11px] py-1 px-2 rounded whitespace-nowrap max-w-[240px] overflow-hidden text-ellipsis z-10"
                  style={{
                    background: "var(--color-text)",
                    color: "var(--color-bg)",
                  }}
                >
                  {q.text}
                </span>
              </button>
            );
          })}
        </div>

        <button
          onClick={() => setSpeedIdx((speedIdx + 1) % SPEEDS.length)}
          className="text-[11px] font-medium py-1 px-2 border border-border-strong rounded bg-bg text-text-muted hover:text-text hover:bg-surface transition-colors"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {SPEEDS[speedIdx]}×
        </button>
      </div>
    </div>
  );
}
