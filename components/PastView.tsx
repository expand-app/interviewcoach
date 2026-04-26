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

/** Small text button anchored next to the verdict chip, lets the user
 *  re-fire /api/score-session against the same Session. While in flight,
 *  swaps the icon for a pulsing dot and disables clicks so a user
 *  spamming the button doesn't queue duplicate requests. Notion-style:
 *  no border, hover underlines, sits as a quiet affordance rather than
 *  competing with the chip. */
function RefreshScoreButton({
  onClick,
  isRefreshing,
}: {
  onClick: () => void;
  isRefreshing: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={isRefreshing}
      className="shrink-0 inline-flex items-center gap-1.5 text-[11px] text-ink-lighter hover:text-ink disabled:opacity-60 disabled:cursor-not-allowed transition-colors group"
      title="Re-score this session"
    >
      {isRefreshing ? (
        <>
          <span className="inline-flex gap-[2px]">
            <span className="w-[3px] h-[3px] rounded-full bg-ink-lighter animate-bounce-dot" />
            <span className="w-[3px] h-[3px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.15s]" />
            <span className="w-[3px] h-[3px] rounded-full bg-ink-lighter animate-bounce-dot [animation-delay:.3s]" />
          </span>
          <span>Re-scoring…</span>
        </>
      ) : (
        <>
          <span className="text-[12px] leading-none group-hover:rotate-180 transition-transform duration-300">
            ↻
          </span>
          <span className="group-hover:underline underline-offset-2">
            Re-score
          </span>
        </>
      )}
    </button>
  );
}

/**
 * End-of-session scorecard. Three rendering modes:
 *   - No score yet: loading strip (scoring request in flight).
 *   - verdict === "insufficient_data": no score circle, just the reason —
 *     the model explicitly declined to judge.
 *   - Normal: score / totalMax with verdict chip, per-dimension bars (N/A
 *     dimensions render as a dash with their reason), and improvements.
 *
 * Refresh: when `onRefresh` is supplied, both the insufficient-data card
 * and the normal scorecard expose a small "Re-score" link button that
 * re-fires /api/score-session against the same Session. Useful when:
 *   - a session was saved before scoring rules tightened up (the
 *     answer-text fix landed mid-week, older sessions show insufficient
 *     even though they have substantive content)
 *   - the user wants a second opinion / refresh after editing the JD or
 *     resume on file
 *   - a transient API hiccup made the first scoring attempt fail
 *
 * `isRefreshing` swaps the chip / button into a spinner state so the
 * user sees the request is in flight; the existing score stays on screen
 * underneath until the new one lands (no flicker to blank).
 */

/** Translate a raw API error string into a user-friendly headline +
 *  subline. The raw error often leaks HTTP codes / API jargon
 *  ("HTTP 400: Missing JD or questions") that look like a system
 *  crash to non-technical users. Pattern-match on known causes and
 *  fall back to a generic message for unknown ones. */
function friendlyScoreError(raw: string): {
  headline: string;
  subline: string;
} {
  const r = raw.toLowerCase();
  // Most common: session was too short / didn't include any locked
  // questions / didn't include a JD. The /api/score-session route
  // returns "Missing JD or questions" for this case.
  if (
    r.includes("missing jd") ||
    r.includes("missing questions") ||
    r.includes("missing jd or questions")
  ) {
    return {
      headline:
        "This session didn't capture enough content to score.",
      subline:
        "Either no Lead Question was locked, or the session ended before any substantive answer landed.",
    };
  }
  if (r.includes("insufficient")) {
    return {
      headline: "Not enough content for a confident score.",
      subline:
        "The transcript was too short or only contained pleasantries.",
    };
  }
  if (r.includes("rate limit") || r.includes("429")) {
    return {
      headline: "AI scoring is temporarily rate-limited.",
      subline: "Wait a moment and retry.",
    };
  }
  if (r.includes("timeout") || r.includes("timed out")) {
    return {
      headline: "Scoring timed out.",
      subline:
        "The AI took too long to respond — usually a transient issue.",
    };
  }
  if (r.includes("network") || r.includes("fetch") || r.includes("econnreset")) {
    return {
      headline: "Couldn't reach the scoring service.",
      subline: "Check your connection and retry.",
    };
  }
  // Generic fallback — don't expose HTTP code or stack to the user.
  return {
    headline: "We couldn't generate scoring for this session.",
    subline:
      "Something on the AI side went wrong. The transcript is still intact.",
  };
}

function ScoreCard({
  score,
  scoreError,
  onRefresh,
  isRefreshing,
}: {
  score?: SessionScore;
  scoreError?: string;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}) {
  // Failure state — distinguishes "still scoring" (no error, no score)
  // from "scoring permanently failed" (error set). Without this branch
  // the user sees an indefinite loading strip after a failed scoring
  // request with no way to retry except hard-refreshing. Visual tone
  // is muted-warning, NOT alarming-error: the rest of the session
  // (recording, transcript) is fine — only the AI scoring step
  // couldn't complete. We hide the raw error message (HTTP codes etc.)
  // behind a collapsed "Show details" since it's only useful for
  // engineers, and surface a user-friendly explanation derived from
  // the error pattern instead.
  if (!score && scoreError) {
    const friendly = friendlyScoreError(scoreError);
    return (
      <div className="mb-10 rounded-md border border-rule bg-paper-subtle overflow-hidden">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="inline-block text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded bg-paper-hover text-ink-light">
              Scoring unavailable
            </div>
            {onRefresh && (
              <RefreshScoreButton
                onClick={onRefresh}
                isRefreshing={!!isRefreshing}
              />
            )}
          </div>
          <p className="mt-3 text-[14.5px] leading-relaxed text-ink">
            {friendly.headline}
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-light">
            {friendly.subline} Your recording and transcript are still
            saved below. {onRefresh ? "Click Re-score to try again." : ""}
          </p>
          <details className="mt-3 text-[11.5px] text-ink-lighter">
            <summary className="cursor-pointer hover:text-ink-light select-none">
              Show technical details
            </summary>
            <p className="mt-1.5 font-mono break-all bg-paper border border-rule rounded px-2 py-1.5">
              {scoreError}
            </p>
          </details>
        </div>
      </div>
    );
  }
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
  // the endpoint returns none in this case. The Refresh button is
  // anchored top-right of the chip row so the user can retry without
  // having to start a new session.
  if (score.verdict === "insufficient_data") {
    return (
      <div className="mb-10 rounded-xl border border-rule bg-paper overflow-hidden">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div
              className={`inline-block text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${v.chip}`}
            >
              {v.label}
            </div>
            {onRefresh && (
              <RefreshScoreButton
                onClick={onRefresh}
                isRefreshing={!!isRefreshing}
              />
            )}
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
          <div className="flex items-start justify-between gap-3">
            <div
              className={`inline-block text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${v.chip}`}
            >
              {v.label} · {score.percent}%
            </div>
            {onRefresh && (
              <RefreshScoreButton
                onClick={onRefresh}
                isRefreshing={!!isRefreshing}
              />
            )}
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

      {/* Improvements — first entry is the MAIN issue (with elaboration
          + fix); subsequent entries are secondary, title only.
          Backward-compat: legacy sessions stored improvements as
          string[]; we render those as title-only entries. */}
      {score.improvements.length > 0 && (
        <div className="px-5 py-4 bg-paper-subtle border-t border-rule">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-lighter mb-3">
            Areas of Improvement
          </div>
          {(() => {
            // Normalize: legacy localStorage entries may be plain strings;
            // cast widens the type so the runtime check is reachable.
            const raw = score.improvements as unknown as Array<
              { title: string; detail?: string; fix?: string } | string
            >;
            const items = raw.map((imp) =>
              typeof imp === "string" ? { title: imp } : imp
            );
            const main = items[0];
            const secondaries = items.slice(1);
            return (
              <div className="space-y-4">
                {main && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-accent mb-1">
                      Main issue
                    </div>
                    <div className="text-[15px] font-semibold leading-snug text-ink mb-1.5">
                      {main.title}
                    </div>
                    {main.detail && (
                      <p className="text-[13.5px] leading-relaxed text-ink-light mb-2">
                        {main.detail}
                      </p>
                    )}
                    {main.fix && (
                      <div className="text-[13.5px] leading-relaxed text-ink-light">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-lighter mr-2">
                          Fix
                        </span>
                        {main.fix}
                      </div>
                    )}
                  </div>
                )}
                {secondaries.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-lighter mb-1.5">
                      Also worth noting
                    </div>
                    <ul className="space-y-1.5 list-disc list-inside marker:text-ink-lighter">
                      {secondaries.map((imp, i) => (
                        <li
                          key={i}
                          className="text-[13.5px] leading-relaxed text-ink"
                        >
                          {imp.title}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * Screen recording playback + download for a past session.
 *
 * Only mounted when session.videoUrl is set (recording was enabled
 * and the share included a video track). The video element is
 * native HTML5 + browser default controls — keeps this lightweight
 * and works for whatever WebM (vp9 / vp8 / fallback) the recorder
 * happened to produce.
 *
 * The download button generates an `<a download>` from the same
 * blob URL the player uses. File name embeds the session title +
 * date for easy file-tree organization.
 */
function VideoSection({
  videoUrl,
  sessionTitle,
}: {
  videoUrl: string;
  sessionTitle: string;
}) {
  // Sanitize the title into a filesystem-safe filename — strip
  // characters Windows / macOS will choke on or that browsers will
  // refuse, and trim length to keep the suggested filename readable.
  const downloadName = (() => {
    const safe = sessionTitle
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const stamp = new Date().toISOString().slice(0, 10);
    return `${safe || "interview-recording"} — ${stamp}.webm`;
  })();
  return (
    <div className="rounded-md border border-rule overflow-hidden bg-paper mb-8">
      <div className="px-5 py-3 border-b border-rule flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-lighter">
          Recording
        </div>
        <a
          href={videoUrl}
          download={downloadName}
          className="text-[12px] font-medium text-accent hover:underline inline-flex items-center gap-1"
        >
          ↓ Download (.webm)
        </a>
      </div>
      <video
        src={videoUrl}
        controls
        preload="metadata"
        className="w-full bg-black"
      />
      <div className="px-5 py-2 text-[11px] text-ink-lighter italic border-t border-rule">
        Held in browser memory — closing or refreshing this tab will
        erase the recording. Download to keep it.
      </div>
    </div>
  );
}

export function PastView() {
  const t = useTranslations();
  const selectedPastId = useStore((s) => s.selectedPastId);
  const pastSessions = useStore((s) => s.pastSessions);
  const setPastSessionScore = useStore((s) => s.setPastSessionScore);

  const setPastSessionScoreError = useStore(
    (s) => s.setPastSessionScoreError
  );
  const session = pastSessions.find((s) => s.id === selectedPastId);
  const [currentTime, setCurrentTime] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const controlsRef = useRef<PlayerControls | null>(null);

  // Re-fire /api/score-session against the same Session payload. Keeps
  // the existing score visible until the new one lands (no flicker to
  // the loading strip). On failure, surfaces a small error line under
  // the card AND writes the error onto the Session's `scoreError` so
  // the persistent failure UI renders even if the user navigates away
  // and back. Mirrors the original post-end-of-session call in
  // app/page.tsx with matching error handling.
  const refreshScore = async () => {
    if (!session || isRefreshing) return;
    setIsRefreshing(true);
    setRefreshError(null);
    console.log("[scoring] refresh", {
      sessionId: session.id,
      questions: session.questions.length,
    });
    try {
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 90_000);
      let resp: Response;
      try {
        resp = await fetch("/api/score-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jd: session.jd,
            resume: session.resume,
            questions: session.questions,
            durationSeconds: session.durationSeconds,
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!resp.ok) {
        let detail = "";
        try {
          const errBody = (await resp.json()) as {
            error?: string;
            body?: string;
          };
          detail = errBody.error || errBody.body || "";
        } catch {
          /* not json */
        }
        throw new Error(
          detail
            ? `Score request failed (HTTP ${resp.status}): ${detail}`
            : `Score request failed (HTTP ${resp.status})`
        );
      }
      const data = (await resp.json()) as { score?: SessionScore };
      if (data.score) {
        setPastSessionScore(session.id, data.score);
      } else {
        throw new Error("No score returned from server");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Re-score failed";
      console.error("[scoring] refresh failed:", msg);
      setRefreshError(msg);
      // Persist the failure on the Session so the failure card shows
      // even after navigating away and back.
      setPastSessionScoreError(session.id, msg);
    } finally {
      setIsRefreshing(false);
    }
  };

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
          <ScoreCard
            score={session.score}
            scoreError={session.scoreError}
            onRefresh={refreshScore}
            isRefreshing={isRefreshing}
          />
          {refreshError && (
            // Re-score retry failed. Same muted-warning treatment as
            // the ScoreCard's failure card — error string is shown
            // here too because if both failures are about the same
            // root cause, the technical detail at least helps the
            // user spot a pattern. Click-to-dismiss could be added
            // later if this becomes noisy.
            <div className="-mt-7 mb-8 text-[12px] text-ink-light bg-paper-subtle border border-rule rounded-md px-3 py-2">
              <span className="font-semibold">Re-score didn&apos;t complete:</span>{" "}
              <span className="text-ink-lighter">{refreshError}</span>
            </div>
          )}

          {/* Screen recording — shown only when the session was captured
              with "Also record screen video" enabled AND the user shared
              a tab/window with a video track. The blob URL is in-memory
              and dies on tab close / refresh; download is the only way
              to keep it long-term. */}
          {session.videoUrl && (
            <VideoSection
              videoUrl={session.videoUrl}
              sessionTitle={session.title}
            />
          )}

          {/* Interview Transcript — per-question entries listed in
              chronological order. Each entry shows: timestamp, phase
              chip (Lead vs Probe), the question text, the AI commentary
              that fired against the answer (with embedded suggested
              answer via the ---SAY--- block in CommentaryBody), and a
              candidate-answer-text snippet so the user can recall what
              they actually said without replaying audio. Click an entry
              to seek the recording (audio for now; switches to video
              in a follow-up commit). */}
          <div className="mt-8 mb-3 flex items-baseline justify-between">
            <h2 className="text-[15px] font-semibold uppercase tracking-wider text-ink">
              {t("Interview Transcript", "面试记录")}
            </h2>
            <span className="text-[11px] text-ink-lighter">
              {session.questions.length}{" "}
              {session.questions.length === 1
                ? t("entry", "条")
                : t("entries", "条")}
            </span>
          </div>
          {session.questions.map((q) => {
            const isPlaying = q.id === activeQId;
            const isProbe = !!q.parentQuestionId;
            // Truncate the candidate answer to a snippet — full text is
            // available via the recording / scrolling. ~280 chars covers
            // a typical first paragraph; longer answers ellipsize.
            const answerSnippet = (q.answerText || "").trim();
            const answerPreview =
              answerSnippet.length > 280
                ? answerSnippet.slice(0, 280).trim() + "…"
                : answerSnippet;
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
                  {/* Phase chip — distinguishes the main Lead Question
                      from drill-down Probe Questions. The visual weight
                      is small enough not to distract from the content. */}
                  <div className="mb-2">
                    <span
                      className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded ${
                        isProbe
                          ? "bg-paper-hover text-ink-light"
                          : "bg-accent-bg text-accent"
                      }`}
                    >
                      {isProbe
                        ? t("Probe Question", "追问")
                        : t("Lead Question", "主问题")}
                    </span>
                  </div>
                  <div className="font-serif text-base font-medium leading-snug mb-2.5 text-ink">
                    {q.text}
                  </div>
                  {/* Candidate's answer snippet — what they actually
                      said in response. Empty / italic placeholder for
                      questions where no answer text was captured (e.g.
                      session ended before they answered, or this is an
                      old session saved before answerText was persisted). */}
                  {answerPreview ? (
                    <div className="mb-3 pl-3 border-l-2 border-rule">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-lighter mb-1">
                        {t("Candidate's answer", "候选人回答")}
                      </div>
                      <p className="text-[13.5px] leading-relaxed text-ink-light italic">
                        {answerPreview}
                      </p>
                    </div>
                  ) : (
                    <div className="mb-3 text-[12.5px] text-ink-lighter italic">
                      {t(
                        "No answer text captured for this question.",
                        "本题未捕获到回答文本。"
                      )}
                    </div>
                  )}
                  {/* AI commentary on this Q&A pair — includes the
                      suggested-answer block (---SAY---) inline via
                      CommentaryBody when present. */}
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
