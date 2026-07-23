/**
 * RealtimeMockInterviewer — the OpenAI Realtime (WebRTC) engine for the
 * Retake flow, MODEL-DRIVEN (ChatGPT-voice style). Drop-in for
 * MockInterviewer (same IMockInterviewer surface), selected by the
 * RETAKE engine flag in getMockInterviewer().
 *
 * v2 architecture — the model runs the whole conversation:
 *   - turn_detection.create_response:true → after each candidate turn
 *     the model responds on its own; it greets, asks the planned
 *     questions in order, adds natural follow-ups, acknowledges, and
 *     wraps up — no controller-driven turn injection or state machine.
 *   - The plan lives in the session `instructions` as SOFT GUARDRAILS
 *     (cover all questions, ≤1-2 follow-ups, don't invent topics).
 *   - The model calls the `end_interview` tool when it's done → we end.
 *
 * This controller is now an OBSERVER, not a driver. It:
 *   - records both sides' transcripts as Utterances (synthetic speaker
 *     ids so PastView role resolution works),
 *   - maps each AI turn that precedes an answer to a Question row and
 *     the candidate's reply to that question's answer_text (for
 *     scoring), fires silent Claude coaching per answered turn,
 *   - records the session via AudioSession (aux = AI voice, disableStt),
 *   - drives the call-UI phase from the response lifecycle,
 *   - keeps a text echo-guard so the AI's own voice (bleeding back
 *     through the mic) is never taken for a candidate answer.
 *
 * Barge-in: the uplink mic stays open; OpenAI's server VAD +
 * interrupt_response cut the AI off when the candidate speaks.
 */

import { AudioSession } from "./audioSession";
import { useStore } from "./store";
import { OpenAiRealtimeSession } from "./openaiRealtimeSession";
import type { IMockInterviewer, StartArgs } from "./mockInterviewerShared";
import type { RetakePlan } from "@/app/api/retake/plan/route";
import type { Comment, Question, Utterance } from "@/types/session";

// ===== tuning =====
/** No candidate speech for this long during listening → suggest ending. */
const IDLE_END_AFTER_MS = 3 * 60_000;
/** Stall watchdog: candidate silent this long during listening → have
 *  the AI re-engage IN THE INTERVIEW LANGUAGE (covers both "candidate
 *  is stuck" and "model went quiet after an unexpected input, e.g. an
 *  answer in another language" — the interview must never dead-air). */
const STALL_NUDGE_AFTER_MS = 25_000;
/** Minimum gap between two watchdog nudges. */
const STALL_NUDGE_GAP_MS = 40_000;
/** A candidate "answer" whose token overlap with a recent AI line is
 *  at/above this is the AI's own voice echoing back — drop it. */
const ECHO_OVERLAP_THRESHOLD = 0.6;
/** Speakerphone echo defense: while the AI is speaking, the OpenAI
 *  uplink is DUCKED to this gain (not muted — a real, close-to-mic
 *  voice still clears the raised VAD threshold, so barge-in works),
 *  which drops residual speaker echo below detection. */
const DUCK_GAIN = 0.22;
/** Keep the duck for a beat after response.done — the audio track
 *  keeps playing out (and echoing) briefly after generation ends. */
const DUCK_RELEASE_MS = 500;

// Synthetic diarization ids so PastView's speaker-role resolution works
// exactly as with Deepgram (we KNOW the roles here — no diarization).
const SPK_INTERVIEWER = 0;
const SPK_CANDIDATE = 1;

function rid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Token-overlap similarity in [0,1] against the smaller set. CJK falls
 *  back to per-character tokens. */
function tokenOverlap(a: string, b: string): number {
  const norm = (s: string): string[] => {
    const cleaned = s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "");
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length <= 2 && /[一-鿿]/.test(cleaned)) {
      return cleaned.replace(/\s+/g, "").split("");
    }
    return words;
  };
  const ta = new Set(norm(a));
  const tb = new Set(norm(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

type Phase =
  | "idle"
  | "greeting"
  | "asking"
  | "listening"
  | "thinking"
  | "wrapup"
  | "ended";

export class RealtimeMockInterviewer implements IMockInterviewer {
  private plan: RetakePlan | null = null;
  private jd = "";
  private resume = "";
  private interviewerProfileSummary = "";

  private audio: AudioSession | null = null;
  private session: OpenAiRealtimeSession | null = null;
  private micStream: MediaStream | null = null;
  /** Uplink processing chain (speakerphone ducking): raw mic →
   *  GainNode → MediaStreamDestination; the DESTINATION's track is
   *  what OpenAI hears, so lowering the gain while the AI speaks
   *  keeps its speaker echo below the VAD without closing the mic. */
  private uplinkCtx: AudioContext | null = null;
  private uplinkGain: GainNode | null = null;
  private duckReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  private phase: Phase = "idle";
  private stopped = false;
  private startedAtMs = 0;
  private userMuted = false;
  private endedFired = false;

  /** Recent AI spoken lines — the echo guard matches candidate
   *  transcripts against these. */
  private recentAiLines: string[] = [];
  /** The most recent AI turn's text + whether a NEW AI turn has
   *  happened since we last opened a Question (so the next answer maps
   *  to the right question). */
  private lastAiTurnText = "";
  private aiTurnSinceQuestion = false;
  /** The Question row the current answer attaches to. */
  private currentQuestionId: string | null = null;
  private currentQuestionText = "";

  /** Last CANDIDATE voice activity (speech events / transcripts only —
   *  AI turns don't count). Drives the stall watchdog + idle popup. */
  private lastSpeechAt = 0;
  private lastNudgeAt = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleFired = false;

  // ===== IMockInterviewer =====

  async start(args: StartArgs): Promise<void> {
    this.plan = args.plan;
    this.jd = args.jd;
    this.resume = args.resume;
    this.interviewerProfileSummary = args.interviewerProfileSummary ?? "";
    this.stopped = false;
    this.phase = "idle";
    this.startedAtMs = Date.now();
    this.userMuted = false;
    this.endedFired = false;
    this.recentAiLines = [];
    this.lastAiTurnText = "";
    this.aiTurnSinceQuestion = false;
    this.currentQuestionId = null;
    this.currentQuestionText = "";
    // Seed the activity clock with NOW — it previously started at 0,
    // so the first tick after entering "listening" computed decades of
    // "silence" and popped the end-interview dialog before the
    // candidate ever spoke (field report #1).
    this.lastSpeechAt = Date.now();
    this.lastNudgeAt = 0;
    this.idleFired = false;

    // 1) Mic for the OpenAI uplink. Full-duplex (stays open during AI
    //    speech) so the candidate can barge in. EC/NS on for echo.
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
    } catch {
      window.dispatchEvent(
        new CustomEvent("ic:error", { detail: "Microphone permission denied" })
      );
      window.dispatchEvent(new CustomEvent("ic:session-aborted"));
      throw new Error("mic denied");
    }

    // 1b) Uplink ducking chain (speakerphone echo defense). AEC runs at
    //     the getUserMedia source, so the processed track keeps it.
    //     Created inside the Start-click gesture → context runs.
    this.uplinkCtx = new AudioContext();
    if (this.uplinkCtx.state === "suspended") {
      void this.uplinkCtx.resume().catch(() => {});
    }
    const uplinkSrc = this.uplinkCtx.createMediaStreamSource(this.micStream);
    this.uplinkGain = this.uplinkCtx.createGain();
    this.uplinkGain.gain.value = 1;
    const uplinkDest = this.uplinkCtx.createMediaStreamDestination();
    uplinkSrc.connect(this.uplinkGain);
    this.uplinkGain.connect(uplinkDest);
    const uplinkStream = uplinkDest.stream;

    // 2) OpenAI realtime session (observer callbacks).
    let resolveRemote: (s: MediaStream | null) => void = () => {};
    const remotePromise = new Promise<MediaStream | null>((r) => {
      resolveRemote = r;
    });
    this.session = new OpenAiRealtimeSession({
      onRemoteStream: (s) => resolveRemote(s),
      onSpeechStarted: () => {
        this.lastSpeechAt = Date.now();
        window.dispatchEvent(new CustomEvent("ic:retake-speech"));
      },
      onSpeechStopped: () => {
        // Brief gap while the model composes its reply. Only from
        // "listening" — a stray VAD blip during AI speech (echo)
        // must not thrash the phase display.
        if (!this.stopped && this.phase === "listening") {
          this.setPhase("thinking");
        }
      },
      onCandidateTranscript: (text) => this.onCandidateAnswer(text),
      onAiTranscript: (text) => this.onAiTurn(text),
      onResponseCreated: () => {
        if (this.stopped || this.phase === "ended") return;
        this.setPhase("asking");
        // Duck the uplink for the whole AI turn — speaker echo stays
        // below the VAD threshold; a real interruption still passes.
        this.setDuck(true);
      },
      onResponseDone: () => {
        if (this.stopped || this.phase === "ended") return;
        this.setPhase("listening");
        this.setDuck(false); // releases after DUCK_RELEASE_MS tail
      },
      onFunctionCall: (name) => {
        if (name === "end_interview") this.runEnd();
      },
      onError: (msg) =>
        window.dispatchEvent(new CustomEvent("ic:error", { detail: msg })),
      onLog: (event, data) =>
        window.dispatchEvent(
          new CustomEvent("ic:debug", {
            detail: { source: "retake-realtime", event, data },
          })
        ),
    });

    await this.session.connect({
      // The DUCKED stream — OpenAI hears the gain-controlled mic.
      micStream: uplinkStream,
      instructions: this.buildInstructions(),
      voice: this.plan.language === "zh" ? "cedar" : "marin",
      language: this.plan.language,
    });

    const remote = await Promise.race([
      remotePromise,
      new Promise<MediaStream | null>((r) => setTimeout(() => r(null), 4000)),
    ]);

    // 3) Recording via AudioSession — NO Deepgram; aux = AI voice so the
    //    recording has both sides.
    this.audio = new AudioSession(this.makeAudioCallbacks(), {
      captureTabAudio: "off",
      useMic: true,
      captureVideo: true,
      videoSource: "camera",
      auxAudioStream: remote ?? undefined,
      disableStt: true,
    });
    await this.audio.start();
    if (this.audio.isStopped) {
      await this.cleanup();
      throw new Error("audio session failed to start");
    }

    // 4) Kick off the interview: the first response is the only one we
    //    request — after that create_response:true makes the model
    //    respond to each candidate turn on its own.
    this.setPhase("greeting");
    this.idleTimer = setInterval(() => this.tickIdle(), 1000);
    this.session.requestSpeak(
      "Begin the interview now. Greet the candidate briefly and immediately ask your first question."
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.phase = "ended";
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      this.session?.cancelResponse();
    } catch {
      /* noop */
    }
    this.session?.close();
    this.session = null;
    this.teardownUplink();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    // AudioSession.stop() flushes the recording to window.__ic_* via the
    // callbacks below — same contract the page's end flow consumes.
    try {
      await this.audio?.stop();
    } finally {
      this.audio = null;
    }
  }

  private teardownUplink(): void {
    if (this.duckReleaseTimer) {
      clearTimeout(this.duckReleaseTimer);
      this.duckReleaseTimer = null;
    }
    if (this.uplinkCtx && this.uplinkCtx.state !== "closed") {
      void this.uplinkCtx.close().catch(() => {});
    }
    this.uplinkCtx = null;
    this.uplinkGain = null;
  }

  getCameraStream(): MediaStream | null {
    return this.audio?.getCameraStream() ?? null;
  }

  setUserMuted(muted: boolean): void {
    this.userMuted = muted;
    useStore.getState().setRetakeMicMuted(muted);
    this.audio?.setMicGain(muted ? 0 : 1);
    this.session?.setMicEnabled(!muted);
  }

  /** No-op in the model-driven engine — the model decides when to move
   *  on; there is no manual "skip" that makes sense mid-conversation.
   *  (The button is hidden in this engine; kept for interface parity.) */
  skipQuestion(): void {
    /* intentionally no-op */
  }

  // ===== internals =====

  private setPhase(p: Exclude<Phase, "idle">) {
    if (this.phase === "ended") return;
    this.phase = p;
    useStore.getState().setRetakePhase(p);
  }

  /** Duck (or release) the OpenAI uplink. Release is delayed by
   *  DUCK_RELEASE_MS because the AI's audio keeps playing out — and
   *  echoing — for a beat after response.done. */
  private setDuck(on: boolean): void {
    if (!this.uplinkCtx || !this.uplinkGain) return;
    if (this.uplinkCtx.state === "suspended") {
      void this.uplinkCtx.resume().catch(() => {});
    }
    if (this.duckReleaseTimer) {
      clearTimeout(this.duckReleaseTimer);
      this.duckReleaseTimer = null;
    }
    const gain = this.uplinkGain.gain;
    if (on) {
      gain.setTargetAtTime(DUCK_GAIN, this.uplinkCtx.currentTime, 0.03);
    } else {
      this.duckReleaseTimer = setTimeout(() => {
        this.duckReleaseTimer = null;
        if (this.stopped || !this.uplinkCtx || !this.uplinkGain) return;
        this.uplinkGain.gain.setTargetAtTime(
          1,
          this.uplinkCtx.currentTime,
          0.05
        );
      }, DUCK_RELEASE_MS);
    }
  }

  private elapsed(): number {
    return this.startedAtMs ? (Date.now() - this.startedAtMs) / 1000 : 0;
  }

  /** Persona + language + the whole plan as SOFT GUARDRAILS. The model
   *  runs the interview from this — the controller never injects turns. */
  private buildInstructions(): string {
    const p = this.plan!;
    const langLine =
      p.language === "zh"
        ? "Speak ONLY in natural, conversational Mandarin Chinese. If the candidate speaks another language, DO NOT switch languages and DO NOT go silent — briefly acknowledge in Chinese, ask them to continue in Chinese, and repeat your current question in Chinese."
        : "Speak ONLY in natural, conversational English. If the candidate speaks another language (e.g. Chinese), DO NOT switch languages and DO NOT go silent — briefly acknowledge in English, ask them to continue in English, and repeat your current question in English.";
    const profile = this.interviewerProfileSummary
      ? `You are modeled on this interviewer: ${this.interviewerProfileSummary}. `
      : "";
    const nameLine = p.interviewerName
      ? `Your name is ${p.interviewerName} — introduce yourself by this name in your greeting. `
      : "";
    return [
      `You are a professional job interviewer running a realistic mock interview by voice. ${nameLine}${profile}${langLine}`,
      `Conduct it as a natural, flowing conversation — like a real interviewer on a call. Greet the candidate briefly, then work through the interview. Keep every turn short and conversational (1-3 sentences). Acknowledge answers naturally before moving on. Never lecture, never coach, never reveal the "right" answer — just interview. Let the candidate interrupt you at any time.`,
      `You MUST cover ALL of the questions below, in roughly this order. Ask them in your own natural words (do not read them verbatim). When an answer is thin or interesting, ask ONE — at most two — natural follow-up questions before moving on. Do NOT invent unrelated topics or add questions beyond these.`,
      `Questions to cover:\n${p.slots
        .map((s, i) => `${i + 1}. ${s.question}`)
        .join("\n")}`,
      `When you have covered every question and the candidate has answered, give a brief, warm closing (thank them, tell them that's the end) and then CALL THE end_interview FUNCTION. Do not call it before you have covered all the questions.`,
      p.greeting ? `Suggested greeting tone: "${p.greeting}"` : "",
      p.closing ? `Suggested closing tone: "${p.closing}"` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** An AI spoken turn's transcript is final. */
  private onAiTurn(text: string): void {
    if (this.stopped || !text.trim()) return;
    // Feed the echo guard.
    this.recentAiLines.push(text);
    if (this.recentAiLines.length > 5) this.recentAiLines.shift();
    // Record + caption.
    this.addUtterance(text, SPK_INTERVIEWER);
    useStore.getState().setRetakeCaption(text);
    // Remember this turn so the NEXT candidate answer maps to it.
    this.lastAiTurnText = text;
    this.aiTurnSinceQuestion = true;
  }

  /** A candidate turn's transcript is final. */
  private onCandidateAnswer(text: string): void {
    if (this.stopped || !text.trim()) return;

    // Echo guard: the AI's own voice bleeding back through the mic.
    const isEcho = this.recentAiLines.some(
      (line) => tokenOverlap(text, line) >= ECHO_OVERLAP_THRESHOLD
    );
    if (isEcho) return;

    this.lastSpeechAt = Date.now();
    this.idleFired = false;
    window.dispatchEvent(new CustomEvent("ic:retake-speech"));

    // Map to a Question row. A fresh AI turn since the last question
    // means THIS answer belongs to a new question (that AI turn).
    if (this.aiTurnSinceQuestion && this.lastAiTurnText) {
      const store = useStore.getState();
      const q: Question = {
        id: rid("q"),
        text: this.lastAiTurnText,
        askedAtSeconds: this.elapsed(),
        comments: [],
        kind: "interviewer",
      };
      store.addQuestion(q);
      this.currentQuestionId = q.id;
      this.currentQuestionText = this.lastAiTurnText;
      this.aiTurnSinceQuestion = false;
    }

    // Record the candidate utterance + answer text for scoring.
    this.addUtterance(text, SPK_CANDIDATE);
    if (this.currentQuestionId) {
      useStore
        .getState()
        .appendCandidateAnswerText(this.currentQuestionId, text);
      // Silent coaching for this answered turn (fire-and-forget).
      void this.generateSilentComment(
        this.currentQuestionId,
        this.currentQuestionText,
        text
      );
    }
  }

  private runEnd(): void {
    if (this.endedFired || this.stopped) return;
    this.endedFired = true;
    this.setPhase("ended");
    window.dispatchEvent(new CustomEvent("ic:retake-complete"));
  }

  private tickIdle(): void {
    if (this.stopped || this.phase !== "listening") return;
    const now = Date.now();
    const silentFor = now - this.lastSpeechAt;

    // Stall watchdog: the interview must never dead-air. Covers a
    // candidate who froze up AND the model going quiet after an
    // unexpected input (e.g. an answer in another language). The AI
    // re-engages in the interview language, like a real interviewer
    // ("take your time — would you like me to repeat the question?").
    if (
      silentFor >= STALL_NUDGE_AFTER_MS &&
      now - this.lastNudgeAt >= STALL_NUDGE_GAP_MS
    ) {
      this.lastNudgeAt = now;
      this.session?.requestSpeak(
        this.plan?.language === "zh"
          ? "候选人停顿了一会儿。用中文简短地重新引导:体贴地问是否需要重复问题,或换个说法再问当前的问题。一两句话即可。"
          : "The candidate has paused for a while (or may have spoken in another language). Re-engage briefly IN ENGLISH: kindly ask if they'd like the question repeated, or rephrase your current question. One or two sentences."
      );
      return;
    }

    if (!this.idleFired && silentFor >= IDLE_END_AFTER_MS) {
      this.idleFired = true;
      window.dispatchEvent(new CustomEvent("ic:retake-idle"));
    }
  }

  private addUtterance(text: string, speaker: number): void {
    const store = useStore.getState();
    const u: Utterance = {
      id: rid("u"),
      dgSpeaker: speaker,
      text,
      atSeconds: this.elapsed(),
    };
    store.addUtterance(u);
    store.mergeSpeakerRoles({
      [speaker]: speaker === SPK_INTERVIEWER ? "interviewer" : "candidate",
    });
  }

  /** Same silent-coaching call the Aura engine uses — one Comment per
   *  answered turn, identical shape for PastView + expand-suggestions. */
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
            const evt = JSON.parse(payload) as { type?: string; text?: string };
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
      /* best-effort */
    }
  }

  private makeAudioCallbacks() {
    return {
      // No Deepgram in this engine — transcripts come from OpenAI.
      onInterimTranscript: () => {},
      onFinalTranscript: () => {},
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
        if (/microphone permission denied/i.test(msg)) {
          window.dispatchEvent(new CustomEvent("ic:session-aborted"));
        }
      },
      onLog: (event: string, data?: Record<string, unknown>) => {
        window.dispatchEvent(
          new CustomEvent("ic:debug", {
            detail: { source: "retake-audio", event, data },
          })
        );
      },
    };
  }

  private async cleanup(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.session?.close();
    this.session = null;
    this.teardownUplink();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    try {
      await this.audio?.stop();
    } catch {
      /* noop */
    }
    this.audio = null;
  }
}
