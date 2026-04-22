import { AudioSession } from "./audioSession";
import { useStore } from "./store";
import type { Comment, MomentStateKind, Question } from "@/types/session";

/**
 * The orchestrator owns an in-progress interview session. It:
 *   1. Runs an AudioSession for transcription + recording
 *   2. Identifies speakers (via /api/identify-speakers, cached per-session)
 *   3. Drives the moment state machine (via /api/classify-moment)
 *   4. Manages question hierarchy (main + follow-ups), answer-buffer carry-
 *      over, and commentary timing/display-slot enforcement
 *   5. Triggers commentary generation at natural pauses
 *
 * There's exactly one orchestrator at a time, stored on the window for
 * debuggability and to survive React re-renders without a provider.
 */

// Tunable thresholds
const COMMENT_TRIGGER_CHARS = 220;
const COMMENT_MIN_GAP_MS    = 8000;
const COMMENT_MIN_DISPLAY_MS = 4000;   // floor — even a 1-word comment shows this long
const COMMENT_MAX_DISPLAY_MS = 30000;  // ceiling — a very long comment can still be replaced
const COMMENT_BUFFER_MS     = 1500;    // padding on top of computed reading time

// Identification thresholds
const IDENTIFY_MIN_DISTINCT_SPEAKERS = 2;
const IDENTIFY_MIN_TOTAL_UTTERANCES  = 3;
const IDENTIFY_CONTEXT_CAP           = 12;

// Moment classification timing
const CLASSIFY_DEBOUNCE_MS = 500;
const CLASSIFY_SILENCE_MS  = 3000;
const CLASSIFY_CONTEXT_CAP = 12;

type QuestionRelation = "new_topic" | "follow_up" | null;

function rand(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
}

/** Reading time for a piece of commentary text. Mixed Chinese + English uses
 *  the slower of the two rates so neither side gets cut off. */
function computeMinDisplayMs(text: string): number {
  if (!text) return COMMENT_MIN_DISPLAY_MS;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const englishWords = text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w)).length;
  const cjkSec = cjk / 4;        // 4 chars/sec
  const enSec = englishWords / 2; // 2 words/sec
  const readingMs = Math.max(cjkSec, enSec) * 1000;
  return Math.min(
    COMMENT_MAX_DISPLAY_MS,
    Math.max(COMMENT_MIN_DISPLAY_MS, readingMs + COMMENT_BUFFER_MS)
  );
}

export class LiveOrchestrator {
  private audio: AudioSession | null = null;
  /** Text accumulated under the current question, awaiting commentary. */
  private answerBuffer = "";
  /** Candidate text accumulated while interviewer is mid-question; carries
   *  over to answerBuffer when a new question finalizes so the start of
   *  the candidate's answer survives the transition. */
  private pendingAnswerBuffer = "";
  private pendingCommentaryFor: string | null = null;
  private lastCommentAt: Map<string, number> = new Map();
  private recentTranscript = "";

  private knownDgSpeakers = new Set<number>();
  private identifyInFlight = false;

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
    this.pendingCommentaryFor = null;
    this.lastCommentAt.clear();

    this.audio = new AudioSession({
      onInterimTranscript: (text) => {
        window.dispatchEvent(new CustomEvent("ic:interim", { detail: text }));
      },
      onFinalTranscript: (text, speaker, duration) =>
        this.onUtterance(text, speaker, duration),
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

  private async onUtterance(text: string, dgSpeaker?: number, duration?: number) {
    const clean = text.trim();
    if (!clean) return;

    this.recentTranscript = (this.recentTranscript + " " + clean).slice(-1200);

    {
      const state = useStore.getState();
      state.addUtterance({
        id: rand("u"),
        dgSpeaker,
        text: clean,
        atSeconds: state.live.elapsedSeconds,
        duration,
      });
    }

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

    this.lastTranscriptAt = Date.now();
    this.armSilenceTimer();
    if (dgSpeaker !== undefined && dgSpeaker !== this.lastDgSpeaker) {
      this.lastDgSpeaker = dgSpeaker;
      this.scheduleClassifyMoment();
    }

    const role =
      dgSpeaker !== undefined
        ? useStore.getState().liveSpeakerRoles[dgSpeaker]
        : undefined;
    if (role !== "candidate") return;

    const momentState = useStore.getState().liveMomentState.state;
    if (momentState === "question_finalized") {
      const { liveQuestions, live, setAnswerInProgress } = useStore.getState();
      if (!live.currentQuestionId) return;
      this.answerBuffer += (this.answerBuffer ? " " : "") + clean;
      setAnswerInProgress(true);
      if (this.shouldTriggerComment(live.currentQuestionId)) {
        const currentQ = liveQuestions.find((q) => q.id === live.currentQuestionId);
        if (currentQ) void this.generateComment(currentQ);
      }
    } else if (momentState === "interviewer_speaking") {
      this.pendingAnswerBuffer +=
        (this.pendingAnswerBuffer ? " " : "") + clean;
    }
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

      const store = useStore.getState();
      const currentState = store.liveMomentState.state;
      const msSinceLastTranscript = this.lastTranscriptAt
        ? Date.now() - this.lastTranscriptAt
        : 0;

      // Compute current main + follow-up texts to send to Haiku.
      const currentSubQ = store.liveQuestions.find(
        (q) => q.id === store.live.currentQuestionId
      );
      const currentMainQ = currentSubQ?.parentQuestionId
        ? store.liveQuestions.find((q) => q.id === currentSubQ.parentQuestionId)
        : currentSubQ;
      const currentMainQuestionText = currentMainQ?.text ?? "";
      const currentFollowUpText =
        currentSubQ && currentSubQ !== currentMainQ ? currentSubQ.text : "";

      const resp = await fetch("/api/classify-moment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterances: sample,
          currentState,
          msSinceLastTranscript,
          currentMainQuestionText,
          currentFollowUpText,
        }),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        state?: MomentStateKind;
        summary?: string;
        question?: string;
        questionRelation?: QuestionRelation;
      };
      if (!data.state) return;

      this.applyMoment(
        data.state,
        data.summary || "",
        data.question || "",
        data.questionRelation ?? null
      );
    } catch {
      /* best-effort; the next trigger will retry */
    } finally {
      this.classifyInFlight = false;
    }
  }

  /**
   * Apply a classify-moment result. Most of the complexity lives in deciding
   * whether a finalized question should:
   *   (a) replace the current main (new_topic),
   *   (b) attach as a follow-up under the current main (follow_up), or
   *   (c) no-op (same question being re-emphasized).
   *
   * And whether an interviewer_speaking transition should:
   *   (a) keep the current main but flag we're hearing a new topic forming
   *       (archive immediately so the bar shifts to "asking"),
   *   (b) treat as a follow-up being asked (keep main, show "asking follow-up" sub-state — handled in UI), or
   *   (c) ignore (chitchat / candidate clarification noise — keep showing).
   */
  private applyMoment(
    next: MomentStateKind,
    summary: string,
    questionText: string,
    rel: QuestionRelation
  ) {
    const store = useStore.getState();
    const prev = store.liveMomentState.state;
    const currentSubQ = store.liveQuestions.find(
      (q) => q.id === store.live.currentQuestionId
    );
    const currentMainQ = currentSubQ?.parentQuestionId
      ? store.liveQuestions.find((q) => q.id === currentSubQ.parentQuestionId)
      : currentSubQ;
    const currentFollowUpQ =
      currentSubQ && currentSubQ !== currentMainQ ? currentSubQ : undefined;

    // Anchored mode — once a main question is locked, be conservative.
    if (currentMainQ) {
      if (next === "question_finalized") {
        // Same as current main or current follow-up → no-op.
        const txt = (questionText || "").trim();
        if (
          !txt ||
          txt === currentMainQ.text.trim() ||
          (currentFollowUpQ && txt === currentFollowUpQ.text.trim())
        ) {
          // Just refresh state/summary in case display is stale (e.g. came
          // back from chitchat).
          store.setMomentState({ state: "question_finalized", summary });
          return;
        }
        if (rel === "follow_up") {
          // Attach as a sub-question under the existing main.
          this.addFollowUpAndStart(currentMainQ.id, txt, summary);
          return;
        }
        // Treat anything else as a new main topic — archive and start fresh.
        this.archiveCurrentMainAndStartNew(txt, summary);
        return;
      }
      if (next === "interviewer_speaking" && rel === "new_topic") {
        // Interviewer pivoting to a new topic — archive immediately so the bar
        // visibly shifts to "Interviewer is asking…" for the new main.
        store.setCurrentQuestionId(null);
        store.setMomentState({ state: "interviewer_speaking", summary });
        store.setDisplayedComment(null);
        store.setAnswerInProgress(false);
        this.answerBuffer = "";
        this.pendingAnswerBuffer = "";
        this.pendingCommentaryFor = null;
        return;
      }
      // Anything else (interviewer follow-up speaking, chitchat, candidate
      // off-topic) — keep showing Current Question + the latest follow-up.
      // We DO refresh the moment summary so the UI can show a follow-up
      // "asking" state if it wants. But we don't change the locked-in
      // question(s) themselves.
      if (next === "interviewer_speaking" && rel === "follow_up") {
        store.setMomentState({ state: "interviewer_speaking", summary });
      }
      return;
    }

    // Pre-anchored — no current main yet. Free to transition normally.
    store.setMomentState({ state: next, summary });

    if (next === "question_finalized") {
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
        store.setAnswerInProgress(this.answerBuffer.length > 0);
        if (this.shouldTriggerComment(q.id)) {
          void this.generateComment(q);
        }
      }
    } else if (next === "interviewer_speaking" || next === "chitchat") {
      this.pendingAnswerBuffer = "";
    }
  }

  private addFollowUpAndStart(parentId: string, text: string, summary: string) {
    const store = useStore.getState();
    const q: Question = {
      id: rand("q"),
      text,
      askedAtSeconds: store.live.elapsedSeconds,
      comments: [],
      parentQuestionId: parentId,
    };
    store.addQuestion(q);
    store.setMomentState({ state: "question_finalized", summary });
    // Carry over any candidate text accumulated while interviewer was asking
    // this follow-up.
    this.answerBuffer = this.pendingAnswerBuffer;
    this.pendingAnswerBuffer = "";
    this.pendingCommentaryFor = null;
    store.setDisplayedComment(null); // fresh display slot for the new sub-Q
    store.setAnswerInProgress(this.answerBuffer.length > 0);
    if (this.shouldTriggerComment(q.id)) {
      void this.generateComment(q);
    }
  }

  private archiveCurrentMainAndStartNew(text: string, summary: string) {
    const store = useStore.getState();
    // Archive: just clear currentQuestionId — old questions stay in the array
    // and the UI's "Earlier in this interview" filter picks them up.
    store.setCurrentQuestionId(null);
    const q: Question = {
      id: rand("q"),
      text,
      askedAtSeconds: store.live.elapsedSeconds,
      comments: [],
    };
    store.addQuestion(q);
    store.setMomentState({ state: "question_finalized", summary });
    store.setDisplayedComment(null);
    this.answerBuffer = this.pendingAnswerBuffer;
    this.pendingAnswerBuffer = "";
    this.pendingCommentaryFor = null;
    store.setAnswerInProgress(this.answerBuffer.length > 0);
    if (this.shouldTriggerComment(q.id)) {
      void this.generateComment(q);
    }
  }

  private buildClassifySample(): Array<{ speaker: string; text: string }> {
    const store = useStore.getState();
    const all = store.liveUtterances;
    const roles = store.liveSpeakerRoles;
    if (all.length === 0) return [];

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

  /**
   * Decide whether commentary can fire right now. Combined gate:
   *   - Not already generating
   *   - Enough new answer text (COMMENT_TRIGGER_CHARS)
   *   - Hard cooldown since last commentary on this question (COMMENT_MIN_GAP_MS)
   *   - Currently displayed comment has finished its minimum-display window
   */
  private shouldTriggerComment(questionId: string): boolean {
    if (this.pendingCommentaryFor) return false;
    if (this.answerBuffer.length < COMMENT_TRIGGER_CHARS) return false;
    const last = this.lastCommentAt.get(questionId) ?? 0;
    if (Date.now() - last < COMMENT_MIN_GAP_MS) return false;

    const displayed = useStore.getState().liveDisplayedComment;
    if (displayed) {
      const elapsed = Date.now() - displayed.displayedAt;
      if (elapsed < displayed.minMs) return false;
    }
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

      // Streaming finished. Claim the display slot now (so the min-display
      // window starts AFTER streaming, not at the start) and clear the
      // "answer in progress" dots indicator.
      const minMs = computeMinDisplayMs(accumulated);
      useStore.getState().setDisplayedComment({
        id: commentId,
        questionId: currentQ.id,
        displayedAt: Date.now(),
        minMs,
      });
      useStore.getState().setAnswerInProgress(false);
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
