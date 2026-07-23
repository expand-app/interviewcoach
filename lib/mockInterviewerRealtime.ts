/**
 * RealtimeMockInterviewer — the OpenAI Realtime (WebRTC) engine for the
 * Retake flow. Drop-in for MockInterviewer (same IMockInterviewer
 * surface), selected by the RETAKE engine flag in getMockInterviewer().
 *
 * What OpenAI handles that the Aura engine hand-rolled:
 *   - the AI voice (gpt-realtime-2.1, natural low-latency)
 *   - turn-taking + barge-in (server VAD) — no tick()/silence/echo code
 *   - both-side transcription
 *
 * What THIS controller still owns (so the rest of the app is unchanged):
 *   - slot progression + follow-up depth (the plan's structure)
 *   - registering Question / Utterance / Comment rows in the store, in
 *     the SAME shape PastView + scoring already consume
 *   - the session recording, via AudioSession with disableStt:true and
 *     auxAudioStream = the AI's remote audio track (mic + AI voice → S3)
 *   - the store phases + ic:retake-* events the call UI reads
 *
 * Turn model: turn_detection.create_response is false, so the AI speaks
 * ONLY when we call requestSpeak(). We decide follow-up-vs-advance
 * locally (plan control) and let the model generate the contextual
 * wording (natural). Everything OpenAI-uncertain is isolated in
 * openaiRealtimeSession.ts.
 */

import { AudioSession } from "./audioSession";
import { useStore } from "./store";
import { OpenAiRealtimeSession } from "./openaiRealtimeSession";
import type { IMockInterviewer, StartArgs } from "./mockInterviewerShared";
import type { RetakePlan } from "@/app/api/retake/plan/route";
import type { Comment, Question, Utterance } from "@/types/session";

// ===== tuning =====
/** Max follow-ups per slot (matches the Aura engine's depth cap). */
const MAX_FOLLOWUP_DEPTH = 1;
/** An answer shorter than this (words) is treated as "thin" → eligible
 *  for a follow-up when the slot allows it. Longer answers move on. */
const THIN_ANSWER_WORDS = 45;
/** No candidate speech for this long during listening → suggest ending. */
const IDLE_END_AFTER_MS = 3 * 60_000;

// Synthetic diarization ids so PastView's speaker-role resolution works
// exactly as with Deepgram (we KNOW the roles here — no diarization).
const SPK_INTERVIEWER = 0;
const SPK_CANDIDATE = 1;

/** Wait this long after the AI's response.done before re-opening the
 *  uplink mic — the AI audio track keeps PLAYING OUT for a beat after
 *  generation finishes, and that tail would otherwise be transcribed
 *  as candidate speech. */
const UPLINK_REOPEN_DELAY_MS = 600;
/** A candidate "answer" whose token overlap with a recent AI line is
 *  at/above this is the AI's own voice echoing back — drop it. */
const ECHO_OVERLAP_THRESHOLD = 0.6;

function rid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Token-overlap similarity in [0,1] against the smaller set. CJK falls
 *  back to per-character tokens. (Same idea as the Aura engine's echo
 *  guard.) */
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

  private phase: Phase = "idle";
  private stopped = false;
  private slotIndex = 0;
  private followupDepth = 0;
  private startedAtMs = 0;

  /** The Question row the current answer attaches to. */
  private currentQuestionId: string | null = null;
  private currentQuestionText = "";
  /** Lead question id of the current slot (followups parent to it). */
  private currentLeadId: string | null = null;
  /** True while we expect the AI's next transcript to BE a question
   *  (so we register it as a Question row rather than a stray line). */
  private expectingQuestion = false;
  /** True while the AI is asking a FOLLOW-UP (parents to the lead). */
  private pendingIsFollowup = false;
  /** Guard so one candidate answer drives exactly one decision. */
  private answerHandledForTurn = false;
  /** User pressed the mute button (distinct from the automatic
   *  during-AI-speech uplink muting). */
  private userMuted = false;
  /** Recent AI spoken lines — the echo guard matches candidate
   *  transcripts against these. */
  private recentAiLines: string[] = [];
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;

  private lastSpeechAt = 0;
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
    this.slotIndex = 0;
    this.followupDepth = 0;
    this.currentQuestionId = null;
    this.currentLeadId = null;
    this.expectingQuestion = false;
    this.pendingIsFollowup = false;
    this.answerHandledForTurn = false;
    this.idleFired = false;
    this.startedAtMs = Date.now();

    // 1) Mic for the OpenAI uplink. Separate from AudioSession's own
    //    recording mic (muting handles both). EC/NS on — the AI plays
    //    through the speakers.
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

    // 2) OpenAI realtime session. The remote AI audio track (ontrack)
    //    resolves remotePromise so we can hand it to AudioSession's aux.
    let resolveRemote: (s: MediaStream | null) => void = () => {};
    const remotePromise = new Promise<MediaStream | null>((r) => {
      resolveRemote = r;
    });
    this.session = new OpenAiRealtimeSession({
      onRemoteStream: (s) => resolveRemote(s),
      onSpeechStarted: () => {
        this.lastSpeechAt = Date.now();
        window.dispatchEvent(new CustomEvent("ic:retake-speech"));
        if (this.phase === "asking") this.setPhase("listening");
      },
      onCandidateTranscript: (text) => this.onCandidateAnswer(text),
      onAiTranscript: (text) => this.onAiTranscript(text),
      onResponseDone: () => this.onAiResponseDone(),
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
      micStream: this.micStream,
      instructions: this.buildInstructions(),
      voice: this.plan.language === "zh" ? "cedar" : "marin",
      language: this.plan.language,
    });

    // Wait briefly for the AI audio track so the recording captures it.
    const remote = await Promise.race([
      remotePromise,
      new Promise<MediaStream | null>((r) => setTimeout(() => r(null), 4000)),
    ]);

    // 3) Recording via AudioSession — NO Deepgram (transcripts come from
    //    OpenAI); aux = AI voice so the recording has both sides.
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

    // 4) Idle watchdog + greeting.
    this.idleTimer = setInterval(() => this.tickIdle(), 1000);
    this.runGreeting();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.phase = "ended";
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    try {
      this.session?.cancelResponse();
    } catch {
      /* noop */
    }
    this.session?.close();
    this.session = null;
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

  getCameraStream(): MediaStream | null {
    return this.audio?.getCameraStream() ?? null;
  }

  setUserMuted(muted: boolean): void {
    this.userMuted = muted;
    useStore.getState().setRetakeMicMuted(muted);
    // Recording mic follows the button immediately. The OpenAI uplink
    // is only opened when we're actually listening (and not muted) —
    // never while the AI is speaking (echo).
    this.audio?.setMicGain(muted ? 0 : 1);
    this.session?.setMicEnabled(!muted && this.phase === "listening");
  }

  // ===== echo control =====
  //
  // The OpenAI uplink mic is CLOSED whenever the AI is speaking, and
  // only re-opened a beat after the AI's audio finishes — otherwise the
  // AI's own voice (through the speakers) is transcribed as the
  // candidate's answer. This mirrors the Aura engine's mic-gain guard.

  /** Speak an AI turn: close the uplink first so the AI's voice can't
   *  be captured as candidate input, then request the turn. */
  private aiSay(instructions: string): void {
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    this.session?.setMicEnabled(false);
    this.session?.requestSpeak(instructions);
  }

  /** Enter listening: re-open the uplink after a short tail so the AI's
   *  audio playout can drain first. */
  private enterListening(): void {
    if (this.stopped) return;
    this.setPhase("listening");
    this.lastSpeechAt = Date.now();
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      if (this.stopped || this.phase !== "listening") return;
      this.session?.setMicEnabled(!this.userMuted);
    }, UPLINK_REOPEN_DELAY_MS);
  }

  skipQuestion(): void {
    if (this.phase !== "listening" && this.phase !== "asking") return;
    // Cut off any AI speech and jump to the next slot with no answer.
    try {
      this.session?.cancelResponse();
    } catch {
      /* noop */
    }
    this.advanceSlot();
  }

  // ===== internals =====

  private setPhase(p: Exclude<Phase, "idle">) {
    this.phase = p;
    useStore.getState().setRetakePhase(p);
  }

  private elapsed(): number {
    return this.startedAtMs ? (Date.now() - this.startedAtMs) / 1000 : 0;
  }

  /** Persona + language + full plan, given to the realtime session as
   *  its standing instructions. The plan questions are the source of
   *  truth; the controller injects them one at a time via requestSpeak,
   *  but embedding them here keeps the model on-topic and consistent. */
  private buildInstructions(): string {
    const p = this.plan!;
    const langLine =
      p.language === "zh"
        ? "Speak ONLY in natural, conversational Mandarin Chinese."
        : "Speak ONLY in natural, conversational English.";
    const profile = this.interviewerProfileSummary
      ? `\nYou are modeled on this interviewer: ${this.interviewerProfileSummary}\n`
      : "";
    return [
      `You are a professional job interviewer conducting a mock interview.`,
      langLine,
      profile,
      `Keep every turn short and conversational — 1 to 3 sentences, like a real interviewer. Never lecture, never coach, never give feedback or the "right answer". Just interview.`,
      `When asked to pose a question, ask it naturally in your own words. When asked to follow up, dig into a specific detail the candidate just mentioned. When asked to move on, briefly acknowledge their answer in a few words, then ask the next question.`,
      `You will be told exactly what to do for each turn. Do not skip ahead or invent new topics on your own.`,
      `\nThe interview covers these questions in order:\n${p.slots
        .map((s, i) => `${i + 1}. ${s.question}`)
        .join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private runGreeting(): void {
    if (!this.plan || this.stopped) return;
    this.setPhase("greeting");
    useStore.getState().setRetakeCaption(this.plan.greeting);
    this.expectingQuestion = false;
    this.aiSay(
      `Greet the candidate warmly and say, in your own natural words: "${this.plan.greeting}". Do not ask a question yet.`
    );
    // On response.done we advance to the first slot question.
  }

  /** Ask the lead question of the current slot. */
  private askCurrentSlot(): void {
    if (!this.plan || this.stopped) return;
    const slot = this.plan.slots[this.slotIndex];
    if (!slot) {
      this.runWrapup();
      return;
    }
    this.followupDepth = 0;
    this.pendingIsFollowup = false;
    this.expectingQuestion = true;
    this.answerHandledForTurn = false;
    this.setPhase("asking");
    this.aiSay(
      `Ask the candidate this question, in your own natural words (one or two sentences): "${slot.question}"`
    );
  }

  /** Candidate finished an answer (OpenAI final transcript). */
  private onCandidateAnswer(text: string): void {
    if (this.stopped || !text.trim()) return;

    // Echo guard: if this "answer" closely matches a line the AI just
    // spoke, it's the AI's own voice bleeding into the mic — drop it
    // (do NOT append, do NOT advance). The real answer will follow.
    const isEcho = this.recentAiLines.some(
      (line) => tokenOverlap(text, line) >= ECHO_OVERLAP_THRESHOLD
    );
    if (isEcho) return;

    this.lastSpeechAt = Date.now();
    this.idleFired = false;

    // Persist the utterance (candidate lane) + answer text for scoring.
    this.addUtterance(text, SPK_CANDIDATE);
    if (this.currentQuestionId) {
      useStore
        .getState()
        .appendCandidateAnswerText(this.currentQuestionId, text);
    }

    // One decision per turn — the model may emit multiple transcript
    // fragments; only the first drives progression.
    if (this.answerHandledForTurn) return;
    this.answerHandledForTurn = true;

    // Silent coaching for this answered turn (fire-and-forget).
    const qId = this.currentQuestionId;
    const qText = this.currentQuestionText;
    if (qId && qText) {
      void this.generateSilentComment(qId, qText, text);
    }

    this.setPhase("thinking");
    this.decideNextTurn(text);
  }

  /** Local decision: follow up once on a thin answer where the slot
   *  allows it, otherwise advance. The model generates the wording. */
  private decideNextTurn(answer: string): void {
    if (!this.plan || this.stopped) return;
    const slot = this.plan.slots[this.slotIndex];
    const words = answer.trim().split(/\s+/).filter(Boolean).length;
    const canFollowup =
      !!slot?.allowFollowups &&
      this.followupDepth < MAX_FOLLOWUP_DEPTH &&
      words < THIN_ANSWER_WORDS;

    if (canFollowup) {
      this.followupDepth += 1;
      this.pendingIsFollowup = true;
      this.expectingQuestion = true;
      this.answerHandledForTurn = false;
      this.setPhase("asking");
      this.aiSay(
        `The candidate just said: "${answer.slice(0, 600)}". Ask ONE short, natural follow-up question that digs into a specific part of what they said. One sentence.`
      );
      return;
    }
    this.advanceSlot();
  }

  private advanceSlot(): void {
    if (!this.plan || this.stopped) return;
    this.slotIndex += 1;
    if (this.slotIndex >= this.plan.slots.length) {
      this.runWrapup();
      return;
    }
    const slot = this.plan.slots[this.slotIndex];
    this.followupDepth = 0;
    this.pendingIsFollowup = false;
    this.expectingQuestion = true;
    this.answerHandledForTurn = false;
    this.setPhase("asking");
    // Ack + next question in ONE natural turn (no dead air).
    this.aiSay(
      `Briefly acknowledge the candidate's answer in a few words, then ask the next question in your own natural words: "${slot.question}"`
    );
  }

  private runWrapup(): void {
    if (!this.plan || this.stopped) return;
    this.setPhase("wrapup");
    this.expectingQuestion = false;
    useStore.getState().setRetakeCaption(this.plan.closing);
    this.aiSay(
      `Wrap up the interview: briefly thank the candidate and say, naturally: "${this.plan.closing}". Do not ask anything else.`
    );
    // ic:retake-complete fires on the wrapup response.done.
  }

  /** An AI spoken turn's transcript is final. */
  private onAiTranscript(text: string): void {
    if (this.stopped || !text.trim()) return;
    // Feed the echo guard: candidate transcripts matching a recent AI
    // line are the AI's own voice bleeding back through the mic.
    this.recentAiLines.push(text);
    if (this.recentAiLines.length > 4) this.recentAiLines.shift();
    // Persist as an interviewer utterance for the transcript.
    this.addUtterance(text, SPK_INTERVIEWER);
    useStore.getState().setRetakeCaption(text);

    // If we were expecting a question, THIS transcript is it → register
    // the Question row the upcoming answer attaches to.
    if (this.expectingQuestion) {
      this.expectingQuestion = false;
      const store = useStore.getState();
      const q: Question = {
        id: rid("q"),
        text,
        askedAtSeconds: this.elapsed(),
        comments: [],
        kind: "interviewer",
        ...(this.pendingIsFollowup && this.currentLeadId
          ? { parentQuestionId: this.currentLeadId }
          : {}),
      };
      store.addQuestion(q);
      this.currentQuestionId = q.id;
      this.currentQuestionText = text;
      if (!this.pendingIsFollowup) this.currentLeadId = q.id;
    }
  }

  /** One AI response fully finished. Drives the state machine forward
   *  for turns that don't depend on a candidate answer (greeting → first
   *  question; wrapup → end). */
  private onAiResponseDone(): void {
    if (this.stopped) return;
    if (this.phase === "greeting") {
      this.askCurrentSlot();
      return;
    }
    if (this.phase === "wrapup") {
      this.setPhase("ended");
      window.dispatchEvent(new CustomEvent("ic:retake-complete"));
      return;
    }
    // asking → listening: the AI finished posing the question. Re-open
    // the uplink mic after a short tail (enterListening).
    if (this.phase === "asking") {
      this.enterListening();
    }
  }

  private tickIdle(): void {
    if (this.stopped || this.phase !== "listening") return;
    if (
      !this.idleFired &&
      Date.now() - this.lastSpeechAt >= IDLE_END_AFTER_MS
    ) {
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
      // No Deepgram in this engine — transcripts come from OpenAI, so
      // the transcript callbacks are inert.
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
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    this.session?.close();
    this.session = null;
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
