/**
 * MockInterviewer — the AI-interviewer controller for the Retake flow.
 *
 * Owns an AudioSession (mic STT + camera video + TTS-mixed recording)
 * and runs the interview state machine:
 *
 *   idle → greeting → asking → listening → deciding → asking(…) →
 *   wrapup → ended
 *
 * Deliberately does NOT use LiveOrchestrator: there is no question to
 * detect (the AI asks them), no moment classification, no speaker
 * identification (roles are known by timing — anything finalized
 * while TTS is playing is the interviewer; the mic is gain-zeroed in
 * those windows anyway).
 *
 * Coaching is SILENT: one /api/commentary call per completed turn,
 * accumulated into a Comment on the question. Nothing renders during
 * the call; PastView shows everything after End & Save.
 *
 * Events dispatched on window:
 *   ic:error           — toast channel (page already listens)
 *   ic:retake-complete — wrapup script finished; page prompts save
 *   ic:retake-idle     — 3min total silence; page prompts save
 *   ic:session-aborted — start failed (mic denied etc.)
 */

import { AudioSession } from "./audioSession";
import { useStore } from "./store";
import {
  providerForLanguage,
  fetchAuraBuffer,
  playAuraBuffer,
  type TtsHandle,
  type TtsProvider,
} from "./ttsClient";
import type { RetakePlan } from "@/app/api/retake/plan/route";
import type { Comment, Question, Utterance } from "@/types/session";

// ===== tuning =====
/** Answer counts as complete after this much silence (no interim or
 *  final transcripts) once the minimum length is met. Kept tight —
 *  a real interviewer jumps in quickly; the instant verbal ack (see
 *  ACK pool) covers the model-decision latency after this fires. */
const ANSWER_SILENCE_MS = 2800;
/** Minimum answer length before silence can complete the turn. */
const ANSWER_MIN_CHARS = 20;
/** Re-ask the question once if the user hasn't said anything. */
const REASK_AFTER_MS = 15_000;
/** Nudge toward the Skip button after this long with no answer. */
const SKIP_NUDGE_AFTER_MS = 45_000;
/** Give up and suggest ending after this much TOTAL silence. */
const IDLE_END_AFTER_MS = 3 * 60_000;
/** Echo guard: keep the mic muted this long after TTS playback ends
 *  (covers decoder/output latency tails). */
const TTS_TAIL_MS = 300;

/** Short verbal acknowledgments, spoken the INSTANT an answer
 *  completes — masking the next-turn model call (~2-3s) the way a
 *  real interviewer's "mm-hm, got it" masks their thinking. Audio is
 *  prefetched at session start so playback is zero-latency. */
const ACKS_EN = [
  "Mm-hm, got it.",
  "Okay, thank you.",
  "I see.",
  "Alright, that makes sense.",
];
const ACKS_ZH = ["嗯,明白了。", "好的。", "了解。", "嗯,可以。"];

interface StartArgs {
  plan: RetakePlan;
  jd: string;
  resume: string;
  interviewerProfileSummary?: string;
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class MockInterviewer {
  private audio: AudioSession | null = null;
  private plan: RetakePlan | null = null;
  private jd = "";
  private resume = "";
  private interviewerProfileSummary = "";
  private tts: TtsProvider | null = null;
  private ttsCtx: AudioContext | null = null;
  private ttsDest: MediaStreamAudioDestinationNode | null = null;
  private activeTts: TtsHandle | null = null;
  /** Prefetched ack audio (aura only) — played instantly when a turn
   *  completes. */
  private ackBuffers: AudioBuffer[] = [];
  private nextAckIdx = 0;
  /** Serializes ALL spoken output (acks, questions, wrapup) so an ack
   *  still playing when the next question's audio is ready can't
   *  overlap it. */
  private speakChain: Promise<void> = Promise.resolve();
  /** Gesture-driven autoplay backstop — see start(). */
  private gestureResumeHandler: (() => void) | null = null;

  private phase:
    | "idle"
    | "greeting"
    | "asking"
    | "listening"
    | "deciding"
    | "wrapup"
    | "ended" = "idle";
  private slotIndex = 0;
  private followupDepth = 0;
  /** Question row the CURRENT turn writes into. */
  private currentQuestionId: string | null = null;
  /** Lead question id of the current slot (followups parent to it). */
  private currentLeadId: string | null = null;
  private currentQuestionText = "";
  private answerBuffer = "";
  /** Wall-clock of the last speech signal (interim OR final). */
  private lastSpeechAt = 0;
  private questionAskedAt = 0;
  private reasked = false;
  private skipNudged = false;
  /** Wall-clock until which finalized utterances belong to the AI
   *  (TTS playing + tail). */
  private ttsWindowUntil = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Recent turns for next-turn context. */
  private transcriptLog: Array<{
    speaker: "interviewer" | "candidate";
    text: string;
  }> = [];
  private stopped = false;

  async start(args: StartArgs): Promise<void> {
    this.plan = args.plan;
    this.jd = args.jd;
    this.resume = args.resume;
    this.interviewerProfileSummary = args.interviewerProfileSummary ?? "";
    this.tts = providerForLanguage(args.plan.language);
    this.stopped = false;
    this.phase = "idle";
    this.slotIndex = 0;
    this.followupDepth = 0;
    this.answerBuffer = "";
    this.transcriptLog = [];

    // TTS output context + capture destination. The RetakeModal's
    // two-step flow (Generate → separate Start click) means start()
    // runs inside a FRESH user gesture, so the context comes up
    // "running" — but resume defensively anyway, and install a
    // gesture backstop below: autoplay policy suspending either this
    // context or AudioSession's mixing context silently kills the
    // AI voice and/or the mic → Deepgram feed (the "can't hear the
    // candidate" field report).
    // The destination's stream is handed to AudioSession as
    // auxAudioStream: AI voice → recording + Deepgram. For zh
    // (webSpeech, canCapture=false) the destination just stays silent
    // — passing it anyway keeps the mixing path (and setMicGain) on.
    this.ttsCtx = new AudioContext();
    if (this.ttsCtx.state === "suspended") {
      void this.ttsCtx.resume().catch(() => {});
    }
    this.ttsDest = this.ttsCtx.createMediaStreamDestination();
    this.ackBuffers = [];
    this.nextAckIdx = 0;
    this.speakChain = Promise.resolve();

    this.audio = new AudioSession(this.makeCallbacks(), {
      captureTabAudio: "off",
      useMic: true,
      captureVideo: true,
      videoSource: "camera",
      auxAudioStream: this.ttsDest.stream,
      sttQueryOverrides:
        args.plan.language === "zh"
          ? { language: "zh", model: "nova-2" }
          : undefined,
    });
    await this.audio.start();
    if (this.audio.isStopped) {
      // start() aborted internally (it already surfaced the reason and
      // dispatched ic:session-aborted).
      throw new Error("audio session failed to start");
    }

    // Autoplay backstop: any click/keypress re-resumes both audio
    // contexts until they're confirmed running. Removed on stop().
    this.gestureResumeHandler = () => {
      if (this.ttsCtx && this.ttsCtx.state === "suspended") {
        void this.ttsCtx.resume().catch(() => {});
      }
      this.audio?.resumeAudioGraph();
    };
    window.addEventListener("pointerdown", this.gestureResumeHandler, true);
    window.addEventListener("keydown", this.gestureResumeHandler, true);

    // Prefetch the ack pool in the background (aura only) — tiny
    // clips, arrives within a couple seconds, needed from turn #1.
    if (this.tts?.name === "aura" && this.ttsCtx) {
      const acks = args.plan.language === "zh" ? ACKS_ZH : ACKS_EN;
      for (const a of acks) {
        void fetchAuraBuffer(this.ttsCtx, a)
          .then((b) => this.ackBuffers.push(b))
          .catch(() => {});
      }
    }

    // Poll for answer completion / silence handling.
    this.tickTimer = setInterval(() => this.tick(), 250);

    // Greeting → first question. Fire-and-forget; the state machine
    // takes it from here.
    void this.runGreeting();
  }

  getCameraStream(): MediaStream | null {
    return this.audio?.getCameraStream() ?? null;
  }

  /** Call-UI mute button. The TTS echo guard composes with this: the
   *  mic is live only when (not muted) AND (no TTS playing). */
  setUserMuted(muted: boolean): void {
    useStore.getState().setRetakeMicMuted(muted);
    if (Date.now() >= this.ttsWindowUntil) {
      this.audio?.setMicGain(muted ? 0 : 1);
    }
  }

  /** "Done — next question" button: complete the turn now. */
  forceCompleteTurn(): void {
    if (this.phase !== "listening") return;
    void this.completeTurn("user-done");
  }

  /** "Skip" button: complete with an empty answer, no commentary. */
  skipQuestion(): void {
    if (this.phase !== "listening") return;
    this.answerBuffer = "";
    void this.completeTurn("user-skip");
  }

  /** End call: cancel TTS, stop capture. Recording artifacts land on
   *  window.__ic_* via the AudioSession callbacks (same contract as
   *  the live orchestrator) for the page's end flow to consume. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.phase = "ended";
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.gestureResumeHandler) {
      window.removeEventListener(
        "pointerdown",
        this.gestureResumeHandler,
        true
      );
      window.removeEventListener("keydown", this.gestureResumeHandler, true);
      this.gestureResumeHandler = null;
    }
    this.activeTts?.cancel();
    this.activeTts = null;
    try {
      await this.audio?.stop();
    } finally {
      if (this.ttsCtx && this.ttsCtx.state !== "closed") {
        void this.ttsCtx.close().catch(() => {});
      }
      this.ttsCtx = null;
      this.ttsDest = null;
    }
  }

  // ===== internals =====

  private makeCallbacks() {
    return {
      onInterimTranscript: (text: string) => {
        // Interims refresh the speech clock so mid-sentence pauses
        // don't cut the user off; only meaningful outside TTS windows.
        if (text && Date.now() >= this.ttsWindowUntil) {
          this.lastSpeechAt = Date.now();
          // Tell the call UI we're hearing the candidate — drives the
          // "hearing you" indicator that catches dead-mic setups.
          window.dispatchEvent(new CustomEvent("ic:retake-speech"));
        }
      },
      onFinalTranscript: (text: string, speaker?: number, duration?: number) =>
        this.onUtterance(text, speaker, duration),
      onAudioReady: (audioUrl: string) => {
        (window as unknown as { __ic_audioUrl?: string }).__ic_audioUrl =
          audioUrl;
      },
      onVideoReady: (segmentUrls: string[], _d: number, mime: string) => {
        const win = window as unknown as {
          __ic_videoUrl?: string;
          __ic_videoSegmentUrls?: string[];
          __ic_videoMime?: string;
        };
        win.__ic_videoSegmentUrls = segmentUrls;
        win.__ic_videoMime = mime;
        win.__ic_videoUrl = segmentUrls[0];
      },
      onError: (msg: string) => {
        window.dispatchEvent(new CustomEvent("ic:error", { detail: msg }));
        // Mic denial is fatal for a mock interview (there is nothing
        // to interview without the candidate's voice). AudioSession's
        // mic-denied path only fires onError — surface it as an abort
        // so the page resets to idle.
        if (/microphone permission denied/i.test(msg)) {
          window.dispatchEvent(new CustomEvent("ic:session-aborted"));
        }
      },
      onLog: (event: string, data?: Record<string, unknown>) => {
        // Reuse the live debug channel naming so session_events
        // diagnostics work for retakes too.
        window.dispatchEvent(
          new CustomEvent("ic:debug", {
            detail: { source: "retake-audio", event, data },
          })
        );
      },
    };
  }

  private elapsed(): number {
    return useStore.getState().live.elapsedSeconds;
  }

  private setPhase(
    p: "greeting" | "asking" | "listening" | "thinking" | "wrapup" | "ended"
  ) {
    useStore.getState().setRetakePhase(p);
  }

  /** Prefetch one utterance's audio (aura only; null → speak() will
   *  fetch on demand / use webSpeech). Never throws. */
  private prefetch(text: string): Promise<AudioBuffer | null> {
    if (this.tts?.name !== "aura" || !this.ttsCtx) {
      return Promise.resolve(null);
    }
    return fetchAuraBuffer(this.ttsCtx, text).catch(() => null);
  }

  /** Speak `text`, serialized through the speak queue so utterances
   *  never overlap (an ack can still be playing when the next
   *  question's audio is ready). Mic is gain-zeroed for the whole
   *  playback window (echo guard). */
  private speak(
    text: string,
    prefetched?: Promise<AudioBuffer | null>
  ): Promise<void> {
    const run = async () => {
      if (!this.tts || this.stopped) return;
      this.audio?.setMicGain(0);
      this.ttsWindowUntil = Number.MAX_SAFE_INTEGER; // until playback resolves
      try {
        let handle: TtsHandle | null = null;
        if (this.tts.name === "aura" && this.ttsCtx) {
          let buf = prefetched ? await prefetched : null;
          if (!buf) {
            // On-demand fetch with one retry.
            for (let attempt = 0; attempt < 2 && !buf; attempt++) {
              try {
                buf = await fetchAuraBuffer(this.ttsCtx, text);
              } catch (e) {
                if (attempt === 1) throw e;
              }
            }
          }
          handle = playAuraBuffer(
            this.ttsCtx,
            buf!,
            this.ttsDest ?? undefined
          );
        } else {
          handle = await this.tts.speak(text, {
            audioContext: this.ttsCtx ?? undefined,
            captureInto: this.ttsDest ?? undefined,
          });
        }
        this.activeTts = handle;
        await handle.done;
      } catch {
        // TTS failed → caption-only degradation. The question text is
        // already on screen (retakeCaption); the caption + phase
        // change carry the turn.
        window.dispatchEvent(
          new CustomEvent("ic:error", {
            detail:
              "Interviewer voice unavailable — read the question from the caption below.",
          })
        );
      } finally {
        this.activeTts = null;
        this.ttsWindowUntil = Date.now() + TTS_TAIL_MS;
        // Restore mic after the tail unless the user muted themselves.
        setTimeout(() => {
          if (this.stopped) return;
          const userMuted = useStore.getState().retakeMicMuted;
          this.audio?.setMicGain(userMuted ? 0 : 1);
        }, TTS_TAIL_MS);
      }
    };
    this.speakChain = this.speakChain.then(run, run);
    return this.speakChain;
  }

  /** Instant spoken acknowledgment when a turn completes — masks the
   *  next-turn decision latency. Uses the prefetched pool (aura) or a
   *  quick speechSynthesis utterance (zh). Fire-and-forget; goes
   *  through the speak queue so the follow-on question waits for it. */
  private playAck(): void {
    if (this.stopped || !this.plan) return;
    if (this.tts?.name === "aura") {
      if (this.ackBuffers.length === 0) return; // pool not ready yet
      const buf =
        this.ackBuffers[this.nextAckIdx % this.ackBuffers.length];
      this.nextAckIdx += 1;
      void this.speak("", Promise.resolve(buf));
    } else {
      const acks = this.plan.language === "zh" ? ACKS_ZH : ACKS_EN;
      void this.speak(acks[this.nextAckIdx % acks.length]);
      this.nextAckIdx += 1;
    }
  }

  private async runGreeting(): Promise<void> {
    if (!this.plan || this.stopped) return;
    this.setPhase("greeting");
    useStore.getState().setRetakeCaption(this.plan.greeting);
    this.transcriptLog.push({
      speaker: "interviewer",
      text: this.plan.greeting,
    });
    // Prefetch the FIRST question's audio while the greeting plays —
    // the two flow back-to-back with no dead air.
    const q0 = this.plan.slots[0];
    const q0Audio = q0 ? this.prefetch(q0.question) : undefined;
    await this.speak(this.plan.greeting, this.prefetch(this.plan.greeting));
    if (this.stopped) return;
    await this.askSlotQuestion(0, q0Audio);
  }

  /** Ask the lead question of plan slot `i`. */
  private async askSlotQuestion(
    i: number,
    prefetched?: Promise<AudioBuffer | null>
  ): Promise<void> {
    if (!this.plan || this.stopped) return;
    const slot = this.plan.slots[i];
    if (!slot) {
      await this.runWrapup();
      return;
    }
    this.slotIndex = i;
    this.followupDepth = 0;
    await this.askQuestion(slot.question, { isFollowup: false, prefetched });
  }

  /** Ask `text` (either a slot lead or a generated follow-up),
   *  register the Question row, then enter listening. */
  private async askQuestion(
    text: string,
    opts: {
      isFollowup: boolean;
      prefetched?: Promise<AudioBuffer | null>;
    }
  ): Promise<void> {
    if (this.stopped) return;
    const store = useStore.getState();
    const q: Question = {
      id: rid("q"),
      text,
      askedAtSeconds: this.elapsed(),
      comments: [],
      kind: "interviewer",
      ...(opts.isFollowup && this.currentLeadId
        ? { parentQuestionId: this.currentLeadId }
        : {}),
    };
    store.addQuestion(q);
    this.currentQuestionId = q.id;
    if (!opts.isFollowup) this.currentLeadId = q.id;
    this.currentQuestionText = text;
    this.answerBuffer = "";
    this.reasked = false;
    this.skipNudged = false;

    this.setPhase("asking");
    store.setRetakeCaption(text);
    this.transcriptLog.push({ speaker: "interviewer", text });

    await this.speak(text, opts.prefetched);
    if (this.stopped) return;
    this.questionAskedAt = Date.now();
    this.lastSpeechAt = Date.now();
    this.setPhase("listening");
  }

  private onUtterance(text: string, dgSpeaker?: number, duration?: number) {
    if (this.stopped || !text.trim()) return;
    const store = useStore.getState();
    const inTtsWindow = Date.now() < this.ttsWindowUntil;

    const u: Utterance = {
      id: rid("u"),
      dgSpeaker,
      text,
      atSeconds: this.elapsed(),
      duration,
    };
    store.addUtterance(u);

    if (inTtsWindow) {
      // AI's own voice coming back through the aux mix — label its
      // diarization id as interviewer for PastView role resolution.
      if (dgSpeaker !== undefined) {
        store.mergeSpeakerRoles({ [dgSpeaker]: "interviewer" });
      }
      return;
    }

    // Candidate speech.
    if (dgSpeaker !== undefined) {
      store.mergeSpeakerRoles({ [dgSpeaker]: "candidate" });
    }
    this.lastSpeechAt = Date.now();
    window.dispatchEvent(new CustomEvent("ic:retake-speech"));
    if (this.phase === "listening" && this.currentQuestionId) {
      this.answerBuffer = this.answerBuffer
        ? `${this.answerBuffer} ${text.trim()}`
        : text.trim();
      store.appendCandidateAnswerText(this.currentQuestionId, text);
      this.transcriptLog.push({ speaker: "candidate", text });
    }
  }

  /** 500ms poll driving completion + silence handling. */
  private tick(): void {
    if (this.stopped || this.phase !== "listening") return;
    const now = Date.now();
    const sinceSpeech = now - this.lastSpeechAt;
    const sinceAsked = now - this.questionAskedAt;

    // Answer complete?
    if (
      this.answerBuffer.length >= ANSWER_MIN_CHARS &&
      sinceSpeech >= ANSWER_SILENCE_MS
    ) {
      void this.completeTurn("silence");
      return;
    }

    // Nothing said yet — escalating nudges.
    if (this.answerBuffer.length === 0) {
      if (!this.reasked && sinceAsked >= REASK_AFTER_MS) {
        this.reasked = true;
        void this.speak(this.currentQuestionText);
        return;
      }
      if (!this.skipNudged && sinceAsked >= SKIP_NUDGE_AFTER_MS) {
        this.skipNudged = true;
        window.dispatchEvent(
          new CustomEvent("ic:error", {
            detail:
              "Take your time — or use Skip to move to the next question.",
          })
        );
      }
      if (sinceAsked >= IDLE_END_AFTER_MS) {
        window.dispatchEvent(new CustomEvent("ic:retake-idle"));
      }
    }
  }

  private async completeTurn(
    source: "silence" | "user-done" | "user-skip"
  ): Promise<void> {
    if (this.phase !== "listening" || !this.plan) return;
    this.phase = "deciding";
    this.setPhase("thinking");

    const answered = this.answerBuffer;
    const qId = this.currentQuestionId;
    const qText = this.currentQuestionText;

    // Speak an instant acknowledgment ("Mm-hm, got it.") the moment
    // the answer lands — the next-turn model call below takes 2-3s
    // and dead air there is what makes the pacing feel robotic. The
    // speak queue guarantees the real transition waits for the ack.
    if (answered.trim() && source !== "user-skip") {
      this.playAck();
    }

    // Silent coaching — one commentary call per answered turn. Fire
    // and forget; the comment lands on the question whenever it lands.
    if (answered.trim() && qId && source !== "user-skip") {
      void this.generateSilentComment(qId, qText, answered);
    }

    // Decide the next move.
    let action: "followup" | "next" | "wrapup" = "next";
    let utterance = "";
    const isLast = this.slotIndex >= this.plan.slots.length - 1;

    if (source === "user-skip" || !answered.trim()) {
      // Nothing to probe — advance mechanically.
      action = isLast ? "wrapup" : "next";
      utterance = isLast ? "" : this.plan.slots[this.slotIndex + 1].question;
    } else {
      try {
        const r = await fetch("/api/mock-interviewer/next-turn", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jd: this.jd,
            resume: this.resume,
            language: this.plan.language,
            planSlots: this.plan.slots,
            currentSlotIndex: this.slotIndex,
            currentQuestionText: qText,
            followupDepth: this.followupDepth,
            candidateAnswer: answered,
            recentTranscript: this.transcriptLog.slice(-12),
          }),
        });
        if (!r.ok) throw new Error(`next-turn ${r.status}`);
        const data = (await r.json()) as {
          result?: {
            action: "followup" | "next" | "wrapup";
            utterance: string;
          };
        };
        if (!data.result) throw new Error("next-turn empty");
        action = data.result.action;
        utterance = data.result.utterance;
      } catch {
        // Script of last resort: the pre-generated plan. Never stall.
        action = isLast ? "wrapup" : "next";
        utterance = isLast
          ? ""
          : this.plan.slots[this.slotIndex + 1].question;
      }
    }

    if (this.stopped) return;
    if (action === "followup") {
      this.followupDepth += 1;
      await this.askQuestion(utterance, { isFollowup: true });
    } else if (action === "next") {
      this.slotIndex += 1;
      this.followupDepth = 0;
      // The model's utterance already contains ack + question; use it
      // as the spoken text but keep the Question row's text equal to
      // what was actually asked (the whole utterance is fine — it IS
      // what the interviewer said).
      await this.askQuestion(
        utterance || this.plan.slots[this.slotIndex]?.question || "",
        { isFollowup: false }
      );
    } else {
      await this.runWrapup();
    }
  }

  private async runWrapup(): Promise<void> {
    if (!this.plan || this.stopped) return;
    this.phase = "wrapup";
    this.setPhase("wrapup");
    useStore.getState().setRetakeCaption(this.plan.closing);
    this.transcriptLog.push({
      speaker: "interviewer",
      text: this.plan.closing,
    });
    await this.speak(this.plan.closing, this.prefetch(this.plan.closing));
    this.phase = "ended";
    this.setPhase("ended");
    window.dispatchEvent(new CustomEvent("ic:retake-complete"));
  }

  /** One silent commentary call for a completed turn. Accumulates the
   *  SSE stream into a single Comment on the question — the exact
   *  shape PastView + expand-suggestions already consume (text keeps
   *  the ---SAY--- marker; splitCommentary handles it at render). */
  private async generateSilentComment(
    questionId: string,
    questionText: string,
    answer: string
  ): Promise<void> {
    const { commentLang } = useStore.getState();
    try {
      const resp = await fetch("/api/commentary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jd: this.jd,
          resume: this.resume,
          interviewerProfile: this.interviewerProfileSummary,
          question: questionText,
          answer,
          lang: commentLang,
        }),
      });
      if (!resp.ok || !resp.body) return;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;
          try {
            const evt = JSON.parse(payload) as {
              type?: string;
              text?: string;
            };
            if (evt.type === "delta" && evt.text) accumulated += evt.text;
          } catch {
            /* malformed line */
          }
        }
      }
      if (!accumulated.trim()) return;
      const c: Comment = {
        id: rid("c"),
        text: accumulated,
        atSeconds: this.elapsed(),
        kind: "answer",
      };
      useStore.getState().addCommentToQuestion(questionId, c);
    } catch {
      // Silent coaching is best-effort — a lost comment never blocks
      // the interview.
    }
  }
}

// Singleton, mirroring getOrchestrator().
let instance: MockInterviewer | null = null;
export function getMockInterviewer(): MockInterviewer {
  if (!instance) instance = new MockInterviewer();
  return instance;
}
