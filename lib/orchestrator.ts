import { AudioSession } from "./audioSession";
import { useStore } from "./store";
import type { Comment, Question } from "@/types/session";

/**
 * The orchestrator owns an in-progress interview session. It:
 *   1. Runs an AudioSession for transcription + recording
 *   2. Feeds each finalized utterance into the question detector
 *   3. Accumulates answer text under the current question
 *   4. Triggers commentary generation at natural pauses
 *
 * There's exactly one orchestrator at a time, stored on the window for
 * debuggability and to survive React re-renders without a provider.
 */

// Tunable thresholds
const COMMENT_TRIGGER_CHARS = 220;   // ~40-60 spoken words of new answer text
const COMMENT_MIN_GAP_MS   = 8000;   // don't spam — min 8s between comments on same Q

// Identification thresholds
const IDENTIFY_MIN_DISTINCT_SPEAKERS = 2;
const IDENTIFY_MIN_TOTAL_UTTERANCES  = 3;
const IDENTIFY_CONTEXT_CAP           = 12; // utterances sent to Haiku, balanced

function rand(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
}

export class LiveOrchestrator {
  private audio: AudioSession | null = null;
  private answerBuffer = "";                // text accumulated since last comment
  private pendingCommentaryFor: string | null = null;  // question id we're generating for
  private lastCommentAt: Map<string, number> = new Map();
  private recentTranscript = "";
  /** All Deepgram speaker numbers we've heard so far (used for identify trigger). */
  private knownDgSpeakers = new Set<number>();
  /** Set when an identify-speakers request is in flight. */
  private identifyInFlight = false;

  async start() {
    if (this.audio) return;
    this.knownDgSpeakers.clear();
    this.identifyInFlight = false;

    this.audio = new AudioSession({
      onInterimTranscript: (text) => {
        // Surface live caption by publishing to window; UI can subscribe if desired.
        window.dispatchEvent(
          new CustomEvent("ic:interim", { detail: text })
        );
      },
      onFinalTranscript: (text, speaker) => this.onUtterance(text, speaker),
      onAudioReady: (audioUrl, _duration) => {
        // Stash on window for the End & Save flow to pick up.
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
    if (!this.audio) return;
    await this.audio.stop();
    this.audio = null;
  }

  // ----- internals -----

  private async onUtterance(text: string, dgSpeaker?: number) {
    const clean = text.trim();
    if (!clean) return;

    this.recentTranscript = (this.recentTranscript + " " + clean).slice(-1200);

    // 1) Persist the raw utterance immediately. UI shows it under a placeholder
    //    label like "Speaker 1" until identification resolves.
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
    //    - First time: ≥2 distinct speakers seen AND ≥3 total utterances
    //    - Subsequent: a brand-new Deepgram speaker number appears AND we
    //      already have an identity map for at least one other speaker
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

    // 3) Question detection — only if we know this speaker is the interviewer.
    //    Until identity is resolved we deliberately don't guess; per design,
    //    the very first interview question may show in captions but not in
    //    the Question feed.
    const role =
      dgSpeaker !== undefined
        ? useStore.getState().liveSpeakerRoles[dgSpeaker]
        : undefined;

    if (role === "interviewer") {
      const { isQuestion, question } = await this.detectQuestion(clean);
      if (isQuestion && question) {
        this.onNewQuestion(question);
      }
      return; // Interviewer chatter (non-question) is not part of any answer.
    }

    // 4) Only accumulate to the answer buffer when we're confident the
    //    speaker is the candidate. "unknown" speakers (not yet identified by
    //    Haiku) might turn out to be another interviewer, so we don't risk
    //    polluting the buffer with their text.
    if (role !== "candidate") return;

    const { liveQuestions, live } = useStore.getState();
    if (!live.currentQuestionId) return;

    this.answerBuffer += (this.answerBuffer ? " " : "") + clean;

    if (this.shouldTriggerComment(live.currentQuestionId)) {
      const currentQ = liveQuestions.find((q) => q.id === live.currentQuestionId);
      if (currentQ) void this.generateComment(currentQ);
    }
  }

  /**
   * Pure question detection. Caller must have already determined the speaker
   * is the interviewer — this endpoint no longer does speaker classification.
   */
  private async detectQuestion(utterance: string): Promise<{
    isQuestion: boolean;
    question: string;
  }> {
    try {
      const resp = await fetch("/api/detect-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterance,
          recentContext: this.recentTranscript,
        }),
      });
      if (!resp.ok) return { isQuestion: false, question: "" };
      const data = (await resp.json()) as {
        isQuestion: boolean;
        question?: string;
      };
      return {
        isQuestion: Boolean(data.isQuestion),
        question: data.question || "",
      };
    } catch {
      return { isQuestion: false, question: "" };
    }
  }

  /**
   * Sample recent utterances (balanced across speakers) and ask Haiku to
   * classify each Deepgram speaker number as interviewer or candidate.
   * Results merge into the store, where the UI re-derives labels.
   */
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

      // Normalize keys to numbers for the store.
      const numKeyed: Record<number, "interviewer" | "candidate"> = {};
      for (const [k, v] of Object.entries(data.roles)) {
        const n = Number(k);
        if (Number.isFinite(n)) numKeyed[n] = v;
      }
      useStore.getState().mergeSpeakerRoles(numKeyed);
    } catch {
      /* best-effort; we'll retry on the next trigger */
    } finally {
      this.identifyInFlight = false;
    }
  }

  /**
   * Build a balanced sample of recent utterances for identification. Cap is
   * IDENTIFY_CONTEXT_CAP total; share equally across speakers, taking each
   * speaker's most recent utterances. Returned in original chronological
   * order so Haiku sees turn-taking.
   */
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
      const tail = list.slice(-sharePerSpeaker);
      for (const u of tail) picked.add(u.id);
    }

    return tagged
      .filter((u) => picked.has(u.id))
      .map((u) => ({ speaker: u.dgSpeaker, text: u.text }));
  }

  private onNewQuestion(text: string) {
    const { live, addQuestion } = useStore.getState();
    const q: Question = {
      id: rand("q"),
      text,
      askedAtSeconds: live.elapsedSeconds,
      comments: [],
    };
    addQuestion(q);
    // New question resets the answer buffer.
    this.answerBuffer = "";
    this.pendingCommentaryFor = null;
  }

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

    // We append the comment progressively as SSE deltas arrive.
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
    // We reach directly into the store to mutate one comment; adding a
    // dedicated setter would be cleaner but this stays close to Zustand.
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
    // Use buffer if present, otherwise the last ~500 chars of recent transcript.
    if (!this.answerBuffer) this.answerBuffer = this.recentTranscript.slice(-500);
    await this.generateComment(currentQ);
  }
}

// Singleton accessor
let singleton: LiveOrchestrator | null = null;
export function getOrchestrator(): LiveOrchestrator {
  if (!singleton) singleton = new LiveOrchestrator();
  return singleton;
}
