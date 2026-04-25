"use client";

import { useState, useRef } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { AudioPlayer, PlayerControls } from "./AudioPlayer";
import type { SessionScore } from "@/types/session";

function fmt(sec: number) {
  const mm = Math.floor(sec / 60).toString().padStart(2, "0");
  const ss = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * End-of-session scorecard. Three rendering modes:
 *   - No score yet: loading strip (scoring request in flight).
 *   - verdict === "insufficient_data": no score circle, just the reason —
 *     the model explicitly declined to judge.
 *   - Normal: score / totalMax with verdict chip, per-dimension bars (N/A
 *     dimensions render as a dash with their reason), and improvements.
 */
function ScoreCard({ score }: { score?: SessionScore }) {
  if (!score) {
    return (
      <div className="mb-8 rounded-xl border border-rule bg-paper-subtle px-5 py-4 text-sm text-ink-lighter italic animate-pulse-dot">
        Scoring this session…
      </div>
    );
  }

  const verdictStyles: Record<
    SessionScore["verdict"],
    { label: string; chip: string; ring: string }
  > = {
    strong_pass: {
      label: "Strong Pass",
      chip: "bg-emerald-100 text-emerald-800",
      ring: "ring-emerald-400",
    },
    pass: {
      label: "Pass",
      chip: "bg-emerald-50 text-emerald-700",
      ring: "ring-emerald-300",
    },
    borderline: {
      label: "Borderline",
      chip: "bg-amber-50 text-amber-800",
      ring: "ring-amber-300",
    },
    fail: {
      label: "Fail",
      chip: "bg-rose-50 text-rose-800",
      ring: "ring-rose-300",
    },
    insufficient_data: {
      label: "Insufficient Data",
      chip: "bg-slate-100 text-slate-700",
      ring: "ring-slate-300",
    },
  };
  const v = verdictStyles[score.verdict];

  // Insufficient-data rendering: no score circle, no dimension bars,
  // just the chip and the reason. Improvements are omitted here because
  // the endpoint returns none in this case.
  if (score.verdict === "insufficient_data") {
    return (
      <div className="mb-10 rounded-xl border border-rule bg-paper overflow-hidden">
        <div className="p-5">
          <div
            className={`inline-block text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${v.chip}`}
          >
            {v.label}
          </div>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink">
            {score.summary}
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-lighter">
            This session is too short to judge. Run a full interview —
            at least one case question answered end-to-end — and a
            graded scorecard will appear here.
          </p>
        </div>
      </div>
    );
  }

  const naCount = score.dimensions.filter((d) => d.score === null).length;

  return (
    <div className="mb-10 rounded-xl border border-rule bg-paper overflow-hidden">
      {/* Header: score + verdict + summary */}
      <div className="flex items-start gap-5 p-5 border-b border-rule">
        <div
          className={`shrink-0 w-[92px] h-[92px] rounded-full grid place-items-center ring-4 ${v.ring} bg-paper-subtle`}
        >
          <div className="text-center leading-none">
            <div className="text-[32px] font-bold text-ink tabular-nums">
              {score.total}
            </div>
            <div className="text-[10px] text-ink-lighter tracking-wider uppercase mt-1">
              / {score.totalMax}
            </div>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div
            className={`inline-block text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${v.chip}`}
          >
            {v.label} · {score.percent}%
          </div>
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-ink">
            {score.summary}
          </p>
          {naCount > 0 && (
            <p className="mt-2 text-[12px] leading-relaxed text-ink-lighter italic">
              {naCount} dimension{naCount === 1 ? " was" : "s were"}{" "}
              marked N/A — the transcript didn&apos;t contain enough
              evidence to judge{naCount === 1 ? " it" : " them"}. The
              total is normalized across the {5 - naCount} scored
              dimensions.
            </p>
          )}
        </div>
      </div>

      {/* Per-dimension breakdown */}
      <div className="divide-y divide-rule">
        {score.dimensions.map((d) => {
          const isNA = d.score === null;
          const pct = isNA || d.max === 0 ? 0 : ((d.score as number) / d.max) * 100;
          const barColor =
            pct >= 80 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-400" : "bg-rose-400";
          return (
            <div key={d.key} className="px-5 py-3">
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <div
                  className={`text-[13px] font-semibold ${
                    isNA ? "text-ink-lighter" : "text-ink"
                  }`}
                >
                  {d.label}
                  {isNA && (
                    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                      N/A
                    </span>
                  )}
                </div>
                <div className="font-mono text-[12px] text-ink-light tabular-nums">
                  {isNA ? `— / ${d.max}` : `${d.score} / ${d.max}`}
                </div>
              </div>
              {!isNA && (
                <div className="h-1.5 w-full bg-paper-hover rounded-full overflow-hidden mb-1.5">
                  <div
                    className={`h-full rounded-full ${barColor}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              <p className="text-[13px] leading-relaxed text-ink-light">
                {d.justification}
              </p>
            </div>
          );
        })}
      </div>

      {/* Improvements */}
      {score.improvements.length > 0 && (
        <div className="px-5 py-4 bg-paper-subtle border-t border-rule">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-lighter mb-2">
            Targeted Improvements
          </div>
          <ol className="space-y-2 list-decimal list-inside marker:text-ink-lighter marker:font-mono marker:text-[12px]">
            {score.improvements.map((imp, i) => (
              <li key={i} className="text-[14px] leading-relaxed text-ink">
                {imp}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
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
          <ScoreCard score={session.score} />

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
