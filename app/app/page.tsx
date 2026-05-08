"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { LiveView } from "@/components/LiveView";
import { LiveDebugPanel } from "@/components/LiveDebugPanel";
import { PastView } from "@/components/PastView";
import { StartModal } from "@/components/modals/StartModal";
import { ConfirmModal } from "@/components/modals/ConfirmModal";
import { PromptModal } from "@/components/modals/PromptModal";
import { EndSessionModal } from "@/components/modals/EndSessionModal";
import { ModalShell } from "@/components/modals/ModalShell";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { getOrchestrator } from "@/lib/orchestrator";
import { logClient } from "@/lib/client-log";
import { isAdminUser } from "@/lib/auth-client";

export default function Page() {
  const t = useTranslations();
  const router = useRouter();

  // Global store
  const user = useStore((s) => s.user);

  // Auth gate — guarded by hydration tracking so we don't bounce a
  // signed-in user to /sign-in just because Zustand's persist hasn't
  // restored from localStorage yet.
  //
  // Background: zustand/middleware/persist with createJSONStorage
  // hydrates asynchronously even when the storage backend (localStorage)
  // is synchronous — this is by design so the same store works with
  // async backends like IndexedDB. Without this guard, the very first
  // render after a page reload reads `user: null` (the initial state
  // before persist has run); the useEffect below sees no user and
  // calls router.replace("/sign-in") before persist finishes, even
  // though the user IS signed in. The result: refreshing /app while
  // signed in silently bounces you to /sign-in.
  //
  // Fix: track persist's hydration state. The auth-gate effect runs
  // ONLY after hydration completes. While hydrating, the component
  // renders null (a brief blank screen, typically <50ms).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    // Some persist installations finish synchronously (when localStorage
    // is fast and there's no rehydrate handler). Check first; subscribe
    // for the async case.
    if (useStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!user) router.replace("/sign-in");
  }, [hydrated, user, router]);

  // Phase 2: refresh the lightweight past-session list from the server
  // whenever a userId becomes available. Server is source of truth —
  // the Zustand persist layer no longer carries pastSessions across
  // reloads, so we MUST re-fetch here for the sidebar to populate.
  // Idempotent: re-running just refreshes.
  const hydratePastSessions = useStore((s) => s.hydratePastSessions);
  const setUserId = useStore((s) => s.setUserId);
  useEffect(() => {
    if (!hydrated) return;
    if (!user) return;
    // Defensive userId backfill. If the user signed in during a
    // window where /api/users/upsert was unavailable (e.g. an EB
    // instance restart, Aurora cold start), the local user record
    // has email/name but no userId — and every persistence call
    // silently short-circuits, leaving the past-sessions sidebar
    // empty even though the server has plenty of data. Re-fire
    // upsertUser on /app mount when userId is missing; once it
    // returns, the dep below catches the change and triggers
    // hydratePastSessions.
    if (!user.userId) {
      void (async () => {
        try {
          const { upsertUser } = await import("@/lib/client-api");
          const res = await upsertUser(user.email, user.name);
          if (res?.userId) setUserId(res.userId);
        } catch {
          /* will retry on the next /app mount */
        }
      })();
      return;
    }
    void hydratePastSessions();
  }, [hydrated, user, user?.userId, hydratePastSessions, setUserId]);

  // ============================================================
  // Resume incomplete uploads from the previous tab.
  //
  // When a user closes the tab while a video upload is in flight,
  // the in-memory blob URL dies but the IndexedDB cache persists
  // (see lib/upload-cache.ts). On the next /app mount we walk the
  // cached sessions and ask the server which ones still have a
  // NULL videoS3Key. Anything still missing gets a re-attempt of
  // uploadRecordingMultiSegment with `resumeFromCache: true`. On
  // success the cache is cleared automatically by the upload helper.
  //
  // Pruning: we also sweep entries older than 7 days every mount —
  // belt-and-suspenders cleanup so abandoned sessions don't bloat
  // IndexedDB indefinitely.
  // ============================================================
  useEffect(() => {
    if (!hydrated) return;
    if (!user?.userId) return;
    void (async () => {
      try {
        const cacheMod = await import("@/lib/upload-cache");
        // First: prune anything ancient. Failures here are silent —
        // worst case the cache stays larger than ideal.
        await cacheMod.pruneStale().catch(() => 0);

        const cachedIds = await cacheMod.listCachedSessionIds();
        if (cachedIds.length === 0) return;
        console.log(
          "[upload-resume] found cached sessions:",
          cachedIds
        );

        // For each cached session, ask the server: does it still need
        // the video? If videoS3Key is set already, the upload finished
        // server-side (we just didn't get to clear the cache before tab
        // close) — drop the cache and move on. If still NULL, retry.
        const {
          fetchPastSession,
          uploadRecordingMultiSegment,
          logUploadEvent,
        } = await import("@/lib/client-api");
        for (const sid of cachedIds) {
          try {
            const remote = await fetchPastSession(sid);
            if (!remote) {
              // Session was deleted server-side — drop cache.
              await cacheMod.clearSessionCache(sid);
              continue;
            }
            if (remote.videoS3Key) {
              // Already uploaded; just clear the local cache.
              await cacheMod.clearSessionCache(sid);
              continue;
            }
            // Still needs video — fire a resume attempt.
            logUploadEvent(sid, "upload", "resume-attempt", {});
            const cached = await cacheMod.getCachedSession(sid);
            const videoSegs = cached.filter((c) => c.kind === "video");
            if (videoSegs.length === 0) {
              await cacheMod.clearSessionCache(sid);
              continue;
            }
            // The mime is whatever was stored on the cache rows.
            const mime = videoSegs[0].mime || "video/mp4";
            const key = await uploadRecordingMultiSegment({
              sessionId: sid,
              segmentUrls: [], // ignored when resumeFromCache=true
              mime,
              resumeFromCache: true,
            });
            if (key) {
              // Mirror the post-end-of-session pattern: merge the
              // freshly-landed videoS3Key into the local store so any
              // open Past Session view picks it up without a manual
              // refresh.
              useStore.setState((state) => ({
                pastSessions: state.pastSessions.map((s) =>
                  s.id === sid ? { ...s, videoS3Key: key } : s
                ),
              }));
              console.log("[upload-resume] resumed session", sid, "→", key);
            } else {
              console.warn(
                "[upload-resume] retry returned null for",
                sid
              );
            }
          } catch (e) {
            console.warn("[upload-resume] per-session error", sid, e);
          }
        }
      } catch (e) {
        console.warn("[upload-resume] sweep failed:", e);
      }
    })();
    // Once-on-mount-after-userId. We don't put cachedIds in deps —
    // a successful resume removes them from cache, so this effect
    // running once is correct. Subsequent uploads in this tab take
    // the normal path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, user?.userId]);
  const selectedPastId = useStore((s) => s.selectedPastId);
  const startLive = useStore((s) => s.startLive);
  const liveStatus = useStore((s) => s.live.status);
  const liveQuestionsCount = useStore((s) => s.liveQuestions.length);
  const endLive = useStore((s) => s.endLive);
  const selectPast = useStore((s) => s.selectPast);
  const renamePast = useStore((s) => s.renamePastSession);
  const deletePast = useStore((s) => s.deletePastSession);
  const setPastSessionScore = useStore((s) => s.setPastSessionScore);
  const setLiveTitle = useStore((s) => s.setLiveTitle);
  const liveTitle = useStore((s) => s.liveTitle);
  const setElapsed = useStore((s) => s.setElapsed);
  const setLiveStatus = useStore((s) => s.setLiveStatus);
  const resetLive = useStore((s) => s.resetLive);

  // Modal state
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd] = useState(false);

  // Pending-session args. After the user clicks Start in the
  // StartModal, we stash the form args here instead of immediately
  // calling orchestrator.start(). A floating "ready bar" then
  // appears at the top of the page inviting the user to set their
  // browser zoom (Ctrl + / −) to taste — once they click Begin,
  // we run orchestrator.start() with these args and zoom locks.
  //
  // Why this two-step: zoom is locked the moment recording starts
  // (audioSession's keydown/wheel preventDefault listeners), so the
  // user must adjust view size BEFORE the share dialogs fire. The
  // StartModal closes too quickly to do that comfortably; this
  // intermediate step gives them a beat to set up.
  type PendingStartArgs = {
    jd: string;
    resume: string;
    captureSystemAudio: boolean;
    useMic: boolean;
    captureVideo: boolean;
    interviewerProfile?: string;
  };
  const [pendingStartArgs, setPendingStartArgs] =
    useState<PendingStartArgs | null>(null);
  // Fullscreen-coaching mode. Hides sidebar / topbar breadcrumb /
  // right-rail debug panel and scales text up so the coaching card is
  // readable from across a desk during the actual interview. ESC
  // exits. The Region Capture target (#ic-capture-region) is unchanged
  // — the screen recording still captures only the card whether
  // fullscreen is on or off.
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Fullscreen toggle DOES change the cropTarget's layout — the
  // height: 580 lock in LiveView is conditionally removed when
  // isFullscreen=true, AND the sidebar/PageTitle hide so the card
  // recenters horizontally. Region Capture's auto-tracking sees
  // this as a major bbox change and produces ~3s of garbled frames
  // unless we proactively pause the encoder around the transition.
  // The onToggleFullscreen handler below calls
  // orchestrator.triggerCropTransition("fullscreen") which fires
  // the same pause-encoder → 500ms wait → refresh cropTo →
  // 2-RAF settle → resume-encoder dance the zoom keyboard/wheel
  // listeners use. Recording shows a brief freeze frame during the
  // toggle but no garbled output.

  // Anytime the user navigates into a past session (via Sidebar
  // click, post-Save auto-jump, etc.), force-exit fullscreen. The
  // past view is a read-only review surface that needs the normal
  // sidebar + right rail; fullscreen was a live-coaching mode only.
  useEffect(() => {
    if (selectedPastId !== null && isFullscreen) {
      setIsFullscreen(false);
    }
  }, [selectedPastId, isFullscreen]);
  // Topbar visibility in fullscreen mode. Hidden by default so the
  // coaching panel uses the entire viewport; mouse near the top edge
  // (or hovering the topbar itself once visible) keeps it shown.
  // Reset to hidden whenever fullscreen toggles off so a non-fullscreen
  // session always shows the topbar normally.
  const [topbarVisible, setTopbarVisible] = useState(false);
  useEffect(() => {
    if (!isFullscreen) {
      setTopbarVisible(false);
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Lock the Escape exit-fullscreen path during active recording
      // for the same reason the in-card Fullscreen button is disabled
      // (see LiveView.tsx) — toggling fullscreen mid-recording causes
      // a cropTarget bbox change which contaminates the encoder's
      // reference frame chain and produces brief visual artifacts in
      // the saved recording. User must Pause or End first to leave
      // fullscreen mid-session.
      const status = useStore.getState().live.status;
      if (status === "recording" || status === "paused") return;
      setIsFullscreen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isFullscreen]);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  // Re-entry guard for the end-of-session flow. Prevents a second
  // handleEndConfirm (e.g. from the closing-detection prompt firing
  // mid-stop) from racing the first one and posting an empty session
  // row. Cleared on session restart via startLive.
  const endingRef = useRef(false);
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

  // Screen-share-ended state: AudioSession dispatches `ic:share-ended`
  // when the displayMedia track ends mid-session (Chrome's "Stop
  // sharing" button OR — more frustratingly — when the user moves the
  // browser window between displays, because Chrome invalidates tab
  // capture on display changes). Audio + transcript continue
  // normally; only the screen video is paused. The UI banner below
  // offers a one-click "Resume Sharing" that calls back into
  // orchestrator.resumeScreenShare() to re-acquire and continue.
  const [shareEnded, setShareEnded] = useState(false);
  const [shareResuming, setShareResuming] = useState(false);
  useEffect(() => {
    const handler = () => setShareEnded(true);
    window.addEventListener("ic:share-ended", handler);
    return () => window.removeEventListener("ic:share-ended", handler);
  }, []);
  const handleResumeShare = async () => {
    setShareResuming(true);
    try {
      const ok = await getOrchestrator().resumeScreenShare();
      if (ok) setShareEnded(false);
    } finally {
      setShareResuming(false);
    }
  };

  // Session-aborted: AudioSession dispatches this when a hard
  // precondition can't be satisfied during start() — no audio source
  // (mic off + tab audio missing), screen-share declined, or no
  // video track from the share. Used to be a throw out of
  // audio.start() that the page's catch block handled, but throws in
  // async client code trigger Next dev mode's error overlay. Now
  // it's a custom event we listen for + flip status to idle, also
  // wiping any stale audio/video blob URLs that a half-completed
  // start might have stashed on window so the next Start is clean.
  //
  // The reason string from AudioSession is captured into
  // `abortReason` and shown in a "couldn't start" modal below. Without
  // that modal, a decline silently dumps the user back to the idle
  // "Click Start" placeholder with no clue what just happened —
  // confusing if they expected a session to be running.
  const [abortReason, setAbortReason] = useState<string | null>(null);
  useEffect(() => {
    const onAbort = (e: Event) => {
      setLiveStatus("idle");
      // Force-exit fullscreen on abort. Otherwise the user gets
      // stuck: the fullscreen toggle lives on the LiveView coaching
      // card, which doesn't render during idle — so once the abort
      // modal is dismissed there's no visible affordance to leave
      // fullscreen, and the page looks frozen with chrome hidden.
      // Fullscreen is only meaningful while a session is actively
      // running; collapsing it on abort matches that semantic.
      setIsFullscreen(false);
      const detail = (e as CustomEvent).detail;
      setAbortReason(
        typeof detail === "string" && detail.length > 0
          ? detail
          : "The session couldn't start."
      );
      const win = window as unknown as {
        __ic_audioUrl?: string;
        __ic_videoUrl?: string;
        __ic_videoSegmentUrls?: string[];
        __ic_videoMime?: string;
      };
      win.__ic_audioUrl = undefined;
      win.__ic_videoUrl = undefined;
      win.__ic_videoSegmentUrls = undefined;
      win.__ic_videoMime = undefined;
    };
    window.addEventListener("ic:session-aborted", onAbort);
    return () => window.removeEventListener("ic:session-aborted", onAbort);
  }, [setLiveStatus]);

  // Refresh / tab-close guard. When a live session is active
  // (recording or paused), block accidental F5 / Ctrl-R / tab-close
  // with the browser's native "Leave site?" warning. Browsers don't
  // allow a custom modal during unload (and async save work can't
  // complete reliably during the unload event), so the standard
  // pattern is: native warning forces the user to make an explicit
  // choice. If they Cancel, they're back on the page intact and can
  // click End to save properly. If they Leave, in-memory chunks are
  // lost — we can't async-save during unload.
  // Also block tab-close while POST-SESSION uploads are in flight.
  // After clicking End, status flips to "idle" and the upload IIFE
  // runs in the background. Without this guard, closing the tab
  // right after End would silently kill the in-flight S3 PUTs and
  // the recording bytes (only ever in browser memory) get lost
  // forever — exactly the failure mode for sess-1777910320696
  // ("Business Strategy Analyst · Augury 13:40", S3 completely empty).
  const uploadsInFlight = useStore((s) => s.uploadsInFlight);
  const setSidebarDrawer = useStore((s) => s.setSidebarOpen);
  useEffect(() => {
    // No warning during "starting" either — that phase has no
    // recorded audio yet (waiting for share-dialog accept), so a
    // refresh loses nothing the user would care to keep.
    const isLiveActive =
      liveStatus !== "idle" &&
      liveStatus !== "starting" &&
      selectedPastId === null;
    const isUploading = uploadsInFlight > 0;
    if (!isLiveActive && !isUploading) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern Chrome/Edge ignore custom strings here and show their
      // own generic "Leave site?" message — that's fine, it still
      // blocks the unload until the user confirms. Older browsers
      // display this string verbatim.
      e.returnValue = isUploading
        ? "Recording is still uploading. Wait a few seconds before closing — leaving now will lose the recording."
        : "A live interview session is in progress. Click End first to save it — leaving now will lose what you've recorded.";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [liveStatus, selectedPastId, uploadsInFlight]);

  // Idle-prompt: orchestrator fires `ic:idle-prompt` after 2 min of
  // no Deepgram transcripts while recording. We pop the same modal
  // pattern as the closing-detected prompt — "Session quiet for a
  // while; save or continue?". If the user does nothing, the
  // orchestrator follows up with `ic:auto-save-requested` at the
  // 5-min mark, which triggers the same End & Save flow as a manual
  // click.
  const [showIdlePrompt, setShowIdlePrompt] = useState(false);
  useEffect(() => {
    const onIdle = () => setShowIdlePrompt(true);
    window.addEventListener("ic:idle-prompt", onIdle);
    return () => window.removeEventListener("ic:idle-prompt", onIdle);
  }, []);
  // Auto-save (5 min idle): orchestrator gives up waiting for user
  // input on the idle prompt and auto-fires End & Save. Same
  // handleEndConfirm flow used by the manual End button — saves the
  // session, scores it, and routes to the past view.
  useEffect(() => {
    const onAutoSave = () => {
      setShowIdlePrompt(false);
      setShowClosingPrompt(false);
      const titleForSave =
        useStore.getState().liveTitle ||
        t("Live Interview Session", "面试录制");
      void handleEndConfirm(titleForSave);
    };
    window.addEventListener("ic:auto-save-requested", onAutoSave);
    return () =>
      window.removeEventListener("ic:auto-save-requested", onAutoSave);
    // handleEndConfirm + t are referenced via closure; they're
    // defined in this component so the effect re-binds whenever they
    // change. Keeping dep list empty would risk stale handleEndConfirm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toast state — three severity levels:
  //   info  → instructional ("Next: pick THIS tab"), state recovery
  //           ("Deepgram reconnected"), auto-detection hints. Calm
  //           dark snackbar, brief display.
  //   warn  → declined optional share, soft degradation, transient
  //           reconnecting. Soft amber, slightly longer.
  //   error → genuinely broken (mic denied, Deepgram auth failed,
  //           reconnect exhausted). Solid red, longest display.
  // Old single-color red was "everything is on fire" — see screenshot
  // feedback. Levels carried via custom event detail.
  const [toast, setToast] = useState<{
    msg: string;
    level: "info" | "warn" | "error";
  } | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Backward-compat: some upstream paths may still dispatch a
      // bare string; default those to "warn" since pre-classification
      // they were rendered red anyway.
      const t =
        typeof detail === "string"
          ? { msg: detail, level: "warn" as const }
          : (detail as { msg: string; level: "info" | "warn" | "error" });
      setToast(t);
      // Per-level dwell time. Info messages are quick reads ("Next:
      // pick this tab") and the share dialog usually takes attention
      // anyway; warn messages benefit from a beat to be noticed; hard
      // errors stay long enough that the user has time to read +
      // decide what to do.
      const dwellMs =
        t.level === "error" ? 6000 : t.level === "warn" ? 4500 : 3000;
      setTimeout(() => setToast(null), dwellMs);
    };
    window.addEventListener("ic:error", handler);
    return () => window.removeEventListener("ic:error", handler);
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
    jd: string;
    resume: string;
    captureSystemAudio: boolean;
    useMic: boolean;
    captureVideo: boolean;
    interviewerProfile?: string;
  }) => {
    setShowStart(false);
    startLive(args.jd, args.resume, args.interviewerProfile);
    // Kick off title extraction in parallel with session start — the
    // heading defaults to "Live Interview Session" until it returns.
    //
    // The route returns `{ title, fallback?: true }`. `fallback: true`
    // means Anthropic was unreachable / rate-limited / returned empty —
    // we got the generic placeholder back, not a real generated title.
    // In that case we retry once after 2.5s; one transient blip
    // shouldn't permanently leave the user staring at "Live Interview
    // Session". After two failures we give up and keep the placeholder.
    void (async () => {
      const callTitleRoute = async () => {
        try {
          const r = await fetch("/api/session-title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jd: args.jd, resume: args.resume }),
          });
          if (!r.ok) return { ok: false } as const;
          const data = (await r.json()) as {
            title?: string;
            fallback?: boolean;
          };
          return { ok: true, title: data.title, fallback: !!data.fallback } as const;
        } catch {
          return { ok: false } as const;
        }
      };

      const first = await callTitleRoute();
      if (first.ok && first.title && !first.fallback) {
        setLiveTitle(first.title);
        return;
      }
      // Either fetch failed entirely (first.ok === false) or the route
      // signaled fallback. Wait + retry once.
      console.warn(
        "[session-title] first attempt did not produce a real title — retrying once",
        first
      );
      await new Promise((r) => setTimeout(r, 2500));
      const second = await callTitleRoute();
      if (second.ok && second.title && !second.fallback) {
        setLiveTitle(second.title);
      } else {
        console.warn(
          "[session-title] retry also failed — leaving heading as fallback",
          second
        );
      }
    })();

    // Pre-summarize the interviewer profile in parallel with session
    // setup. The user's pasted text is often a 1000-3000 word LinkedIn
    // copy; summarizing once upfront and reusing the ~50-word blurb on
    // every commentary call across a 30-question session saves a
    // material amount of input tokens. Fire-and-forget — if it returns
    // before the first commentary triggers (~30s+ in), commentary uses
    // the summary; otherwise it falls back to the raw paste.
    if (args.interviewerProfile && args.interviewerProfile.trim()) {
      void (async () => {
        try {
          const r = await fetch("/api/summarize-interviewer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interviewerProfile: args.interviewerProfile }),
          });
          if (!r.ok) return;
          const data = (await r.json()) as {
            summary?: string;
            fallback?: boolean;
          };
          if (data.fallback || !data.summary) return;
          useStore.getState().setLiveInterviewerProfileSummary(data.summary);
        } catch (e) {
          console.warn("[summarize-interviewer] client-side error:", e);
        }
      })();
    }

    // Stash the args + show the ready bar. Don't call
    // orchestrator.start() yet — we want the user to adjust browser
    // zoom first, since zoom locks the moment recording begins.
    // handleBeginRecording (triggered by the ready bar's "Begin"
    // button) does the actual orchestrator.start.
    setPendingStartArgs(args);
  };

  // Fired when the user clicks "Begin recording" on the ready bar
  // after they've adjusted zoom to taste. This is what actually kicks
  // off the orchestrator + share dialogs + zoom lock.
  const handleBeginRecording = async () => {
    if (!pendingStartArgs) return;
    const args = pendingStartArgs;
    setPendingStartArgs(null);
    try {
      // captureSystemAudio: true → always prompt for tab/window share
      // with audio. captureVideo: true → record the LiveView card via
      // the second share prompt. Both are forced-on by the StartModal.
      const captureTabAudio: "auto" | "on" | "off" = args.captureSystemAudio
        ? "on"
        : "off";
      // captureVideo is meaningless without tab share — gate on it.
      const captureVideo = captureTabAudio !== "off" && args.captureVideo;
      // useMic must default to true when tab audio is off (otherwise
      // there's no audio source at all). Honor explicit false only
      // when tab audio is on.
      const useMic =
        args.useMic === false && captureTabAudio !== "off" ? false : true;
      const started = await getOrchestrator().start({
        captureTabAudio,
        captureVideo,
        useMic,
      });
      // start() returns false when the AudioSession aborted partway
      // (no audio source, declined screen share, etc.) — abortSession
      // dispatches `ic:session-aborted` synchronously, which the
      // page-level handler above (line ~216) already used to flip
      // live.status back to "idle". If we'd unconditionally set
      // "recording" here we'd overwrite that and leave the user with
      // an active-looking topbar (timer ticking, Pause/End buttons)
      // over a session that never started — the bug the user hit
      // when they Closed the "couldn't start" modal.
      if (started) {
        setLiveStatus("recording");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to start";
      // Hard failure — session never got started (mic / network / etc.).
      // Log to the browser console too so the developer can see the full
      // error + stack; the toast only shows .message which often hides
      // the root cause for downstream failures (e.g. region capture,
      // Deepgram auth, getUserMedia constraint mismatches).
      // Use console.warn instead of console.error so Next.js's dev
      // mode doesn't surface a runtime "Issue" badge for an
      // already-handled failure path (we show the error to the user
      // via the toast/setLiveStatus reset below).
      console.warn("[handleBeginRecording] orchestrator.start threw:", e);
      setToast({ level: "error", msg });
      setLiveStatus("idle");
    }
  };

  // Cancel from the ready bar — wipe any partial session data we
  // stashed via startLive() in handleStartConfirm so the next click
  // of New Session opens a fresh modal. Also exit fullscreen for
  // the same reason as the abort handler: there's no session to
  // coach in fullscreen mode anymore, and the toggle button isn't
  // visible from idle, so leaving fullscreen on would trap the user.
  const handleCancelReady = () => {
    setPendingStartArgs(null);
    setIsFullscreen(false);
    resetLive();
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
    if (endingRef.current) return;
    endingRef.current = true;
    setShowEnd(false);
    // Suppress any prompts that might fire during the stop window —
    // closing-detection's hysteresis-auto-confirm timer can pop a
    // "Looks like the interview just wrapped up" prompt mid-stop and
    // confuse the user (or worse, route them through a second
    // handleEndConfirm that races this one).
    setShowClosingPrompt(false);
    setShowIdlePrompt(false);
    getOrchestrator().disableClosingDetection();
    // Always exit fullscreen on End — the post-session view (whether
    // Past view after Save or empty Live after Discard) is a different
    // mode that wants the normal sidebar + right-rail layout.
    setIsFullscreen(false);
    // Stop the orchestrator. This calls AudioSession.stop() which
    // builds the audio/video blobs and stashes them on window.__ic_*Url
    // — but we deliberately do NOT read those URLs into a Session,
    // so the blob objects become garbage-collectable as soon as we
    // null out the window references below.
    await getOrchestrator().stop();
    const win = window as unknown as {
      __ic_audioUrl?: string;
      __ic_videoUrl?: string;
      __ic_videoSegmentUrls?: string[];
      __ic_videoMime?: string;
    };
    win.__ic_audioUrl = undefined;
    win.__ic_videoUrl = undefined;
    win.__ic_videoSegmentUrls = undefined;
    win.__ic_videoMime = undefined;
    // Wipe in-memory live state (questions, utterances, timeline,
    // moment-state machine, etc.). This is the same cleanup that
    // resetLive does internally; calling it here means the LiveView
    // re-renders empty, ready for a fresh Start.
    resetLive();
    endingRef.current = false;
  };

  const handleEndConfirm = async (title: string) => {
    // Re-entry guard. Without this, a second handleEndConfirm
    // (closing-detection prompt firing mid-stop, double-clicked
    // End button, idle auto-save racing manual End, etc.) lands a
    // SECOND endLive call after the first one has reset the store
    // — the second POST sends empty fields and wipes the saved
    // session row to "title=Live Interview Session, duration=0,
    // questions=[]".
    if (endingRef.current) return;
    endingRef.current = true;

    // Last-ditch title generation. If the user clicked Save while
    // /api/session-title was still in-flight (or had failed both
    // earlier attempts), `title` will be the fallback "Untitled
    // session" / "未命名面试". Try ONE more synchronous call here
    // — the JD is already on the live store, the call is fast
    // (~1-2s with Haiku), and the user is already waiting for the
    // post-session save anyway. Better than the user being left
    // with "Untitled session" in their sidebar forever.
    const isFallbackTitle =
      title === t("Untitled session", "未命名面试") ||
      title === "Live Interview Session" ||
      title.trim() === "";
    if (isFallbackTitle) {
      const jd = useStore.getState().liveJd;
      const resume = useStore.getState().liveResume;
      if (jd) {
        try {
          const r = await Promise.race([
            fetch("/api/session-title", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jd, resume }),
            }),
            new Promise<Response>((_, rej) =>
              setTimeout(() => rej(new Error("title timeout")), 5000)
            ),
          ]);
          if (r.ok) {
            const data = (await r.json()) as {
              title?: string;
              fallback?: boolean;
            };
            if (data.title && !data.fallback) {
              title = data.title;
            }
          }
        } catch (e) {
          console.warn("[handleEndConfirm] last-ditch title failed", e);
        }
      }
    }

    setShowEnd(false);
    // Suppress concurrent prompts that would route to handleEndConfirm
    // again (closing prompt + idle prompt). disableClosingDetection
    // also cancels the in-flight closing-silence timer so it can't
    // dispatch another ic:closing-detected during the await below.
    setShowClosingPrompt(false);
    setShowIdlePrompt(false);
    getOrchestrator().disableClosingDetection();

    // CRITICAL: capture every store field endLive needs BEFORE the
    // await. orchestrator.stop() now includes fix-webm-duration which
    // can take 2-5 seconds on a long recording — during that window,
    // ANY path that resets the store (auto-save firing, the user
    // accidentally clicking Start in the topbar, etc.) would clear
    // questions / elapsedSeconds / speakerRoles, and endLive would
    // POST an empty row.
    const snapshot = useStore.getState().snapshotForEnd();

    // Always exit fullscreen on Save — see handleEndDiscard for
    // rationale. PastView renders the score / transcript and wants
    // the normal layout with sidebar.
    setIsFullscreen(false);
    await getOrchestrator().stop();
    // Pick up the recorded audio URL that the orchestrator stashed.
    // Same dance for the optional video URL — only present when the
    // user enabled "Also record screen video" AND the share was
    // accepted with a video track.
    const win = window as unknown as {
      __ic_audioUrl?: string;
      __ic_videoUrl?: string;
      __ic_videoSegmentUrls?: string[];
      __ic_videoMime?: string;
    };
    const audioUrl = win.__ic_audioUrl;
    const videoUrl = win.__ic_videoUrl;
    const videoSegmentUrls = win.__ic_videoSegmentUrls;
    const videoMime = win.__ic_videoMime;
    const saved = endLive(title, audioUrl, videoUrl, snapshot, {
      videoSegmentUrls,
      videoMime,
    });
    win.__ic_audioUrl = undefined;
    win.__ic_videoUrl = undefined;
    win.__ic_videoSegmentUrls = undefined;
    win.__ic_videoMime = undefined;
    selectPast(saved.id);

    // Fire-and-forget overall scoring. PastView renders a spinner until
    // `saved.score` populates. No retry — on failure the view shows a
    // "scoring unavailable" state and the user can regenerate later.
    void scoreSessionAsync(saved);

    // Independent post-session enrichment calls — both populate the
    // Past view but neither blocks scoring or each other. Failures
    // are silent: the Context block / expanded Try blocks just don't
    // render. User can re-run the whole flow later if needed.
    void summarizeContextAsync(saved);
    void expandSuggestionsAsync(saved);

    // Drop the re-entry guard. A future End in a NEW session needs
    // a fresh handleEndConfirm to be able to run.
    endingRef.current = false;
  };

  const setPastSessionScoreError = useStore((s) => s.setPastSessionScoreError);
  const setPastSessionContext = useStore((s) => s.setPastSessionContext);
  const setPastSessionExpandedSuggestions = useStore(
    (s) => s.setPastSessionExpandedSuggestions
  );

  // POST-SESSION HELPER #1 — JD/resume summary for the Context block.
  // Lightweight Haiku call (~2s). Ignores fallback flag, just stores
  // whatever real summary came back. No retry beyond what the route
  // already does internally.
  const summarizeContextAsync = async (saved: ReturnType<typeof endLive>) => {
    try {
      // If the session-start /api/summarize-interviewer call already
      // produced a summary, skip re-summarizing the interviewer here —
      // pass empty interviewerProfile so the route returns early on
      // that field. Saves a duplicate Haiku call on the same input.
      const interviewerForCall = saved.interviewerProfileSummary
        ? ""
        : saved.interviewerProfile;
      const r = await fetch("/api/summarize-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd: saved.jd,
          resume: saved.resume,
          interviewerProfile: interviewerForCall,
        }),
      });
      if (!r.ok) return;
      const data = (await r.json()) as {
        jdSummary?: string;
        resumeSummary?: string;
        interviewerSummary?: string;
        fallback?: boolean;
      };
      if (data.fallback || !data.jdSummary) return;
      setPastSessionContext(saved.id, {
        jdSummary: data.jdSummary,
        resumeSummary: data.resumeSummary,
        // Preserve the live-time summary (already on the Session)
        // when the post-session route didn't generate a fresh one
        // (we deliberately skipped it above when a summary existed).
        interviewerProfileSummary:
          data.interviewerSummary || saved.interviewerProfileSummary,
      });
    } catch (e) {
      console.warn("[summarize-context] client-side error:", e);
    }
  };

  // POST-SESSION HELPER #2 — Expand brief "Try:" blocks into full
  // deliverable answers. Single Sonnet call for the whole session
  // (~30-50s). Stored per-comment via setPastSessionExpandedSuggestions.
  // Failure leaves the existing brief Try block as-is in PastView.
  const expandSuggestionsAsync = async (saved: ReturnType<typeof endLive>) => {
    try {
      const r = await fetch("/api/expand-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // sessionId lets the server emit session_events breadcrumbs
          // (begin / item-failed / complete) so a future "stuck"
          // complaint shows up in the events log alongside the live
          // session timeline.
          sessionId: saved.id,
          jd: saved.jd,
          resume: saved.resume,
          questions: saved.questions.map((q) => ({
            id: q.id,
            text: q.text,
            answerText: q.answerText,
            comments: q.comments.map((c) => ({ id: c.id, text: c.text })),
          })),
        }),
      });
      if (!r.ok) return;
      const data = (await r.json()) as {
        expansions?: Array<{ commentId: string; text: string }>;
      };
      const map: Record<string, string> = {};
      for (const e of data.expansions || []) {
        if (e.commentId && e.text) map[e.commentId] = e.text;
      }
      if (Object.keys(map).length > 0) {
        setPastSessionExpandedSuggestions(saved.id, map);
      }
    } catch (e) {
      console.warn("[expand-suggestions] client-side error:", e);
    }
  };

  const scoreSessionAsync = async (saved: ReturnType<typeof endLive>) => {
    // Pre-flight guard: skip scoring entirely when there's nothing
    // for the model to evaluate. Empty sessions (auto-saved before
    // any question locked, or accidentally Started+Ended) have no
    // JD or no questions and would just bounce off the API with
    // "Missing JD or questions" (HTTP 400). That bounce previously
    // surfaced as a Next.js dev "Issue" pill via the catch's
    // console.error — and as a permanent scoreError on the Session.
    // Skipping cleanly avoids both.
    if (!saved.jd || saved.questions.length === 0) {
      setPastSessionScoreError(
        saved.id,
        saved.questions.length === 0
          ? "No questions captured — nothing to score."
          : "Missing job description — re-record with a JD pasted in StartModal."
      );
      return;
    }
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
            // sessionId enables session_events breadcrumbs on the
            // server (begin / override-misjudged-insufficient /
            // complete / fatal-error). Future "re-score keeps
            // failing" complaints can be diagnosed from the events
            // log alongside the live timeline.
            sessionId: saved.id,
            jd: saved.jd,
            resume: saved.resume,
            questions: saved.questions,
            durationSeconds: saved.durationSeconds,
            // Mirror the user's commentary language preference: if
            // they ran the live session in English, the post-session
            // score should match. Reading from the store at fire
            // time (not at component mount) so a mid-session toggle
            // still applies to the score that comes after.
            lang: useStore.getState().commentLang,
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
      // console.warn (not error) to avoid triggering Next.js's dev
      // "Issue" badge — the failure is handled gracefully via
      // setPastSessionScoreError below, which renders a friendly
      // ScoreCard with a Re-score button. The user sees the failure
      // there; no need to also flag it as a runtime error in dev.
      console.warn("[scoring] failed:", msg);
      // Mark the session's score as permanently failed (until retried).
      // PastView's ScoreCard renders a friendly muted-warning UI when
      // scoreError is set (with a Re-score button), so we DON'T also
      // fire a red toast for the same failure — that was triple-banner
      // noise (rose ScoreCard + small rose box + bottom red toast).
      // The ScoreCard alone is sufficient and on-context.
      setPastSessionScoreError(saved.id, msg);
    }
  };

  // Render nothing until persist has hydrated AND we have a user.
  // - During hydration (first ~50ms after a page reload): null,
  //   avoiding both a flash of "signed-out" content and a wrong
  //   redirect to /sign-in.
  // - After hydration with no user: still null, while the redirect
  //   to /sign-in is in flight.
  if (!hydrated || !user) return null;

  // Right-rail panel logic. Two mutually-exclusive panels share the
  // 360px right column on the Live tab:
  //   - Upload-mode ReviewPanel: full coaching timeline, clickable to
  //     seek the recording.
  //   - Live-mode LiveDebugPanel: real-time event log + user comment
  //     pinning, so the user can flag issues at specific timestamps
  //     and ship me a debrief.
  // When a past session is selected (selectedPastId !== null) no right
  // rail shows — that view is read-only.
  // Right-rail debug panel is LIVE-ONLY. The past view stays clean
  // (no right rail) — utterances/events are still persisted in DB
  // for diagnosis via /api/sessions/:id/{utterances,events}, but the
  // panel itself only makes sense alongside a running session.
  // Hidden in fullscreen so the coaching card owns the viewport.
  //
  // ADMIN-ONLY: this panel was originally an internal debug tool —
  // event log, user comment pinning for debriefs, raw transcript
  // dump. Real users don't need it (and find it confusing). We gate
  // on isAdminUser so the main coaching card gets the full width on
  // every non-admin signed-in account, while the admin still has the
  // diagnostic surface they're used to.
  const hasDebugPanel =
    isAdminUser(user) && selectedPastId === null && !isFullscreen;
  // Sidebar is hidden in fullscreen for the same reason.
  const showSidebar = !isFullscreen;

  return (
    <div
      // data-app-shell flag tells globals.css this is the protected
      // coaching app — clamp html/body to 100vh + overflow:hidden so
      // panes scroll internally rather than the document. Marketing /
      // legal routes don't carry this flag and scroll naturally.
      data-app-shell="true"
      // Mobile (<sm = 640px): single-column grid. Sidebar is rendered
      // outside the grid as a fixed-position drawer (see Sidebar
      // component) so the main content fills the viewport. Desktop:
      // existing 240px sidebar + main + optional 360px debug panel.
      className={`grid h-screen pv-print-flow grid-cols-1 ${
        isFullscreen
          ? "sm:grid-cols-1"
          : hasDebugPanel
          ? "sm:grid-cols-[240px_1fr_360px]"
          : "sm:grid-cols-[240px_1fr]"
      }`}
    >
      {/* Sidebar: always rendered (so the drawer-open state has a
          target to slide in). The component itself decides whether
          to be in-grid (desktop) or fixed off-canvas (mobile drawer)
          via internal responsive classes. The print:hidden wrapper
          stays so the sidebar doesn't bleed into PDF exports. */}
      {showSidebar && (
        <div className="contents print:hidden">
          <Sidebar
            onRenameRequest={(id, title) => setRenameTarget({ id, title })}
            onDeleteRequest={(id, title) => setDeleteTarget({ id, title })}
          />
        </div>
      )}

      {/* Upload-in-flight banner. Shows whenever uploadsInFlight > 0,
          which spans from "user clicked End" to "all S3 PUTs + concat
          completed". Mirrors the beforeunload guard's intent — gives
          the user a VISIBLE signal that closing the tab now will
          abort the upload, not just a hidden browser confirm dialog.
          Fixed at the top of the viewport, full width, dismissed
          automatically when the counter drops back to 0. The
          IndexedDB cache + resume-on-mount flow is the safety net if
          they close anyway, but the banner keeps the ideal happy
          path (don't close) salient. */}
      {uploadsInFlight > 0 && (
        <div
          className="fixed top-0 left-0 right-0 z-[90] print:hidden flex items-center justify-center gap-2 py-2 text-[13px] font-medium"
          style={{
            background: "var(--color-warning, #b87a1f)",
            color: "white",
            boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
          }}
          role="status"
          aria-live="polite"
        >
          <span className="inline-flex gap-[3px]">
            <span className="w-[4px] h-[4px] rounded-full bg-white animate-bounce-dot" />
            <span className="w-[4px] h-[4px] rounded-full bg-white animate-bounce-dot [animation-delay:.15s]" />
            <span className="w-[4px] h-[4px] rounded-full bg-white animate-bounce-dot [animation-delay:.3s]" />
          </span>
          <span>
            Uploading recording — please don&apos;t close this tab. The
            file is auto-saved if you do, and resume will retry next
            time you open the app.
          </span>
        </div>
      )}

      <UnsupportedBrowserBanner />

      <main className="flex flex-col overflow-hidden print:overflow-visible print:h-auto relative">
        {/* Topbar visibility — hidden in the pre-session idle state
            (no past session selected, status idle, no questions yet)
            because the LiveView empty state already presents its own
            primary "Start a new session" CTA + brand mark. Showing
            the topbar with its tiny Start/Pause/End controls in that
            state is redundant noise; hiding it lets the empty page
            breathe.
            Once a session has been started or a past session is
            selected, the topbar comes back with full chrome. */}
        {(() => {
          const isPreSessionIdle =
            selectedPastId === null &&
            liveStatus === "idle" &&
            liveQuestionsCount === 0;
          // Mobile users still need access to the hamburger even in
          // pre-session idle state — without the topbar, the drawer
          // can't be opened from the empty-state view. Render a
          // SLIM mobile-only topbar (just the hamburger + brand
          // crumb) when idle. Desktop keeps the existing
          // hide-when-idle behavior since the LiveView empty state
          // already presents its own primary CTA there.
          if (isPreSessionIdle) {
            return (
              <div className="sm:hidden h-11 border-b border-border flex items-center px-3 gap-2.5 shrink-0 print:hidden">
                <button
                  type="button"
                  onClick={() => setSidebarDrawer(true)}
                  aria-label="Open sidebar"
                  className="-ml-1 w-8 h-8 grid place-items-center rounded-md text-text-muted hover:bg-surface hover:text-text transition-colors"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 18 18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <line x1="3" y1="5" x2="15" y2="5" />
                    <line x1="3" y1="9" x2="15" y2="9" />
                    <line x1="3" y1="13" x2="15" y2="13" />
                  </svg>
                </button>
                <b className="text-text font-medium text-[13px]">puebulo</b>
              </div>
            );
          }
          return (
            <>
              {/* Topbar in fullscreen: position absolute over the card
                  and auto-hide. Translates off-screen by default;
                  mouse near the top edge translates it back into
                  view. */}
              {isFullscreen && (
                <div
                  className="absolute top-0 left-0 right-0 h-3 z-20 print:hidden"
                  onMouseEnter={() => setTopbarVisible(true)}
                />
              )}
              <div
                className={
                  isFullscreen
                    ? `absolute top-0 left-0 right-0 z-30 print:hidden bg-paper transition-transform duration-200 ${
                        topbarVisible ? "translate-y-0" : "-translate-y-full"
                      }`
                    : "print:hidden"
                }
                onMouseEnter={
                  isFullscreen ? () => setTopbarVisible(true) : undefined
                }
                onMouseLeave={
                  isFullscreen ? () => setTopbarVisible(false) : undefined
                }
              >
                <Topbar
                  onStart={handleStart}
                  onPause={handlePauseRequest}
                  onEnd={handleEndRequest}
                />
              </div>
            </>
          );
        })()}
        {selectedPastId === null ? (
          <LiveView
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => {
              // Tell the recorder a layout transition is incoming
              // BEFORE flipping React state. handleCropTransition
              // pauses the videoRecorder immediately, so any
              // garbled frames Chrome's Region Capture emits during
              // the cropTarget bbox change (height: 580 lock is
              // removed in fullscreen, sidebar/PageTitle hide,
              // card recenters) never reach the encoder. After
              // ~500ms + 2 RAFs of layout settling the recorder
              // resumes cleanly. Without this, fullscreen toggles
              // produced ~3s of 花屏 in the saved recording.
              const liveStatus = useStore.getState().live.status;
              if (liveStatus === "recording" || liveStatus === "paused") {
                getOrchestrator().triggerCropTransition("fullscreen");
              }
              setIsFullscreen((v) => !v);
            }}
            onStartRequest={handleStart}
          />
        ) : (
          <PastView />
        )}
      </main>

      {/* Live-mode right rail: real-time debug log + user comment
          pinning. Past view stays without a right rail — saved
          utterances/events are still in DB and can be wired into a
          different surface later. Hidden in fullscreen mode. */}
      {hasDebugPanel && <LiveDebugPanel />}

      {/* Ready-to-record floating bar. Shown after the user clicks
          Start in StartModal but before they click Begin. Gives them
          a beat to adjust browser zoom (Ctrl + / −) to their preferred
          view size — recording locks zoom the moment it begins, so
          this is the only window to set it. Sticky-top, centered,
          non-blocking (page is interactive behind it so user can see
          how the layout looks at different zoom levels). */}
      {pendingStartArgs && (
        <div
          // top-14 (56px) clears the 44px Topbar with 12px breathing
          // room — the bar sits below the chrome rather than over it.
          // Centered on the viewport (not the main column) so it's
          // visually anchored to the page even when the sidebar is
          // hidden in fullscreen mode.
          className="fixed top-14 left-1/2 -translate-x-1/2 z-40 max-w-[640px] w-[min(640px,calc(100vw-32px))] px-5 py-3 border border-border-strong bg-bg flex items-center gap-3"
          style={{
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
          }}
          role="dialog"
          aria-label={t(
            "Set view size before recording",
            "调整视图大小后开始录制"
          )}
        >
          <div className="flex-1 text-[13px] leading-snug">
            <div className="font-semibold text-text mb-0.5">
              {t(
                "Set your view size, then begin",
                "调整视图大小后开始"
              )}
            </div>
            <div className="text-text-muted text-[12px]">
              {t(
                "You can enter full screen mode and use Ctrl + / − to zoom the page now. Page zoom locks once interview starts.",
                "你可以进入全屏模式并用 Ctrl + / − 调整页面缩放。面试开始后,页面缩放会被锁定。"
              )}
            </div>
            {/* Recording-quality reminder. Two specific gotchas users
                hit that produce visual artifacts in the saved video:
                  1. Moving the Chrome window between displays —
                     Chrome can invalidate the tab capture; even when
                     it doesn't, a DPI change can cause garbled
                     frames as Region Capture re-anchors.
                  2. Resizing the Chrome window during recording —
                     same bbox-tracking issue.
                Yellow-tinted to distinguish from the gray
                informational text above. */}
            <div
              className="mt-1.5 text-[12px] flex items-start gap-1.5"
              style={{ color: "var(--color-warning)" }}
            >
              <span className="leading-none mt-0.5">⚠</span>
              <span>
                {t(
                  "During recording, keep Chrome on the same display and don't resize the window — moving or resizing can cause video artifacts.",
                  "录制期间请保持 Chrome 在同一显示器上,不要拖动或调整窗口大小 —— 否则会导致视频出现异常。"
                )}
              </span>
            </div>
          </div>
          <button
            onClick={handleCancelReady}
            className="btn btn-secondary btn-sm whitespace-nowrap"
          >
            {t("Cancel", "取消")}
          </button>
          <button
            onClick={handleBeginRecording}
            className="btn btn-primary btn-sm whitespace-nowrap"
          >
            {t("Begin →", "开始 →")}
          </button>
        </div>
      )}

      {/* Modals */}
      <StartModal
        open={showStart}
        onCancel={() => setShowStart(false)}
        onStart={handleStartConfirm}
      />

      {/* Couldn't-start modal. Surfaced when AudioSession's
          start() aborts on a hard precondition (no audio source,
          screen-share declined, no video track from the share).
          Without this, decline → silent return-to-idle, leaving
          the user staring at "Click Start to begin" wondering
          whether they did something wrong. The modal explains
          exactly what failed (reason from AudioSession) and lets
          them re-Start in one click — which re-opens StartModal
          with their previously typed JD/resume gone (StartModal
          resets on open by design; user re-pastes). */}
      <ConfirmModal
        open={abortReason !== null}
        title={t(
          "Couldn't start the session",
          "无法启动会话"
        )}
        description={
          <>
            <p>{abortReason}</p>
            <p className="mt-2 text-ink-lighter text-[12.5px]">
              {t(
                "Tip: when you click Start again, accept the screen-share prompt and check \"Share tab audio\" if the Microphone is off.",
                "提示：再次点击 Start 后，请接受屏幕共享提示；如果麦克风未开启，请在分享面板中勾选「Share tab audio」。"
              )}
            </p>
          </>
        }
        confirmLabel={t("Try again", "重新开始")}
        cancelLabel={t("Close", "关闭")}
        onCancel={() => setAbortReason(null)}
        onConfirm={() => {
          setAbortReason(null);
          setShowStart(true);
        }}
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

      {/* Idle prompt — fired by the orchestrator after 2 min of
          Deepgram silence while recording. Same UX pattern as the
          closing prompt:
            - Continue recording: notifies orchestrator that user is
              still active, resets the idle baseline so the prompt
              doesn't immediately re-fire and so auto-save doesn't
              trip in 3 more minutes.
            - Save now: same one-click End & Save as the closing
              prompt's confirm.
          If the user dismisses neither, the orchestrator auto-fires
          `ic:auto-save-requested` at the 5-min mark — handled below
          by the same handleEndConfirm path. */}
      <ConfirmModal
        open={showIdlePrompt}
        title={t("Session quiet — is it over?", "会话已安静一段时间 — 是否已结束?")}
        description={t(
          "No new speech detected for 2 minutes. Save the session now, or click Continue if it's still ongoing. (We'll auto-save in 3 more minutes if you don't respond.)",
          "已 2 分钟没有新语音输入。要现在保存这场会话吗?如果还在进行中,点击「继续录制」。(若你不操作,3 分钟后会自动保存。)"
        )}
        confirmLabel={t("Save now", "现在保存")}
        cancelLabel={t("Continue recording", "继续录制")}
        onCancel={() => {
          setShowIdlePrompt(false);
          getOrchestrator().notifyUserStillActive();
        }}
        onConfirm={() => {
          setShowIdlePrompt(false);
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

      {/* Resume-Sharing banner. Surfaces top-center when AudioSession
          dispatches `ic:share-ended` mid-recording. Most common
          trigger: user moved the Chrome window between displays
          (Chrome invalidates the tab-capture share on display changes).
          Audio + transcript continue normally; this banner restarts
          the screen-recording video on a fresh share via a one-click
          getDisplayMedia. The button satisfies the user-gesture
          requirement that browsers impose on getDisplayMedia. */}
      {shareEnded && (
        <div className="fixed left-1/2 top-3 -translate-x-1/2 z-[80] print:hidden">
          <div
            className="flex items-center gap-3 px-4 py-2.5 rounded-md border border-border-strong bg-bg shadow-lg text-[13px]"
            style={{ boxShadow: "var(--shadow-lg)" }}
          >
            <span className="text-text-muted">
              {t(
                "Screen recording paused. Likely from moving Chrome between displays.",
                "屏幕录制暂停。可能是因为把 Chrome 移到了另一块显示器。"
              )}
            </span>
            <button
              type="button"
              onClick={handleResumeShare}
              disabled={shareResuming}
              className="btn btn-primary btn-sm shrink-0"
            >
              {shareResuming
                ? t("Resuming…", "恢复中…")
                : t("Resume Sharing", "重新开始共享")}
            </button>
          </div>
        </div>
      )}

      {/* Toast notifications were removed per product decision — info /
          warn / error severities all surfaced as floating bars that
          competed with the coaching content during live sessions and
          felt noisy. The state + listeners are kept (setToast is
          still called by the orchestrator's onError event flow) but
          the UI is silent. Errors still reach the browser console
          for debugging; critical-flow choices (closing detected,
          idle prompt, speaker identity) live in modals which remain
          intact. If we want to bring toasts back later, just
          re-render `{toast && (...)}` here. */}

    </div>
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
/**
 * UnsupportedBrowserBanner — passive top-of-page warning surfaced
 * to users on Firefox / Safari / iPad / phone / etc. Past Session
 * review still works in any browser, but the live recording flow
 * (which depends on getDisplayMedia tab-audio capture, Chromium-
 * desktop-only) silently fails for unsupported browsers — this
 * banner gives them a heads-up before they invest time recording
 * a doomed session.
 *
 * Detection runs client-side after mount (SSR returns "supported"
 * to avoid hydration flicker). Dismissable; the dismiss is
 * remembered for the lifetime of this tab via sessionStorage so a
 * fresh tab re-prompts (the user might have switched browsers).
 */
function UnsupportedBrowserBanner() {
  const [unsupported, setUnsupported] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { detectBrowserSupport } = await import("@/lib/browser-support");
      if (cancelled) return;
      setUnsupported(detectBrowserSupport() === "unsupported");
    })();
    try {
      if (sessionStorage.getItem("ic-unsupported-banner-dismissed") === "1") {
        setDismissed(true);
      }
    } catch {
      /* private mode / SSR — leave dismissed=false */
    }
    return () => {
      cancelled = true;
    };
  }, []);

  if (!unsupported || dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem("ic-unsupported-banner-dismissed", "1");
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="print:hidden flex items-center justify-between gap-3 px-4 py-2 text-[13px]"
      style={{
        background: "rgba(184, 122, 31, 0.12)",
        color: "var(--color-warning, #8a5a1a)",
        borderBottom: "1px solid rgba(184, 122, 31, 0.3)",
      }}
    >
      <div className="flex items-center gap-2 min-w-0">
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0"
        >
          <path d="M8 1.5l7 12.5H1z" />
          <line x1="8" y1="6" x2="8" y2="10" />
          <line x1="8" y1="12" x2="8" y2="12.5" />
        </svg>
        <span className="leading-snug">
          <strong>Live recording requires desktop Chrome.</strong>{" "}
          Phones, tablets (including iPad), and Safari/Firefox can
          review past sessions but can&apos;t record new interviews.
          Open this app in Chrome (or Edge/Brave) on a Mac, Windows,
          or Linux computer to use the live coach.
        </span>
      </div>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="shrink-0 -mr-1 w-7 h-7 grid place-items-center rounded-md hover:bg-black/5 transition-colors"
        style={{ color: "inherit" }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="3" y1="3" x2="11" y2="11" />
          <line x1="11" y1="3" x2="3" y2="11" />
        </svg>
      </button>
    </div>
  );
}

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
    // Immediately back-fill any other already-known dgs with the
    // opposite role. Without this, a second speaker who spoke ONCE
    // before the prompt resolved (and didn't speak again for a while)
    // would stay unassigned — captions for that role would be empty
    // until they happen to speak again. See orchestrator method doc
    // for the full race condition.
    getOrchestrator().notifySpeakerPromptResolved();
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
