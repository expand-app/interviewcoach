import { AudioSession } from "./audioSession";
import { useStore } from "./store";
import type { Comment, MomentStateKind, Question } from "@/types/session";

/**
 * The orchestrator owns an in-progress interview session. It:
 *   1. Runs an AudioSession for transcription + recording
 *   2. Identifies speakers (via /api/identify-speakers, cached per-session)
 *   3. Drives the moment state machine (via /api/classify-moment)
 *   4. Manages question creation and answer-buffer carry-over across states
 *   5. Triggers commentary generation at natural pauses
 *
 * There's exactly one orchestrator at a time, stored on the window for
 * debuggability and to survive React re-renders without a provider.
 */

// Tunable thresholds
const COMMENT_TRIGGER_CHARS = 220;
const COMMENT_MIN_GAP_MS    = 8000;

// Identification thresholds
const IDENTIFY_MIN_DISTINCT_SPEAKERS = 2;
const IDENTIFY_MIN_TOTAL_UTTERANCES  = 3;
const IDENTIFY_CONTEXT_CAP           = 12;

// Moment classification timing
const CLASSIFY_DEBOUNCE_MS = 500;
const CLASSIFY_SILENCE_MS  = 2000;
const CLASSIFY_CONTEXT_CAP = 12;

function rand(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
}

export class LiveOrchestrator {
  private audio: AudioSession | null = null;
  /** Text accumulated under the current finalized question, awaiting commentary. */
  private answerBuffer = "";
  /** Candidate text accumulated while the interviewer is mid-question; carried
   *  over to answerBuffer when the question finalizes so the start of the
   *  candidate's response isn't lost from commentary input. */
  private pendingAnswerBuffer = "";
  private pendingCommentaryFor: string | null = null;
  private lastCommentAt: Map<string, number> = new Map();
  private recentTranscript = "";

  /** Speaker identification (Deepgram speaker # → role). Lives in the store
   *  so the UI can re-derive labels. We keep the in-flight gate locally. */
  private knownDgSpeakers = new Set<number>();
  private identifyInFlight = false;

  /** Moment classification timing/gating. */
  private lastDgSpeaker: number | undefined;
  private lastTranscriptAt = 0;
  private classifyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private classifyInFlight = false;

  async start() {
    if (this.audio) return;
    this.knownDgSpeakers.clear();
    this.identifyInFlight = false;
    this.lastDgSpeaker = undefined;
    this.lastTranscriptAt = 0;
    this.classifyInFlight = false;
    this.answerBuffer = "";
    this.pendingAnswerBuffer = "";

    this.audio = new AudioSession({
      onInterimTranscript: (text) => {
        window.dispatchEvent(new CustomEvent("ic:interim", { detail: text }));
      },
      onFinalTranscript: (text, speaker) => this.onUtterance(text, speaker),
      onAudioReady: (audioUrl) => {
        (window as unknown as { __ic_audioUrl?: string }).__ic_audioUrl = audioUrl;
      },
      onError: (msg) => {
        window.dispatchEvent(new CustomEvent("ic:error", { detail: msg }));
        useStore.getState().setLiveStatus("idle");
      },
    });

    await this.audio.start();
  }

  pause() {
    this.audio?.pause();
    useStore.getState().setLiveStatus("paused");
  }

  resume() {
    this.audio?.resume();
    useStore.getState().setLiveStatus("recording");
  }

  async stop() {
    if (this.classifyDebounceTimer) {
      clearTimeout(this.classifyDebounceTimer);
      this.classifyDebounceTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (!this.audio) return;
    await this.audio.stop();
    this.audio = null;
  }

  // ----- internals -----

  private async onUtterance(text: string, dgSpeaker?: number) {
    const clean = text.trim();
    if (!clean) return;

    this.recentTranscript = (this.recentTranscript + " " + clean).slice(-1200);

    // 1) Persist the raw utterance immediately for the live captions UI.
    {
      const state = useStore.getState();
      state.addUtterance({
        id: rand("u"),
        dgSpeaker,
        text: clean,
        atSeconds: state.live.elapsedSeconds,
      });
    }

    // 2) Trigger speaker identification at the right moments.
    if (dgSpeaker !== undefined) {
      const isNewDgSpeaker = !this.knownDgSpeakers.has(dgSpeaker);
      this.knownDgSpeakers.add(dgSpeaker);

      const state = useStore.getState();
      const totalUtterances = state.liveUtterances.length;
      const identified = state.liveSpeakerRoles;
      const distinctSpeakers = this.knownDgSpeakers.size;

      const haveAnyIdentified = Object.keys(identified).length > 0;
      const isUnidentified = identified[dgSpeaker] === undefined;

      const firstRun =
        !haveAnyIdentified &&
        distinctSpeakers >= IDENTIFY_MIN_DISTINCT_SPEAKERS &&
        totalUtterances >= IDENTIFY_MIN_TOTAL_UTTERANCES;
      const newSpeakerRun =
        haveAnyIdentified && isNewDgSpeaker && isUnidentified;

      if ((firstRun || newSpeakerRun) && !this.identifyInFlight) {
        void this.runIdentifySpeakers();
      }
    }

    // 3) Drive the moment state machine.
    //    - Reset silence timer (2s of nothing → trigger classify).
    //    - On speaker switch, schedule a debounced classify.
    this.lastTranscriptAt = Date.now();
    this.armSilenceTimer();
    if (dgSpeaker !== undefined && dgSpeaker !== this.lastDgSpeaker) {
      this.lastDgSpeaker = dgSpeaker;
      this.scheduleClassifyMoment();
    }

    // 4) Per-state buffering of CANDIDATE text.
    const role =
      dgSpeaker !== undefined
        ? useStore.getState().liveSpeakerRoles[dgSpeaker]
        : undefined;
    if (role !== "candidate") return;

    const momentState = useStore.getState().liveMomentState.state;
    if (momentState === "question_finalized") {
      const { liveQuestions, live } = useStore.getState();
      if (!live.currentQuestionId) return;
      this.answerBuffer += (this.answerBuffer ? " " : "") + clean;
      if (this.shouldTriggerComment(live.currentQuestionId)) {
        const currentQ = liveQuestions.find((q) => q.id === live.currentQuestionId);
        if (currentQ) void this.generateComment(currentQ);
      }
    } else if (momentState === "interviewer_speaking") {
      // Carry-over: stash candidate text so the start of their answer survives
      // the transition into question_finalized.
      this.pendingAnswerBuffer +=
        (this.pendingAnswerBuffer ? " " : "") + clean;
    }
    // chitchat / idle → drop candidate text (no question to attach it to).
  }

  // ----- moment state machine -----

  private scheduleClassifyMoment() {
    if (this.classifyDebounceTimer) clearTimeout(this.classifyDebounceTimer);
    this.classifyDebounceTimer = setTimeout(() => {
      this.classifyDebounceTimer = null;
      void this.runClassifyMoment();
    }, CLASSIFY_DEBOUNCE_MS);
  }

  private armSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.runClassifyMoment();
    }, CLASSIFY_SILENCE_MS);
  }

  private async runClassifyMoment() {
    if (this.classifyInFlight) return;
    this.classifyInFlight = true;
    try {
      const sample = this.buildClassifySample();
      if (sample.length === 0) return;

      const currentState = useStore.getState().liveMomentState.state;
      const msSinceLastTranscript = this.lastTranscriptAt
        ? Date.now() - this.lastTranscriptAt
        : 0;

      const resp = await fetch("/api/classify-moment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterances: sample,
          currentState,
          msSinceLastTranscript,
        }),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        state?: MomentStateKind;
        summary?: string;
        question?: string;
      };
      if (!data.state) return;

      this.applyMoment(data.state, data.summary || "", data.question || "");
    } catch {
      /* best-effort; the next trigger will retry */
    } finally {
      this.classifyInFlight = false;
    }
  }

  private applyMoment(
    next: MomentStateKind,
    summary: string,
    questionText: string
  ) {
    const store = useStore.getState();
    const prev = store.liveMomentState.state;

    // Always update the displayed state + summary (even if state didn't change,
    // the summary may have been refined as the interviewer kept talking).
    store.setMomentState({ state: next, summary });

    if (next === "question_finalized" && prev !== "question_finalized") {
      // New question: create the Question, carry over any candidate text the
      // candidate has spoken since the interviewer started this question.
      const text = questionText || summary;
      if (text) {
        const q: Question = {
          id: rand("q"),
          text,
          askedAtSeconds: store.live.elapsedSeconds,
          comments: [],
        };
        store.addQuestion(q);
        this.answerBuffer = this.pendingAnswerBuffer;
        this.pendingAnswerBuffer = "";
        this.pendingCommentaryFor = null;
        // If the carried-over text already exceeds the trigger, fire commentary
        // immediately for a snappy first reaction.
        if (this.shouldTriggerComment(q.id)) {
          void this.generateComment(q);
        }
      }
    } else if (next !== "question_finalized" && prev === "question_finalized") {
      // Leaving question_finalized — the just-completed question falls into
      // "Earlier in this interview" by clearing currentQuestionId.
      store.setCurrentQuestionId(null);
      this.answerBuffer = "";
      this.pendingCommentaryFor = null;
      // Reset pending buffer for the NEW question that's beginning.
      this.pendingAnswerBuffer = "";
    } else if (next === "interviewer_speaking" && prev !== "interviewer_speaking") {
      // Entering interviewer_speaking from chitchat or idle — start a fresh
      // pending buffer so candidate text from prior chitchat doesn't leak in.
      this.pendingAnswerBuffer = "";
    } else if (next === "chitchat") {
      // Chitchat — nothing the candidate says is part of any answer.
      this.pendingAnswerBuffer = "";
    }
  }

  /**
   * Recent utterances tagged with their resolved role label (or "Speaker N"
   * placeholder for unidentified speakers). Cap CLASSIFY_CONTEXT_CAP, in
   * chronological order so Haiku sees turn-taking.
   */
  private buildClassifySample(): Array<{ speaker: string; text: string }> {
    const store = useStore.getState();
    const all = store.liveUtterances;
    const roles = store.liveSpeakerRoles;
    if (all.length === 0) return [];

    // Build stable 1-indexed speaker numbers in first-heard order.
    const indexBySpeaker = new Map<number, number>();
    let nextIdx = 1;
    for (const u of all) {
      if (u.dgSpeaker === undefined) continue;
      if (!indexBySpeaker.has(u.dgSpeaker)) {
        indexBySpeaker.set(u.dgSpeaker, nextIdx++);
      }
    }

    const tail = all.slice(-CLASSIFY_CONTEXT_CAP);
    return tail.map((u) => {
      let label: string;
      if (u.dgSpeaker === undefined) {
        label = "Speaker";
      } else {
        const role = roles[u.dgSpeaker];
        if (role === "interviewer") label = "Interviewer";
        else if (role === "candidate") label = "Candidate";
        else label = `Speaker ${indexBySpeaker.get(u.dgSpeaker)}`;
      }
      return { speaker: label, text: u.text };
    });
  }

  // ----- speaker identification -----

  private async runIdentifySpeakers() {
    this.identifyInFlight = true;
    try {
      const sample = this.buildIdentifySample();
      if (sample.length === 0) return;

      const resp = await fetch("/api/identify-speakers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utterances: sample }),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        roles?: Record<string, "interviewer" | "candidate">;
      };
      if (!data.roles) return;

      const numKeyed: Record<number, "interviewer" | "candidate"> = {};
      for (const [k, v] of Object.entries(data.roles)) {
        const n = Number(k);
        if (Number.isFinite(n)) numKeyed[n] = v;
      }
      useStore.getState().mergeSpeakerRoles(numKeyed);
    } catch {
      /* best-effort; will retry on the next trigger */
    } finally {
      this.identifyInFlight = false;
    }
  }

  private buildIdentifySample(): Array<{ speaker: number; text: string }> {
    const all = useStore.getState().liveUtterances;
    const tagged = all.filter(
      (u): u is typeof u & { dgSpeaker: number } => typeof u.dgSpeaker === "number"
    );
    if (tagged.length === 0) return [];

    const bySpeaker = new Map<number, typeof tagged>();
    for (const u of tagged) {
      const list = bySpeaker.get(u.dgSpeaker) ?? [];
      list.push(u);
      bySpeaker.set(u.dgSpeaker, list);
    }

    const numSpeakers = bySpeaker.size;
    const sharePerSpeaker = Math.max(1, Math.floor(IDENTIFY_CONTEXT_CAP / numSpeakers));

    const picked = new Set<string>();
    for (const list of bySpeaker.values()) {
      for (const u of list.slice(-sharePerSpeaker)) picked.add(u.id);
    }

    return tagged
      .filter((u) => picked.has(u.id))
      .map((u) => ({ speaker: u.dgSpeaker, text: u.text }));
  }

  // ----- commentary -----

  private shouldTriggerComment(questionId: string): boolean {
    if (this.pendingCommentaryFor) return false;
    if (this.answerBuffer.length < COMMENT_TRIGGER_CHARS) return false;
    const last = this.lastCommentAt.get(questionId) ?? 0;
    if (Date.now() - last < COMMENT_MIN_GAP_MS) return false;
    return true;
  }

  private async generateComment(currentQ: Question) {
    this.pendingCommentaryFor = currentQ.id;
    const bufferForThisComment = this.answerBuffer;
    this.answerBuffer = "";

    const { liveJd, liveResume, commentLang, addCommentToQuestion, live } =
      useStore.getState();

    const commentId = rand("c");
    const emptyComment: Comment = {
      id: commentId,
      text: "",
      atSeconds: live.elapsedSeconds,
    };
    addCommentToQuestion(currentQ.id, emptyComment);

    try {
      const resp = await fetch("/api/commentary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd: liveJd,
          resume: liveResume,
          question: currentQ.text,
          answer: bufferForThisComment,
          priorComments: currentQ.comments.map((c) => c.text),
          lang: commentLang,
        }),
      });

      if (!resp.ok || !resp.body) throw new Error("Commentary request failed");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
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
            const evt = JSON.parse(payload);
            if (evt.type === "delta" && evt.text) {
              accumulated += evt.text;
              this.patchCommentText(currentQ.id, commentId, accumulated);
            }
          } catch {
            /* ignore malformed line */
          }
        }
      }

      this.lastCommentAt.set(currentQ.id, Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      window.dispatchEvent(new CustomEvent("ic:error", { detail: msg }));
    } finally {
      this.pendingCommentaryFor = null;
    }
  }

  private patchCommentText(qid: string, cid: string, text: string) {
    useStore.setState((s) => ({
      liveQuestions: s.liveQuestions.map((q) =>
        q.id !== qid
          ? q
          : {
              ...q,
              comments: q.comments.map((c) =>
                c.id === cid ? { ...c, text } : c
              ),
            }
      ),
    }));
  }

  /** Manual trigger — generate a comment NOW against the current question. */
  async forceComment() {
    const { live, liveQuestions } = useStore.getState();
    if (!live.currentQuestionId) return;
    const currentQ = liveQuestions.find((q) => q.id === live.currentQuestionId);
    if (!currentQ) return;
    if (!this.answerBuffer) this.answerBuffer = this.recentTranscript.slice(-500);
    await this.generateComment(currentQ);
  }
}

let singleton: LiveOrchestrator | null = null;
export function getOrchestrator(): LiveOrchestrator {
  if (!singleton) singleton = new LiveOrchestrator();
  return singleton;
}
