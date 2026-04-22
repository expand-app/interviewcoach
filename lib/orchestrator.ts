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

function rand(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
}

export class LiveOrchestrator {
  private audio: AudioSession | null = null;
  private answerBuffer = "";                // text accumulated since last comment
  private pendingCommentaryFor: string | null = null;  // question id we're generating for
  private lastCommentAt: Map<string, number> = new Map();
  private recentTranscript = "";

  async start() {
    if (this.audio) return;

    this.audio = new AudioSession({
      onInterimTranscript: (text) => {
        // Surface live caption by publishing to window; UI can subscribe if desired.
        window.dispatchEvent(
          new CustomEvent("ic:interim", { detail: text })
        );
      },
      onFinalTranscript: (text) => this.onUtterance(text),
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

  private async onUtterance(text: string) {
    const clean = text.trim();
    if (!clean) return;

    this.recentTranscript = (this.recentTranscript + " " + clean).slice(-1200);

    // Classify: is this a new question from the interviewer?
    const { isQuestion, question } = await this.classify(clean);

    if (isQuestion && question) {
      this.onNewQuestion(question);
      return;
    }

    // Otherwise it's part of the current answer.
    const { liveQuestions, live } = useStore.getState();
    if (!live.currentQuestionId) {
      // No question detected yet — we drop these utterances rather than guess.
      return;
    }

    this.answerBuffer += (this.answerBuffer ? " " : "") + clean;

    // Should we trigger a commentary?
    if (this.shouldTriggerComment(live.currentQuestionId)) {
      const currentQ = liveQuestions.find((q) => q.id === live.currentQuestionId);
      if (currentQ) void this.generateComment(currentQ);
    }
  }

  private async classify(utterance: string): Promise<{ isQuestion: boolean; question: string }> {
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
      return { isQuestion: data.isQuestion, question: data.question || "" };
    } catch {
      return { isQuestion: false, question: "" };
    }
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
