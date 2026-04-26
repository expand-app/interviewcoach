"use client";

import { useState, useEffect, useRef } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { LiveView } from "@/components/LiveView";
import { LiveDebugPanel } from "@/components/LiveDebugPanel";
import { PastView } from "@/components/PastView";
import { LoginView } from "@/components/LoginView";
import { StartModal } from "@/components/modals/StartModal";
import { ConfirmModal } from "@/components/modals/ConfirmModal";
import { PromptModal } from "@/components/modals/PromptModal";
import { EndSessionModal } from "@/components/modals/EndSessionModal";
import { ModalShell } from "@/components/modals/ModalShell";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { getOrchestrator } from "@/lib/orchestrator";
import { logClient } from "@/lib/client-log";

export default function Page() {
  const t = useTranslations();

  // Global store
  const user = useStore((s) => s.user);
  const selectedPastId = useStore((s) => s.selectedPastId);
  const startLive = useStore((s) => s.startLive);
  const liveStatus = useStore((s) => s.live.status);
  const endLive = useStore((s) => s.endLive);
  const selectPast = useStore((s) => s.selectPast);
  const renamePast = useStore((s) => s.renamePastSession);
  const deletePast = useStore((s) => s.deletePastSession);
  const setPastSessionScore = useStore((s) => s.setPastSessionScore);
  const setLiveTitle = useStore((s) => s.setLiveTitle);
  const liveTitle = useStore((s) => s.liveTitle);
  const liveTimeline = useStore((s) => s.liveTimeline);
  const liveIsUploadMode = useStore((s) => s.liveIsUploadMode);
  const setElapsed = useStore((s) => s.setElapsed);
  const setLiveStatus = useStore((s) => s.setLiveStatus);
  const resetLive = useStore((s) => s.resetLive);

  // Modal state
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  // Closing-detection prompt: surfaces when the orchestrator detects a
  // mutual-goodbye + 3s silence pattern. User picks save (one-click End
  // & Save with the auto-derived liveTitle) or "continue recording"
  // (permanently silences future closing-detection fires this session).
  const [showClosingPrompt, setShowClosingPrompt] = useState(false);
  useEffect(() => {
    const handler = () => setShowClosingPrompt(true);
    window.addEventListener("ic:closing-detected", handler);
    return () => window.removeEventListener("ic:closing-detected", handler);
  }, []);

  // Toast state (simple non-intrusive error notifications)
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent).detail as string;
      setToast(msg);
      setTimeout(() => setToast(null), 3500);
    };
    window.addEventListener("ic:error", handler);
    return () => window.removeEventListener("ic:error", handler);
  }, []);

  // Upload-mode processing stage — drives a blocking overlay with
  // progress bar while transcription + pre-identify + pre-analysis run.
  // Subscribed from the store so stage transitions in the orchestrator
  // also update the UI.
  const processingStage = useStore((s) => s.liveProcessingStage);
  const processingError = useStore((s) => s.liveProcessingError);

  // Playback-complete banner state. Separate from the transient error
  // toast so it stays visible until the user dismisses it or hits End &
  // Save — we want them to see the "view your scoring" prompt.
  const [playbackDone, setPlaybackDone] = useState(false);
  useEffect(() => {
    const handler = () => setPlaybackDone(true);
    window.addEventListener("ic:playback-ended", handler);
    return () => window.removeEventListener("ic:playback-ended", handler);
  }, []);

  // Tick the elapsed timer every second while recording.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (liveStatus !== "recording") {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    const startedAt = Date.now() - useStore.getState().live.elapsedSeconds * 1000;
    intervalRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [liveStatus, setElapsed]);

  // === Handlers ===

  const handleStart = () => {
    if (liveStatus === "paused") {
      // Resume — no modal, just flip status and resume audio.
      // The browser may re-prompt for tab share if system-audio was
      // enabled; that's the cost of fully releasing the mic on pause
      // per user spec.
      void getOrchestrator().resume();
      return;
    }
    // Fresh start — show the JD/Resume modal
    setShowStart(true);
  };

  const handleStartConfirm = async (args: {
    mode: "live" | "upload";
    jd: string;
    resume: string;
    file?: File;
    captureSystemAudio?: boolean;
    captureVideo?: boolean;
  }) => {
    setShowStart(false);
    startLive(args.jd, args.resume);
    // Kick off title extraction in parallel with session start — the
    // heading defaults to "Live Interview Session" until it returns.
    void (async () => {
      try {
        const r = await fetch("/api/session-title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jd: args.jd, resume: args.resume }),
        });
        if (!r.ok) return;
        const data = (await r.json()) as { title?: string };
        if (data.title) setLiveTitle(data.title);
      } catch {
        /* non-blocking — heading just stays as the default */
      }
    })();
    try {
      if (args.mode === "upload" && args.file) {
        // Transcribe first, then drive the orchestrator off the file.
        // Stages (transcribing → identifying → analyzing → ready) drive
        // a blocking overlay so the user sees real progress instead of a
        // single opaque toast.
        useStore.getState().setLiveProcessingStage("transcribing");
        const form = new FormData();
        form.append("file", args.file);
        const resp = await fetch("/api/transcribe-file", {
          method: "POST",
          body: form,
        });
        if (!resp.ok) {
          const txt = await resp.text();
          throw new Error(`Transcription failed: ${txt}`);
        }
        const data = (await resp.json()) as {
          utterances?: Array<{
            text: string;
            speaker?: number;
            start: number;
            end: number;
            duration: number;
          }>;
        };
        setToast(null);
        if (!data.utterances || data.utterances.length === 0) {
          throw new Error("No speech detected in the recording.");
        }
        // Single-speaker recordings break the interview pipeline — no
        // interviewer voice means classify-moment can't detect question
        // transitions and commentary stalls. Flag it clearly so the user
        // knows why the experience will be limited instead of just
        // watching it silently misbehave.
        const distinctSpeakers = new Set(
          data.utterances
            .map((u) => u.speaker)
            .filter((s): s is number => typeof s === "number")
        );
        if (distinctSpeakers.size < 2) {
          setToast(
            "Only one speaker detected in this recording — the interviewer's voice is missing. Commentary will be limited. Upload a recording that contains BOTH sides of the call (e.g. Zoom 'Record to this computer' produces a mixed-audio file)."
          );
        }
        // startWithFile transitions the stage through identifying →
        // analyzing → ready itself; we just clear it once playback
        // begins so the overlay dismisses.
        await getOrchestrator().startWithFile(args.file, data.utterances);
        useStore.getState().setLiveProcessingStage("idle");
      } else {
        // captureSystemAudio: explicit user choice from the start modal.
        // - true  → "on": always prompt for tab/window share with audio,
        //           regardless of headphone detection
        // - false → "off": mic-only, skip the share prompt entirely
        // - undefined → "auto": legacy default (headphones-detected →
        //           prompt for share). Kept for any non-modal entry points.
        const captureTabAudio: "auto" | "on" | "off" =
          args.captureSystemAudio === true
            ? "on"
            : args.captureSystemAudio === false
            ? "off"
            : "auto";
        // captureVideo is meaningless without tab share — gate on it.
        const captureVideo =
          captureTabAudio !== "off" && args.captureVideo === true;
        await getOrchestrator().start({ captureTabAudio, captureVideo });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to start";
      setToast(msg);
      setLiveStatus("idle");
      useStore.getState().setLiveProcessingStage("failed", msg);
    }
  };

  // Pause is fire-and-forget — no confirmation modal. Clicking the
  // pause button in the Topbar immediately halts capture (releases
  // mic, closes Deepgram socket, stops MediaRecorders). Resume button
  // appears in its place.
  const handlePauseRequest = () => {
    void getOrchestrator().pause();
  };

  const handleEndRequest = () => setShowEnd(true);

  /** "Discard" branch of the End modal — user wants to stop the
   *  live session WITHOUT saving it. Releases mic / closes Deepgram /
   *  drops accumulated chunks (audio + video), wipes the live state.
   *  Past Sessions list is unaffected. Used when the live session was
   *  a misstart, a mic check, or otherwise not worth preserving. */
  const handleEndDiscard = async () => {
    setShowEnd(false);
    setPlaybackDone(false);
    // Stop the orchestrator. This calls AudioSession.stop() which
    // builds the audio/video blobs and stashes them on window.__ic_*Url
    // — but we deliberately do NOT read those URLs into a Session,
    // so the blob objects become garbage-collectable as soon as we
    // null out the window references below.
    await getOrchestrator().stop();
    const win = window as unknown as {
      __ic_audioUrl?: string;
      __ic_videoUrl?: string;
    };
    win.__ic_audioUrl = undefined;
    win.__ic_videoUrl = undefined;
    // Wipe in-memory live state (questions, utterances, timeline,
    // moment-state machine, etc.). This is the same cleanup that
    // resetLive does internally; calling it here means the LiveView
    // re-renders empty, ready for a fresh Start.
    resetLive();
  };

  const handleEndConfirm = async (title: string) => {
    setShowEnd(false);
    setPlaybackDone(false);
    // For upload-mode sessions, flush any utterances that haven't reached
    // the orchestrator yet (user stopped playback early) so scoring sees
    // the full transcript. No-op for live mic sessions.
    getOrchestrator().flushBeforeEnd();
    await getOrchestrator().stop();
    // Pick up the recorded audio URL that the orchestrator stashed.
    // Same dance for the optional video URL — only present when the
    // user enabled "Also record screen video" AND the share was
    // accepted with a video track.
    const win = window as unknown as {
      __ic_audioUrl?: string;
      __ic_videoUrl?: string;
    };
    const audioUrl = win.__ic_audioUrl;
    const videoUrl = win.__ic_videoUrl;
    const saved = endLive(title, audioUrl, videoUrl);
    win.__ic_audioUrl = undefined;
    win.__ic_videoUrl = undefined;
    selectPast(saved.id);

    // Fire-and-forget overall scoring. PastView renders a spinner until
    // `saved.score` populates. No retry — on failure the view shows a
    // "scoring unavailable" state and the user can regenerate later.
    void scoreSessionAsync(saved);
  };

  const setPastSessionScoreError = useStore((s) => s.setPastSessionScoreError);

  const scoreSessionAsync = async (saved: ReturnType<typeof endLive>) => {
    // Diagnostic log: how big is the payload going to the route? Lets us
    // catch token-budget blowups (50min interviews, big JD/resume) before
    // they manifest as silent failures.
    console.log("[scoring] firing /api/score-session", {
      sessionId: saved.id,
      questions: saved.questions.length,
      durationSec: saved.durationSeconds,
      jdChars: saved.jd.length,
      resumeChars: saved.resume.length,
      qsWithAnswerText: saved.questions.filter(
        (q) => typeof q.answerText === "string" && q.answerText.length > 0
      ).length,
    });
    try {
      // 90-second hard timeout via AbortController. The route itself can
      // take 30+ seconds when Sonnet is generating a full scorecard for
      // a 32-min interview, but anything past 90s is almost certainly
      // hung — better to surface a retryable error than leave the user
      // staring at a forever-spinner.
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 90_000);
      let resp: Response;
      try {
        resp = await fetch("/api/score-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jd: saved.jd,
            resume: saved.resume,
            questions: saved.questions,
            durationSeconds: saved.durationSeconds,
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!resp.ok) {
        // Try to lift any structured error body the route returned so
        // the failure card can show specifics (e.g. "model API
        // overloaded" vs "prompt too long" vs "auth missing").
        let detail = "";
        try {
          const errBody = (await resp.json()) as {
            error?: string;
            body?: string;
          };
          detail = errBody.error || errBody.body || "";
        } catch {
          /* response wasn't json */
        }
        throw new Error(
          detail
            ? `Scoring failed (HTTP ${resp.status}): ${detail}`
            : `Scoring failed (HTTP ${resp.status})`
        );
      }
      const data = (await resp.json()) as {
        score?: Parameters<typeof setPastSessionScore>[1];
      };
      if (data.score) {
        setPastSessionScore(saved.id, data.score);
      } else {
        // 200 OK but no score field — server contract was broken (route
        // should always return either { score } or a non-2xx with
        // { error }). Treat as failure so the UI shows a retry-able
        // error card instead of an infinite loader.
        throw new Error("Scoring returned no score payload");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Scoring failed";
      console.error("[scoring] failed:", msg);
      // Mark the session's score as permanently failed (until retried).
      // PastView's ScoreCard renders a friendly muted-warning UI when
      // scoreError is set (with a Re-score button), so we DON'T also
      // fire a red toast for the same failure — that was triple-banner
      // noise (rose ScoreCard + small rose box + bottom red toast).
      // The ScoreCard alone is sufficient and on-context.
      setPastSessionScoreError(saved.id, msg);
    }
  };

  if (!user) return <LoginView />;

  // Right-rail panel logic. Two mutually-exclusive panels share the
  // 360px right column on the Live tab:
  //   - Upload-mode ReviewPanel: full coaching timeline, clickable to
  //     seek the recording.
  //   - Live-mode LiveDebugPanel: real-time event log + user comment
  //     pinning, so the user can flag issues at specific timestamps
  //     and ship me a debrief.
  // When a past session is selected (selectedPastId !== null) no right
  // rail shows — that view is read-only.
  const hasReviewPanel = selectedPastId === null && liveIsUploadMode;
  const hasDebugPanel = selectedPastId === null && !liveIsUploadMode;
  const hasRightRail = hasReviewPanel || hasDebugPanel;
  // Suppress unused-var warning for future rounds (preanalyze timeline).
  void liveTimeline;

  return (
    <div
      className={`grid h-screen max-[900px]:grid-cols-1 ${
        hasRightRail
          ? "grid-cols-[240px_1fr_360px]"
          : "grid-cols-[240px_1fr]"
      }`}
    >
      <Sidebar
        onRenameRequest={(id, title) => setRenameTarget({ id, title })}
        onDeleteRequest={(id, title) => setDeleteTarget({ id, title })}
      />

      <main className="flex flex-col overflow-hidden">
        <Topbar
          onStart={handleStart}
          onPause={handlePauseRequest}
          onEnd={handleEndRequest}
        />
        {selectedPastId === null ? <LiveView /> : <PastView />}
      </main>

      {/* Upload-mode right rail: full timeline arranged by timestamp.
          Entries are clickable — click any one to seek the recording to
          that moment. Listening "what the UI SHOULD be doing" for any
          point in the recording. Hidden when no timeline is active. */}
      {hasReviewPanel && <ReviewPanel />}

      {/* Live-mode right rail: real-time debug log + user comment
          pinning. User watches events tick in as the session runs,
          notices issues, pins comments to specific timestamps, then
          copies a debrief bundle to paste back to Claude. */}
      {hasDebugPanel && <LiveDebugPanel />}

      {/* Modals */}
      <StartModal
        open={showStart}
        onCancel={() => setShowStart(false)}
        onStart={handleStartConfirm}
      />

      <EndSessionModal
        open={showEnd}
        initialTitle={liveTitle || t("Untitled session", "未命名面试")}
        onSave={handleEndConfirm}
        onDiscard={handleEndDiscard}
        onCancel={() => setShowEnd(false)}
      />

      <PromptModal
        open={Boolean(renameTarget)}
        title={t("Rename session", "重命名")}
        description={t("Give this session a new name.", "为这场面试设置一个新名称。")}
        initialValue={renameTarget?.title || ""}
        confirmLabel={t("Rename", "重命名")}
        cancelLabel={t("Cancel", "取消")}
        onCancel={() => setRenameTarget(null)}
        onConfirm={(value) => {
          if (renameTarget) renamePast(renameTarget.id, value);
          setRenameTarget(null);
        }}
      />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t("Delete this session?", "删除这场面试?")}
        description={
          <>
            {t(
              `This will permanently delete "`,
              `"`
            )}
            <b>{deleteTarget?.title}</b>
            {t(
              `" including its recording and commentary. This cannot be undone.`,
              `" 将被永久删除,包括录音和所有评论。此操作无法撤销。`
            )}
          </>
        }
        confirmLabel={t("Delete", "删除")}
        cancelLabel={t("Cancel", "取消")}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deletePast(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />

      {/* Closing-detected prompt — fired by the orchestrator when the
          classifier flips into `closing` and no substantive utterance
          arrives within 3 seconds. Two options:
            - Continue recording: permanently silences future closing-
              detection fires this session (calls
              orchestrator.disableClosingDetection()) and dismisses.
            - Save & view scoring: one-click End & Save with the
              auto-derived liveTitle, then jumps to the Past view.
              Skips the title-prompt modal — the user can rename later
              from the past sessions list. */}
      <ConfirmModal
        open={showClosingPrompt}
        title={t(
          "Looks like the interview just wrapped up",
          "面试似乎已经结束"
        )}
        description={t(
          "Detected a goodbye exchange and 3 seconds of silence. Save now and view the scorecard?",
          "检测到对话已收尾且双方静默超过 3 秒。要现在保存并查看评分吗?"
        )}
        confirmLabel={t("Save & view scoring", "保存并查看评分")}
        cancelLabel={t("Continue recording", "继续录制")}
        onCancel={() => {
          setShowClosingPrompt(false);
          getOrchestrator().disableClosingDetection();
        }}
        onConfirm={() => {
          setShowClosingPrompt(false);
          // One-click save: use the auto-derived live title (or a
          // generic fallback). Routes through handleEndConfirm — same
          // flow as the manual End & Save button, including audioUrl
          // pickup, scoreSessionAsync fire, and selectPast(saved.id)
          // which jumps to the scorecard view.
          const titleForSave =
            liveTitle || t("Live Interview Session", "面试录制");
          void handleEndConfirm(titleForSave);
        }}
      />

      {/* Speaker-identity prompt — shown in live mode when a new
          speaker appears and we don't yet know whether they're the
          interviewer or the candidate. Non-blocking; sits top-center
          so it doesn't cover the captions. User picks, prompt clears,
          commentary/questions start flowing (gated on
          rolesConfirmed). */}
      <SpeakerIdentityPrompt />

      {/* Error toast */}
      {toast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-[#c73434] text-paper py-2.5 px-4 rounded-md text-[13.5px] z-[100] shadow-lg animate-appear">
          {toast}
        </div>
      )}

      {/* Upload-mode processing overlay. Blocks the UI during
          transcribe → identify → analyze so users aren't staring at a
          half-populated Live view. Shows an indeterminate progress bar
          anchored to the current stage. */}
      {processingStage !== "idle" &&
        processingStage !== "ready" && (
          <ProcessingOverlay stage={processingStage} error={processingError} />
        )}

      {/* Playback-complete banner — shown when an uploaded recording
          finishes playing. Sits above the error toast region so it
          doesn't overlap if something else fires. Persists until the
          user dismisses it or hits End & Save. */}
      {playbackDone && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-ink text-paper py-3 px-4 rounded-md text-[13.5px] z-[100] shadow-lg animate-appear flex items-center gap-3 max-w-[620px]">
          <span className="flex-1">
            Recording complete — click <b>End</b> to save and see how
            you performed.
          </span>
          <button
            onClick={() => {
              setPlaybackDone(false);
              handleEndRequest();
            }}
            className="shrink-0 bg-accent text-white text-[12.5px] font-medium py-1.5 px-3 rounded-md hover:bg-[#1a73d1]"
          >
            End →
          </button>
          <button
            onClick={() => setPlaybackDone(false)}
            className="shrink-0 text-paper/70 hover:text-paper text-lg leading-none"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Blocking overlay shown during the upload-mode processing stages.
 * The three network phases (transcribe → identify → analyze) each take
 * several seconds; without a clear progress indicator users have
 * reported thinking the page was broken or refreshing away from it.
 * Overlay is full-screen to prevent clicks from mis-firing during the
 * wait. On "failed" it flips to an error state with a dismiss button.
 */
/**
 * Right-side Review Panel — shown during upload-mode playback. Renders
 * every piece of the pre-computed coaching timeline (phases, questions,
 * commentary, listening hints) merged with captions into a single
 * chronological view. Each TYPE gets its own distinct visual
 * treatment so the user can skim and immediately spot miscategorized
 * moments:
 *
 *   PHASE      → full-width banded divider with the phase name
 *   QUESTION   → large accent-tinted card with the question text
 *   COMMENTARY → indigo-bordered inset block (attached to current Q)
 *   HINT       → amber-bordered inset block
 *   CAPTION    → simple timestamped row with a role badge
 *
 * A sticky TOC at the top lists every question with its timestamp so
 * the overall structure is legible at a glance. Every row is
 * clickable — click dispatches `ic:seek-to` and LiveView seeks the
 * audio. The "current" row (latest entry with sec <= playbackTime)
 * gets a left-border highlight.
 */
function ReviewPanel() {
  const timeline = useStore((s) => s.liveTimeline);
  const utterances = useStore((s) => s.liveUtterances);
  const playbackTime = useStore((s) => s.livePlaybackTime);
  const speakerRoles = useStore((s) => s.liveSpeakerRoles);

  if (!timeline && utterances.length === 0) return null;

  type Entry =
    | { sec: number; kind: "phase"; phaseKind: string; questionId?: string }
    | {
        sec: number;
        kind: "question";
        id: string;
        text: string;
        isProbe: boolean;
      }
    | { sec: number; kind: "commentary"; text: string; questionId: string }
    | { sec: number; kind: "hint"; text: string }
    | {
        sec: number;
        kind: "caption";
        role: "interviewer" | "candidate" | "unknown";
        text: string;
      };

  const entries: Entry[] = [];
  if (timeline) {
    for (const p of timeline.phases) {
      entries.push({
        sec: p.fromSec,
        kind: "phase",
        phaseKind: p.kind,
        questionId: p.questionId,
      });
    }
    for (const q of timeline.questions) {
      entries.push({
        sec: q.askedAtSec,
        kind: "question",
        id: q.id,
        text: q.text,
        isProbe: !!q.parentId,
      });
    }
    for (const c of timeline.commentary) {
      entries.push({
        sec: c.atSec,
        kind: "commentary",
        text: c.text,
        questionId: c.questionId,
      });
    }
    for (const h of timeline.listeningHints) {
      entries.push({ sec: h.atSec, kind: "hint", text: h.text });
    }
  }
  for (const u of utterances) {
    const role =
      u.dgSpeaker !== undefined && speakerRoles[u.dgSpeaker] === "interviewer"
        ? ("interviewer" as const)
        : u.dgSpeaker !== undefined &&
          speakerRoles[u.dgSpeaker] === "candidate"
        ? ("candidate" as const)
        : ("unknown" as const);
    entries.push({ sec: u.atSeconds, kind: "caption", role, text: u.text });
  }
  entries.sort((a, b) => a.sec - b.sec);

  let currentIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].sec <= playbackTime) {
      currentIdx = i;
      break;
    }
  }

  const fmt = (s: number) => {
    if (!isFinite(s)) return "00:00";
    const mm = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };

  const seek = (sec: number) =>
    window.dispatchEvent(new CustomEvent("ic:seek-to", { detail: sec }));

  const phaseLabel = (k: string) => {
    switch (k) {
      case "chitchat":
        return {
          text: "Small talk",
          band: "bg-slate-100 border-slate-300 text-slate-700",
        };
      case "interviewer_asking_first":
        return {
          text: "Interviewer asking",
          band: "bg-accent-bg border-accent/30 text-accent",
        };
      case "interviewer_probing":
        return {
          text: "Interviewer probing",
          band: "bg-accent-bg border-accent/30 text-accent",
        };
      case "candidate_answering":
        return {
          text: "Candidate answering",
          band: "bg-emerald-50 border-emerald-300 text-emerald-700",
        };
      case "between_questions":
        return {
          text: "Between questions",
          band: "bg-amber-50 border-amber-300 text-amber-800",
        };
      default:
        return {
          text: k,
          band: "bg-slate-100 border-slate-300 text-slate-600",
        };
    }
  };

  const leads = (timeline?.questions ?? []).filter((q) => !q.parentId);
  const probes = (timeline?.questions ?? []).filter((q) => q.parentId);

  // Commentary sanity check: if we have questions but the commentary
  // array is empty, something failed in the extract-commentary step —
  // surface it prominently so the user sees it instead of silently
  // wondering where the commentary went.
  const commentaryMissing =
    !!timeline &&
    timeline.questions.length > 0 &&
    timeline.commentary.length === 0;
  const commentaryCount = timeline?.commentary.length ?? 0;
  const phaseCount = timeline?.phases.length ?? 0;
  const captionCount = utterances.length;

  return (
    <aside className="border-l border-rule bg-paper-subtle overflow-hidden flex flex-col max-[900px]:hidden">
      {/* Sticky header: quick glance at questions */}
      <div className="px-4 py-3 border-b border-rule bg-paper shrink-0">
        <div className="text-[13px] font-semibold text-ink">
          Review Panel
        </div>
        <div className="text-[11px] text-ink-lighter mt-0.5 leading-relaxed">
          Click any row to seek to that moment. If a phase / question /
          commentary is miscategorized, just tell me the timestamp.
        </div>

        {/* Counts row — makes "commentary missing" obvious at a glance
            (instead of requiring the user to scan the scroll list). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10.5px] font-mono">
          <span className="text-accent">{phaseCount} phases</span>
          <span className="text-ink-lighter">·</span>
          <span className="text-accent">
            {leads.length} leads / {probes.length} probes
          </span>
          <span className="text-ink-lighter">·</span>
          <span
            className={
              commentaryCount === 0 ? "text-rose-600 font-semibold" : "text-indigo-700"
            }
          >
            {commentaryCount} commentary{commentaryCount === 0 ? " ⚠" : ""}
          </span>
          <span className="text-ink-lighter">·</span>
          <span className="text-ink-light">{captionCount} captions</span>
        </div>

        {commentaryMissing && (
          <div className="mt-3 px-3 py-2 rounded bg-rose-50 border border-rose-200 text-[11.5px] text-rose-800 leading-relaxed">
            <b>Commentary is empty.</b> Questions extracted successfully but commentary came back empty. Check the dev server terminal for
            <code className="mx-1 font-mono bg-rose-100 px-1 rounded">[extract-commentary]</code>
            logs — typically Sonnet returned 0 entries, a JSON parse failure, or mismatched questionIds.
          </div>
        )}

        {leads.length > 0 && (
          <div className="mt-3 pt-3 border-t border-rule/60">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-lighter mb-1.5">
              Questions at a glance ({leads.length} lead
              {leads.length === 1 ? "" : "s"}
              {probes.length > 0 ? ` · ${probes.length} probe${probes.length === 1 ? "" : "s"}` : ""})
            </div>
            <ol className="space-y-1">
              {leads.map((q, i) => {
                const qProbes = probes.filter((p) => p.parentId === q.id);
                return (
                  <li key={q.id}>
                    <button
                      onClick={() => seek(q.askedAtSec)}
                      className="w-full text-left flex items-baseline gap-1.5 text-[11.5px] text-ink-light hover:text-accent leading-snug"
                    >
                      <span className="font-mono tabular-nums text-ink-lighter shrink-0 w-[38px]">
                        {fmt(q.askedAtSec)}
                      </span>
                      <span className="font-mono text-ink-lighter shrink-0 w-[18px]">
                        Q{i + 1}
                      </span>
                      <span className="flex-1 truncate" title={q.text}>
                        {q.text}
                      </span>
                    </button>
                    {qProbes.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => seek(p.askedAtSec)}
                        className="w-full text-left flex items-baseline gap-1.5 text-[11px] text-ink-lighter hover:text-accent leading-snug pl-[60px]"
                      >
                        <span className="font-mono tabular-nums shrink-0 w-[38px]">
                          {fmt(p.askedAtSec)}
                        </span>
                        <span className="shrink-0 w-[18px]">↳</span>
                        <span className="flex-1 truncate" title={p.text}>
                          {p.text}
                        </span>
                      </button>
                    ))}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </div>

      {/* Chronological body. Each entry type renders with a distinct
          visual treatment so mis-categorizations stand out. */}
      <ol className="flex-1 overflow-y-auto">
        {entries.map((e, i) => {
          const isCurrent = i === currentIdx;
          const currentRing = isCurrent
            ? "border-l-[3px] border-l-accent"
            : "border-l-[3px] border-l-transparent";

          // PHASE → full-width colored divider banner
          if (e.kind === "phase") {
            const ph = phaseLabel(e.phaseKind);
            return (
              <li
                key={`${e.kind}-${i}-${e.sec}`}
                onClick={() => seek(e.sec)}
                className={`cursor-pointer ${currentRing}`}
              >
                <div
                  className={`flex items-center gap-2 px-4 py-1.5 border-y ${ph.band}`}
                >
                  <span className="font-mono text-[10.5px] font-semibold tabular-nums">
                    {fmt(e.sec)}
                  </span>
                  <span className="text-[10.5px] font-semibold uppercase tracking-wider">
                    ▸ {ph.text}
                  </span>
                </div>
              </li>
            );
          }

          // QUESTION → prominent accent card
          if (e.kind === "question") {
            return (
              <li
                key={`${e.kind}-${i}-${e.sec}`}
                onClick={() => seek(e.sec)}
                className={`cursor-pointer ${currentRing} hover:bg-paper-hover`}
              >
                <div className="px-4 py-3 bg-accent-bg/60 border-y border-accent/20">
                  <div className="flex items-baseline gap-2 mb-1">
                    <span className="font-mono text-[11px] font-semibold text-accent tabular-nums">
                      {fmt(e.sec)}
                    </span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-accent">
                      {e.isProbe ? "PROBE QUESTION" : "LEAD QUESTION"}
                    </span>
                  </div>
                  <div className="text-[13.5px] font-semibold leading-relaxed text-ink">
                    {e.text}
                  </div>
                </div>
              </li>
            );
          }

          // COMMENTARY + HINT → unified indigo-bordered inset under the
          // same "Live Commentary · 评论" label. Listening hints used to
          // have their own amber styling but everything lives under a
          // single commentary category now.
          if (e.kind === "commentary" || e.kind === "hint") {
            return (
              <li
                key={`${e.kind}-${i}-${e.sec}`}
                onClick={() => seek(e.sec)}
                className={`cursor-pointer ${currentRing} hover:bg-paper-hover`}
              >
                <div className="mx-4 my-2 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded">
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="font-mono text-[10.5px] font-semibold text-indigo-700 tabular-nums">
                      {fmt(e.sec)}
                    </span>
                    <span className="text-[9.5px] font-semibold uppercase tracking-wider text-indigo-700">
                      COMMENTARY
                    </span>
                  </div>
                  <div
                    className="text-[12.5px] leading-relaxed text-ink prose-live"
                    dangerouslySetInnerHTML={{ __html: e.text }}
                  />
                </div>
              </li>
            );
          }

          // CAPTION → timestamped transcript line with role badge
          return (
            <li
              key={`${e.kind}-${i}-${e.sec}`}
              onClick={() => seek(e.sec)}
              className={`cursor-pointer ${currentRing} hover:bg-paper-hover border-b border-rule/40`}
            >
              <div className="px-4 py-2">
                <div className="flex items-baseline gap-2 mb-0.5">
                  <span className="font-mono text-[11px] font-semibold text-ink-light tabular-nums">
                    {fmt(e.sec)}
                  </span>
                  <span
                    className={`text-[9.5px] font-semibold uppercase tracking-wider ${
                      e.role === "interviewer"
                        ? "text-accent"
                        : e.role === "candidate"
                        ? "text-emerald-700"
                        : "text-ink-lighter"
                    }`}
                  >
                    {e.role === "interviewer"
                      ? "Interviewer"
                      : e.role === "candidate"
                      ? "Candidate"
                      : "Speaker"}
                  </span>
                </div>
                <div className="text-[13px] leading-relaxed text-ink">
                  {e.text}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/**
 * Floating speaker-identity prompt. Shown when the orchestrator has
 * heard a NEW dgSpeaker it doesn't know the role of, and can't infer
 * it from the already-committed roles (which it CAN when one role is
 * already known — only the FIRST speaker gets a prompt, since the
 * second is automatically the opposite role).
 *
 * Non-blocking by design — the interview can't pause while we ask. It
 * sits top-center with both options one click away. Until the user
 * picks, commentary / questions stay gated (via rolesConfirmed) and
 * captions show as "Speaker 1 / Speaker 2".
 */
function SpeakerIdentityPrompt() {
  const prompt = useStore((s) => s.liveSpeakerPrompt);
  const resolve = useStore((s) => s.resolveSpeakerPrompt);
  // Gate on live view. The modal is mounted at the app root so it can
  // appear from anywhere, but it should NEVER show while the user is
  // looking at a past session — that's a privacy / UX violation. If a
  // previous live session is still actively capturing in the background
  // and trips the new-speaker detection, the prompt would otherwise
  // pop on top of past-session view content. Bug repro: start live,
  // click a past session in the sidebar, watch the modal appear when
  // Deepgram next labels a new speaker. selectPast also clears any
  // pending prompt as a defensive measure.
  const onPastView = useStore((s) => s.selectedPastId) !== null;

  if (onPastView) return null;
  if (!prompt) return null;

  // Cap the preview text so a long first utterance doesn't blow out
  // the card layout. Users just need a hint of voice content to
  // recognize "oh that's me" vs "that's the interviewer".
  const preview =
    prompt.sampleText.length > 120
      ? prompt.sampleText.slice(0, 120).trim() + "…"
      : prompt.sampleText.trim();

  const resolveAndLog = (role: "interviewer" | "candidate") => {
    logClient("roles", "manual", { dg: prompt.dgSpeaker, role });
    resolve(role);
  };

  // Uses the same ModalShell as other modals in the app — centered,
  // backdrop-blur, consistent chrome. Not dismissible: the user must
  // tag the speaker before the pipeline can proceed.
  return (
    <ModalShell open={true} onClose={() => {}} dismissible={false}>
      <div className="p-7 px-8">
        <h2 className="text-[18px] font-semibold mb-1.5 text-ink">
          Who&apos;s speaking?
        </h2>
        <div className="text-sm text-ink-light mb-4 leading-relaxed">
          A new voice just came in. Tag their role so captions and AI
          commentary can label them correctly. You only need to tag one
          side — the other will be matched automatically when they speak.
        </div>

        {/* Quoted sample so the user can recognize the voice. Serif
            + left rule matches the Lead Question treatment elsewhere. */}
        <div className="border-l-2 border-rule-strong pl-3 py-1 mb-5">
          <div className="font-serif text-[15px] leading-snug text-ink italic">
            &ldquo;{preview}&rdquo;
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => resolveAndLog("interviewer")}
            className="flex-1 px-4 py-2.5 rounded-md text-sm font-medium text-white border bg-accent hover:bg-[#1a73d1] border-accent transition-colors"
          >
            Interviewer
          </button>
          <button
            onClick={() => resolveAndLog("candidate")}
            className="flex-1 px-4 py-2.5 rounded-md text-sm font-medium border border-rule-strong bg-paper text-ink hover:bg-paper-hover transition-colors"
          >
            Candidate
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function ProcessingOverlay({
  stage,
  error,
}: {
  stage:
    | "idle"
    | "transcribing"
    | "identifying"
    | "analyzing"
    | "ready"
    | "failed";
  error: string;
}) {
  // Stage-specific copy and progress-bar fill. Stages are roughly
  // additive in time (transcribe ~5-10s, identify ~2-5s, analyze ~15-30s),
  // so the indeterminate fill nudges forward at each stage.
  const stageCopy: Record<
    typeof stage,
    { title: string; desc: string; pct: number }
  > = {
    idle: { title: "", desc: "", pct: 0 },
    transcribing: {
      title: "Transcribing recording",
      desc: "Deepgram is diarizing the audio into speaker-labeled turns.",
      pct: 25,
    },
    identifying: {
      title: "Identifying speakers",
      desc: "Figuring out who is the interviewer vs. the candidate from the full transcript.",
      pct: 50,
    },
    analyzing: {
      title: "Analyzing interview",
      desc:
        "Using Opus 4.7 to extract questions, phases, commentary, and listening hints. Takes 1–3 minutes on longer recordings — Opus's semantic judgment is materially better than faster models, so we accept the slowdown.",
      pct: 85,
    },
    ready: { title: "", desc: "", pct: 100 },
    failed: {
      title: "Something went wrong",
      desc: error || "Try again in a moment.",
      pct: 0,
    },
  };
  const s = stageCopy[stage];

  const setStage = useStore((st) => st.setLiveProcessingStage);

  return (
    <div className="fixed inset-0 z-[200] bg-black/35 backdrop-blur-[2px] flex items-center justify-center">
      <div className="w-[440px] max-w-[92vw] bg-paper border border-rule-strong rounded-xl shadow-[0_20px_60px_rgba(15,15,15,0.22)] p-6 animate-appear">
        <h3 className="text-[16px] font-semibold text-ink mb-1">{s.title}</h3>
        <p className="text-[13px] text-ink-light leading-relaxed mb-4">
          {s.desc}
        </p>
        {stage === "failed" ? (
          <div className="flex justify-end">
            <button
              onClick={() => setStage("idle")}
              className="px-4 py-1.5 rounded-md text-sm font-medium border border-rule-strong bg-paper text-ink hover:bg-paper-hover"
            >
              Dismiss
            </button>
          </div>
        ) : (
          <>
            <div className="h-1.5 w-full bg-paper-hover rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all duration-700"
                style={{ width: `${s.pct}%` }}
              />
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-ink-lighter">
              <span className="inline-flex gap-[3px]">
                <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot" />
                <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.15s]" />
                <span className="w-[5px] h-[5px] rounded-full bg-accent animate-bounce-dot [animation-delay:.3s]" />
              </span>
              <span>Don&apos;t close this tab — the work resumes in place.</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
