import { AudioSession } from "./audioSession";
import { PlaybackSession, type TranscribedUtterance } from "./playbackSession";
import { useStore } from "./store";
import { logClient as log, resetClientLog } from "./client-log";
import type {
  Comment,
  MomentStateKind,
  Question,
  Utterance,
} from "@/types/session";

/** Truncate text for log previews. Long transcripts in the log would
 *  bloat the file and defeat the grep-by-time workflow. */
function preview(s: string, n = 80): string {
  if (!s) return "";
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n) + "…" : clean;
}

/** A set of speaker-role assignments is "confirmed" once the user has
 *  manually tagged AT LEAST ONE speaker. Interviews are two-person —
 *  tagging one side tells us the other side will be the opposite, and
 *  the auto-assign branch in onUtterance fills it in when that second
 *  speaker shows up. Waiting for BOTH roles before firing classify /
 *  commentary means a long opening interviewer monologue would produce
 *  no Lead-Question detection and no listening hints until the
 *  candidate speaks — which could be 40+ seconds. Relaxing the gate
 *  lets the pipeline start as soon as the user confirms identity.
 *
 *  Commentary remains safe: it's keyed on `role === "candidate"`
 *  inside onUtterance, so until the candidate role IS tagged, no
 *  answer buffer accumulates and no commentary fires. Symmetrically
 *  for listening hints on the interviewer side. */
function rolesAreConfirmed(
  roles: Record<number, "interviewer" | "candidate">
): boolean {
  for (const v of Object.values(roles)) {
    if (v === "interviewer" || v === "candidate") return true;
  }
  return false;
}

/** Minimal shape the orchestrator needs from a capture source. Both
 *  AudioSession (mic) and PlaybackSession (uploaded file) satisfy this. */
interface CaptureSource {
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
}

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
// Chars of NEW answer text before we consider a fresh comment. Raised from
// 220 → 450 so the model doesn't interrupt a candidate mid-thought — we
// want to let answers develop, only flagging things once there's enough
// substance to say something concrete. Obvious problems surface through
// the natural delay rather than aggressive early triggers.
const COMMENT_TRIGGER_CHARS = 450;
// Hard cooldown between comments on the same question. Raised from 8s →
// 15s so consecutive comments don't pile up on a long continuous answer.
const COMMENT_MIN_GAP_MS    = 15000;
const COMMENT_MIN_DISPLAY_MS = 4000;   // floor — even a 1-word comment shows this long
// Ceiling raised from 30s to 90s. A 200-char CJK listening hint computes
// to 50s + 1.5s buffer = 51.5s of true reading time per the user's spec
// (4 chars/sec). The old 30s cap was clipping long hints far below the
// time a real reader needs, which compounded the consume-once flicker —
// the slot expired prematurely and re-yielded to a stale prior comment.
const COMMENT_MAX_DISPLAY_MS = 90000;
const COMMENT_BUFFER_MS     = 1500;    // padding on top of computed reading time

// Listening-hint triggers — fire when the interviewer has been
// monologuing at length without a question finalizing. Typically this is
// the case-setup / team-description / context-elaboration phase.
// Threshold is "new chars since last hint" (watermark-gated), not raw
// buffer size — see lastListeningHintBufferSize in the class.
const LISTENING_HINT_TRIGGER_CHARS = 250;
const LISTENING_HINT_MIN_GAP_MS    = 10000;

// Warm-up commentary triggers — fire when candidate accumulates
// self-intro text before any Lead Question has been locked. Same
// watermark + cooldown idiom as listening hints.
const WARMUP_COMMENTARY_TRIGGER_CHARS = 250;
const WARMUP_COMMENTARY_MIN_GAP_MS    = 10000;

// Identification thresholds
const IDENTIFY_MIN_DISTINCT_SPEAKERS = 2;
const IDENTIFY_MIN_TOTAL_UTTERANCES  = 3;
const IDENTIFY_CONTEXT_CAP           = 24;
/** Pre-confirmation cadence: run identify every N new utterances while
 *  roles are still uncertain. Faster than post-confirmation so the user
 *  doesn't sit in the "Speaker 1 / 2" state longer than necessary. */
const IDENTIFY_REFRESH_UTTERANCES_PRE_CONFIRM  = 3;
/** Post-confirmation cadence: once both roles are committed, re-evaluate
 *  periodically as a REVIEW mechanism. Not aggressive — just often
 *  enough that if the early commit was wrong, Haiku has multiple
 *  chances to flip it once it has richer context. */
const IDENTIFY_REFRESH_UTTERANCES_POST_CONFIRM = 10;
/** Consecutive identify runs that must propose the SAME role before we
 *  commit (or flip) that role. 2 is the sweet spot the user asked for:
 *  commit when "roughly confident", not "90% confident". A single run
 *  can still be noise; two runs in a row suggests a real read. The
 *  periodic review mechanism catches mistakes if they happen. */
const IDENTIFY_CONFIDENCE_THRESHOLD  = 2;

// === Question-lock multi-signal filter ===
// See `pendingLead` doc on the class for the full 4-layer design.
/** Layer 1: min fraction of ≥4-char tokens in the proposed Q text that
 *  must appear in the last 30s of interviewer transcript. Below this
 *  the Q is assumed hallucinated and discarded. */
const GROUNDING_MIN_TOKEN_MATCH = 0.5;
/** Layer 1: how far back to look for grounding (seconds of speech). */
const GROUNDING_RECENT_SEC = 30;
/** Layer 3: milliseconds of interviewer silence required after the
 *  proposed Lead before we commit. If a new interviewer utterance
 *  arrives within this window, pending is discarded. */
const CONTINUATION_GATE_MS = 3000;
/** Cooldown window after a Lead/Probe commits, during which any
 *  semantically-similar new proposal is dropped as a restatement. The
 *  classifier sometimes emits the same Q twice back-to-back with
 *  slightly different wording; without this, both end up committed as
 *  separate Questions. 10s is long enough to cover the typical
 *  classifier-flap window but short enough that a genuine new Q on
 *  the same topic minutes later still gets through. */
const RESTATEMENT_COOLDOWN_MS = 10000;
/** Token-Jaccard threshold above which a new proposal is considered a
 *  restatement of the just-committed Q. ≥ 0.5 reliably catches the
 *  "a little bit" vs "a bit" type reword but lets genuinely different
 *  questions through (topically related but distinct Qs cluster near
 *  0.2-0.3). */
const RESTATEMENT_JACCARD_THRESHOLD = 0.5;

/** Number of consecutive classify results in the same direction
 *  required before a non-question state transition is committed.
 *  Raised from 1 (immediate) to 2 because the classifier flaps on
 *  ambiguous utterances — 2 votes is enough to smooth out single-
 *  utterance noise without meaningfully delaying real transitions.
 *  Note: question_finalized bypasses this (it has its own filter). */
const MOMENT_HYSTERESIS_THRESHOLD = 2;

// Moment classification timing
const CLASSIFY_DEBOUNCE_MS = 500;
const CLASSIFY_SILENCE_MS  = 3000;
const CLASSIFY_CONTEXT_CAP = 12;

type QuestionRelation = "new_topic" | "follow_up" | null;

function rand(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now()}`;
}

/** Reading time for a piece of commentary text.
 *  Strip HTML tags first so the pre-rendered `<strong>X</strong>`
 *  markup doesn't inflate the count (was previously counting the tag
 *  as an English word and over-shooting by 1-2x). For mixed Chinese
 *  + English, the times ADD — you have to read both halves, not the
 *  longer one. Math.max(...) was the bug that made 200-char hints
 *  with embedded English terms get visually truncated. */
function computeMinDisplayMs(text: string): number {
  if (!text) return COMMENT_MIN_DISPLAY_MS;
  const stripped = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .trim();
  if (!stripped) return COMMENT_MIN_DISPLAY_MS;
  const cjk = (stripped.match(/[一-鿿]/g) || []).length;
  const englishWords = stripped
    .split(/\s+/)
    .filter((w) => /[a-zA-Z]/.test(w)).length;
  const readingMs = (cjk / 4 + englishWords / 2) * 1000;
  return Math.min(
    COMMENT_MAX_DISPLAY_MS,
    Math.max(COMMENT_MIN_DISPLAY_MS, readingMs + COMMENT_BUFFER_MS)
  );
}

export class LiveOrchestrator {
  private audio: CaptureSource | null = null;
  /** Text accumulated under the current question, awaiting commentary. */
  private answerBuffer = "";
  /** Candidate text accumulated while interviewer is mid-question; carries
   *  over to answerBuffer when a new question finalizes so the start of
   *  the candidate's answer survives the transition. */
  private pendingAnswerBuffer = "";
  /** Full back-and-forth dialogue since the current question finalized —
   *  BOTH roles, in order. Used by commentary so it can read the
   *  interviewer's backchannel reactions (laughs, "interesting", "hmm",
   *  "great") as signals of how the answer is landing, not just the
   *  candidate's words in isolation. Reset on question change. */
  private dialogueBuffer: Array<{
    speaker: "interviewer" | "candidate";
    text: string;
  }> = [];
  /** Text accumulated from the interviewer while they're monologuing
   *  (state === interviewer_speaking, no finalized question yet or in
   *  between questions). Used to trigger "listening hints" for the
   *  candidate. Reset when the interviewer stops (question finalizes or
   *  candidate starts answering). */
  private interviewerMonologueBuffer = "";
  private pendingListeningHint = false;
  private lastListeningHintAt = 0;
  /** Candidate warm-up speech buffer. Accumulates candidate text while
   *  no Lead Question is locked (typical: self-introduction responding
   *  to the interviewer's opening chitchat). Used to trigger warm-up
   *  coaching commentary — separate from answer-judging commentary. */
  private candidateWarmupBuffer = "";
  private pendingWarmupCommentary = false;
  private lastWarmupCommentAt = 0;
  private lastWarmupBufferSize = 0;

  /** Shared across ALL commentary types (Q-A, listening hint, warm-up).
   *  Every commentary that successfully streams in records its final
   *  text + the moment it finished streaming here. Before firing a
   *  listening hint or warm-up commentary we consult this to ensure
   *  the previous piece has been on screen long enough for a typical
   *  reader to finish — no point slamming a new hint in while the old
   *  one is still being read. Q-A commentary itself is NOT gated by
   *  this (it has its own minMs drop-on-overlap mechanism), but Q-A
   *  DOES update these fields so subsequent hints/warmups respect the
   *  time the user needs to absorb a Q-A observation. */
  private lastCommentaryReadyAt = 0;
  private lastCommentaryText = "";
  /** Buffer size when the last listening-hint fired. Re-firing requires
   *  buffer to grow by LISTENING_HINT_TRIGGER_CHARS beyond THIS size, so
   *  the cooldown isn't the only gate — genuinely new monologue content
   *  is needed. Otherwise a 500-char buffer would re-fire hints every
   *  20s even if the interviewer said nothing more. */
  private lastListeningHintBufferSize = 0;
  private pendingCommentaryFor: string | null = null;
  private lastCommentAt: Map<string, number> = new Map();
  /** Count of commentary emitted per question. Used to escalate the
   *  char trigger threshold (1st easy, later ones harder) and cap at a
   *  max so no single Q drowns in commentary. */
  private commentCountPerQ: Map<string, number> = new Map();
  private recentTranscript = "";

  /** === Question-lock multi-signal filter state ===
   *
   *  When classifier says "question_finalized" we don't commit it to UI
   *  immediately. Four layers of validation run first:
   *    Layer 1: text grounding  — Q text must be in recent transcript
   *    Layer 2: parallel confirm — /api/classify-moment mode=confirm vote
   *    Layer 3: continuation gate — wait 3s to see if interviewer
   *             keeps talking (real question → silence for the answer)
   *    Layer 4: commentary drift detection — built into the Commentary
   *             prompt, not here
   *
   *  `pendingLead` holds the proposed Lead while we wait for Layer 3's
   *  timer. If a new interviewer utterance arrives during that 3s
   *  window, the pending is discarded and the classifier gets another
   *  shot on the next debounce. */
  private pendingLead:
    | {
        text: string;
        summary: string;
        rel: QuestionRelation;
        committedAt: number; // Date.now() when pending was set
        timer: ReturnType<typeof setTimeout> | null;
      }
    | null = null;

  /** Recently-rejected Q proposals. The classifier hallucinates the
   *  same non-existent question over and over (e.g. proposes "Tell me
   *  about yourself" 6 times in a row when the interviewer never said
   *  it). We cache the normalized text of anything that fails Layer 1
   *  or Layer 2 and short-circuit future proposals that match, to stop
   *  burning API budget on the same hallucination. Cleared whenever a
   *  Lead actually locks (the session has moved on, old rejections
   *  become irrelevant). */
  private rejectedQTexts: Set<string> = new Set();

  /** Timestamp + text of the most-recently-committed Lead or Probe.
   *  Used to reject near-duplicate proposals: the classifier sometimes
   *  emits a Q, we commit it, and 3 seconds later it emits the SAME Q
   *  with slightly different wording ("Can you speak a little bit…"
   *  vs "Can you speak a bit…"). The strict-equality dedupe check
   *  in applyMoment treats those as different and commits both —
   *  producing a duplicate Lead / Probe. Within a short cooldown we
   *  do token-level similarity checking and drop the restatement. */
  private lastLeadCommitAt = 0;
  private lastCommittedQText = "";

  /** Hysteresis state for non-question moment transitions. A single
   *  classify call proposing a new state (e.g. chitchat → interviewer_
   *  speaking) used to commit immediately, which caused the UI phase
   *  to flap rapidly when the classifier wobbled on ambiguous
   *  utterances. We now require 2 consecutive same-direction votes
   *  before committing. question_finalized bypasses this because it
   *  has its own dedicated 4-layer filter. */
  private momentHysteresisPending: {
    state: MomentStateKind;
    count: number;
  } | null = null;

  private knownDgSpeakers = new Set<number>();
  private identifyInFlight = false;
  private identifyLastUtteranceCount = 0;
  /** Last identify-speakers result. Used to require two consecutive
   *  agreeing runs before we overwrite an existing role assignment —
   *  prevents lane content from flipping when Haiku is borderline and
   *  its answer oscillates between runs. */
  private lastIdentifyResult: Record<number, "interviewer" | "candidate"> = {};
  /** Per-speaker count of consecutive identify runs that agreed with the
   *  CURRENTLY PROPOSED role (`pendingRoles[dg]`). Grows as runs confirm
   *  the label; resets to 1 when a run proposes a different role. When
   *  streak reaches IDENTIFY_CONFIDENCE_THRESHOLD and the pending role
   *  differs from the committed one, we commit (or flip) the role. Live
   *  sessions never hard-lock — identify keeps running periodically so
   *  a wrong early commit can flip back once Haiku sees more context. */
  private roleAgreementStreak: Record<number, number> = {};
  /** Per-speaker role PROPOSED by the most recent identify run —
   *  provisional, not yet committed to the store. Committing waits
   *  until the same role has been proposed IDENTIFY_CONFIDENCE_THRESHOLD
   *  runs in a row, so a noisy early guess doesn't immediately light up
   *  the UI with the wrong labels. */
  private pendingRoles: Record<number, "interviewer" | "candidate"> = {};
  /** True once upload-mode pre-identify has successfully seeded roles
   *  from the full transcript. When set, the in-session refresh loop
   *  treats streak-at-threshold alone as sufficient to lock (bypassing
   *  the min-utterances requirement) — the pre-identify result was
   *  drawn from the whole recording and is strictly better than any
   *  rolling-window re-evaluation could be. */
  private preIdentified = false;
  /** True when this session is playing back an uploaded recording AND
   *  a full coaching timeline has been pre-computed. In that case the
   *  orchestrator SKIPS its in-session classify-moment / commentary /
   *  listening-hint work — the UI reads those directly from the
   *  timeline indexed by the current playback time. Utterances still
   *  flow into the captions path so the caption lanes render. */
  private usingTimeline = false;

  private lastDgSpeaker: number | undefined;
  private lastTranscriptAt = 0;
  private classifyDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private classifyInFlight = false;

  // === Closing-detection (interview-end) state ===
  // When the classifier flips moment state to "closing" (mutual goodbye
  // / "thanks for your time" / "we'll be in touch"), we arm a 3s
  // silence timer. If no substantive utterance (>10 chars) lands within
  // that window, the interview is genuinely over — fire `ic:closing-
  // detected` so the UI can prompt "Save now?". User-side outcomes:
  //   - "Save & view scoring" → normal End & Save flow
  //   - "Continue recording"  → call `disableClosingDetection()` so we
  //     never fire again this session (prevents annoyance loops where
  //     the classifier keeps flapping in and out of closing).
  // Single-shot per session: once fired (or once the user dismissed),
  // `closingDetectionDisabled` flips true and stays that way.
  private closingSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private closingDetectionDisabled = false;
  private closingDetectionFired = false;
  /** ms; tunable via the user spec ("3-second silence after closing"). */
  private static CLOSING_SILENCE_MS = 3000;
  /** ms; minimum utterance length that counts as "they're still talking,
   *  cancel the closing timer". Filler like "yeah" / "ok" doesn't count. */
  private static CLOSING_UTTERANCE_MIN_CHARS = 10;

  async start(
    options: { captureTabAudio?: "auto" | "on" | "off" } = {}
  ) {
    if (this.audio) return;
    resetClientLog();
    log("session", "start", {
      mode: "live",
      captureTabAudio: options.captureTabAudio ?? "auto",
    });
    this.resetSessionState();
    this.audio = new AudioSession(this.makeCallbacks(), {
      captureTabAudio: options.captureTabAudio ?? "auto",
    });
    await this.audio.start();
  }

  /** Start a playback-driven session using an uploaded audio file. Uses
   *  the same classify/commentary pipeline — only the transcript source
   *  differs. Utterances must come pre-transcribed from
   *  /api/transcribe-file.
   *
   *  Upload mode has the full transcript up front, so we can identify
   *  who's the interviewer vs. the candidate BEFORE playback begins
   *  (using samples drawn from across the whole recording, not just the
   *  first few pleasantries). The captions then render with correct
   *  role labels from utterance #1 instead of churning through the
   *  in-session refresh loop. */
  async startWithFile(file: File, utterances: TranscribedUtterance[]) {
    if (this.audio) return;
    resetClientLog();
    log("session", "start", {
      mode: "upload",
      fileName: file.name,
      utterances: utterances.length,
    });
    this.resetSessionState();
    const store = useStore.getState();
    const setStage = store.setLiveProcessingStage;

    setStage("identifying");
    await this.preIdentifyRolesFromFullTranscript(utterances);

    // Pre-load EVERY utterance into the store with its timestamps. The
    // live-view captions component indexes these by the current
    // playback time, so scrubbing anywhere shows the right captions
    // immediately without any real-time emission.
    const preloaded: Utterance[] = utterances.map((u, i) => ({
      id: `u-upload-${i}`,
      dgSpeaker: u.speaker,
      text: u.text,
      atSeconds: u.start,
      duration: u.duration,
    }));
    store.replaceLiveUtterances(preloaded);
    // Signal to the in-session pipeline to stay out of the way — utterances
    // are already populated; we don't want classify-moment / commentary /
    // listening-hint triggers running during playback.
    this.usingTimeline = true;
    // Tell the UI we're in upload-mode playback so it mounts the
    // scrubber, the ReviewPanel, and time-indexed captions.
    store.setLiveIsUploadMode(true);

    // Round 2+3+4: extract Interview Phases + Questions, then Live
    // Commentary, then a self-review pass that reconciles all three
    // artifacts against the transcript and corrects anything that
    // doesn't hold up. Listening hints come in a later round.
    setStage("analyzing");
    console.log("[orchestrator] → extractPhasesAndQuestions");
    const extracted = await this.extractPhasesAndQuestions(utterances);
    console.log(
      `[orchestrator] ← extractPhasesAndQuestions: questions=${extracted?.questions.length ?? 0}`
    );
    if (extracted && extracted.questions.length > 0) {
      console.log(
        `[orchestrator] → extractCommentary (${extracted.questions.length} questions)`
      );
      await this.extractCommentary(utterances, extracted.questions);
      console.log("[orchestrator] ← extractCommentary done");
    } else {
      console.warn(
        "[orchestrator] SKIPPING extractCommentary — 0 questions extracted"
      );
    }
    // Listening hints — fired whenever the interviewer monologues
    // substantively. Independent of question extraction, so we run it
    // even when no questions were found (pure-context recording edge case).
    console.log("[orchestrator] → extractListeningHints");
    await this.extractListeningHints(utterances);
    console.log("[orchestrator] ← extractListeningHints done");
    // Review pass removed: Opus 4.7's first-pass output is good enough
    // that the second-pass semantic check wasn't earning the ~60-90s of
    // latency + the extra token cost. Re-enable if we see systematic
    // miscategorizations again.
    setStage("ready");

    // PlaybackSession plays audio but does NOT re-emit utterances (we've
    // already pre-loaded them) — keeps captions from duplicating.
    this.audio = new PlaybackSession(
      file,
      utterances,
      this.makeCallbacks(),
      { skipEmit: true }
    );
    await this.audio.start();
  }

  /**
   * Round-2 helper: calls /api/extract-phases-questions with the full
   * transcript (roles + timestamps), seeds the resulting questions and
   * phases into the store so the LiveView renders phase chip + current
   * Lead/Probe from playbackTime.
   *
   * Non-fatal: on failure, timeline stays null and the UI falls back to
   * placeholder states for phase/questions (captions still work).
   */
  private async extractPhasesAndQuestions(
    utterances: TranscribedUtterance[]
  ): Promise<{
    questions: Array<{
      id: string;
      text: string;
      parentId?: string;
      askedAtSec: number;
    }>;
  } | null> {
    const store = useStore.getState();
    const roles = store.liveSpeakerRoles;
    const forApi = utterances.map((u) => {
      const role =
        u.speaker !== undefined && roles[u.speaker] === "interviewer"
          ? "interviewer"
          : u.speaker !== undefined && roles[u.speaker] === "candidate"
          ? "candidate"
          : "unknown";
      return {
        role: role as "interviewer" | "candidate" | "unknown",
        text: u.text,
        start: u.start,
        end: u.end,
      };
    });

    try {
      const resp = await fetch("/api/extract-phases-questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd: store.liveJd,
          resume: store.liveResume,
          lang: store.commentLang,
          utterances: forApi,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`extract ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = (await resp.json()) as {
        questions?: Array<{
          id: string;
          text: string;
          parentId?: string;
          askedAtSec: number;
        }>;
        phases?: Array<{
          fromSec: number;
          kind: string;
          questionId?: string;
        }>;
      };

      const questions = data.questions ?? [];
      const phases = data.phases ?? [];

      // Seed liveQuestions so the rest of the app (Past Sessions
      // rendering, scoring) sees questions as it would for a live
      // session. Commentary is seeded separately by extractCommentary.
      for (const q of questions) {
        store.addQuestion({
          id: q.id,
          text: q.text,
          askedAtSeconds: q.askedAtSec,
          comments: [],
          parentQuestionId: q.parentId ?? undefined,
        });
      }

      // Set the timeline with phases + questions. commentary + hints
      // start empty; extractCommentary fills the commentary field next.
      store.setLiveTimeline({
        questions,
        commentary: [],
        listeningHints: [],
        phases: phases.map((p) => ({
          fromSec: p.fromSec,
          kind: p.kind as
            | "chitchat"
            | "interviewer_asking_first"
            | "interviewer_probing"
            | "candidate_answering"
            | "between_questions",
          questionId: p.questionId,
        })),
      });

      return { questions };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      window.dispatchEvent(
        new CustomEvent("ic:error", {
          detail: `Phase/question extraction failed (${msg}). Captions still work, but the phase chip and current question won't populate.`,
        })
      );
      return null;
    }
  }

  /**
   * Round-3 helper: takes the questions extracted from round 2 and
   * produces Live Commentary entries anchored to specific moments of
   * the recording. Seeds results into both `liveTimeline.commentary`
   * (so the LiveView shows the right comment at the right playback
   * time) AND each corresponding `liveQuestions.comments[]` (so Past
   * Sessions renders the same commentary and scoring has material).
   *
   * Non-fatal: a failure here doesn't break playback — the commentary
   * pane just stays empty for the session.
   */
  private async extractCommentary(
    utterances: TranscribedUtterance[],
    questions: Array<{
      id: string;
      text: string;
      parentId?: string;
      askedAtSec: number;
    }>
  ) {
    console.log(
      `[extract-commentary client] entering: ${utterances.length} utterances, ${questions.length} questions — ids: ${questions.map((q) => q.id).join(",")}`
    );
    const store = useStore.getState();
    const roles = store.liveSpeakerRoles;
    const forApi = utterances.map((u) => {
      const role =
        u.speaker !== undefined && roles[u.speaker] === "interviewer"
          ? "interviewer"
          : u.speaker !== undefined && roles[u.speaker] === "candidate"
          ? "candidate"
          : "unknown";
      return {
        role: role as "interviewer" | "candidate" | "unknown",
        text: u.text,
        start: u.start,
        end: u.end,
      };
    });

    try {
      const resp = await fetch("/api/extract-commentary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd: store.liveJd,
          resume: store.liveResume,
          lang: store.commentLang,
          utterances: forApi,
          questions,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`extract-commentary ${resp.status}: ${text.slice(0, 200)}`);
      }
      const data = (await resp.json()) as {
        commentary?: Array<{
          id: string;
          questionId: string;
          atSec: number;
          text: string;
        }>;
      };
      const commentary = data.commentary ?? [];
      console.log(
        `[extract-commentary client] received ${commentary.length} commentary entries`
      );
      if (commentary.length === 0) {
        window.dispatchEvent(
          new CustomEvent("ic:error", {
            detail:
              "Commentary extraction returned 0 entries. Check server logs for the reason.",
          })
        );
        return;
      }

      // Merge into the existing timeline — we already seeded phases +
      // questions above; just patch the commentary field in place.
      const current = useStore.getState().liveTimeline;
      if (current) {
        useStore.getState().setLiveTimeline({
          ...current,
          commentary,
        });
        console.log(
          `[extract-commentary client] patched timeline.commentary (${commentary.length} entries)`
        );
      } else {
        console.warn(
          "[extract-commentary client] liveTimeline is null — can't patch commentary in"
        );
      }

      // Attach each comment to its question so Past Sessions + scoring
      // see it. addCommentToQuestion is additive; questions were seeded
      // with empty comments arrays in round 2.
      for (const c of commentary) {
        store.addCommentToQuestion(c.questionId, {
          id: c.id,
          text: c.text,
          atSeconds: c.atSec,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      window.dispatchEvent(
        new CustomEvent("ic:error", {
          detail: `Commentary extraction failed (${msg}). Phases + questions still work.`,
        })
      );
    }
  }

  /**
   * Companion to extractCommentary. Produces listening hints for the
   * uploaded recording — coaching notes that fire when the interviewer
   * monologues (describing team, setup, case context). Mirrors the
   * live-mode mode:"listening" flow so recorded review has parity.
   *
   * Non-fatal: if the call fails, `liveTimeline.listeningHints` stays
   * empty and the UI just won't show amber hint cards.
   */
  private async extractListeningHints(utterances: TranscribedUtterance[]) {
    const store = useStore.getState();
    const roles = store.liveSpeakerRoles;
    const forApi = utterances.map((u) => {
      const role =
        u.speaker !== undefined && roles[u.speaker] === "interviewer"
          ? "interviewer"
          : u.speaker !== undefined && roles[u.speaker] === "candidate"
          ? "candidate"
          : "unknown";
      return {
        role: role as "interviewer" | "candidate" | "unknown",
        text: u.text,
        start: u.start,
        end: u.end,
      };
    });

    try {
      const resp = await fetch("/api/extract-listening-hints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd: store.liveJd,
          resume: store.liveResume,
          lang: store.commentLang,
          utterances: forApi,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `extract-listening-hints ${resp.status}: ${text.slice(0, 200)}`
        );
      }
      const data = (await resp.json()) as {
        listeningHints?: Array<{
          id: string;
          atSec: number;
          text: string;
        }>;
      };
      const hints = data.listeningHints ?? [];
      console.log(
        `[extract-listening-hints client] received ${hints.length} hints`
      );
      if (hints.length === 0) return; // no monologues worth hinting; fine.

      // Patch into the existing timeline. Questions + phases + commentary
      // were seeded earlier in this session; this just fills the
      // listeningHints slot.
      const current = useStore.getState().liveTimeline;
      if (current) {
        useStore.getState().setLiveTimeline({
          ...current,
          listeningHints: hints,
        });
      } else {
        console.warn(
          "[extract-listening-hints client] liveTimeline null — seeding minimal timeline"
        );
        useStore.getState().setLiveTimeline({
          questions: [],
          commentary: [],
          phases: [],
          listeningHints: hints,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown";
      window.dispatchEvent(
        new CustomEvent("ic:error", {
          detail: `Listening-hints extraction failed (${msg}). Other commentary still works.`,
        })
      );
    }
  }

  /**
   * Pre-analysis for upload mode. One Sonnet call against the full
   * transcript — produces a structured timeline of questions,
   * commentary, listening hints, and phase segments. Stored on the store
   * and used by the LiveView to render correct state at any playback
   * position including after seeks.
   *
   * On failure, we fall through: `usingTimeline` stays false, the
   * in-session pipeline takes over as normal.
   */
  private async preAnalyzeRecording(utterances: TranscribedUtterance[]) {
    const store = useStore.getState();
    const roles = store.liveSpeakerRoles;

    // Map dgSpeaker → role label for the preanalyze API. Unknown speakers
    // are sent as "unknown" rather than dropped — the model can still
    // reason about the transcript structure from text alone.
    const forApi = utterances.map((u) => {
      const role =
        u.speaker !== undefined && roles[u.speaker] === "interviewer"
          ? "interviewer"
          : u.speaker !== undefined && roles[u.speaker] === "candidate"
          ? "candidate"
          : "unknown";
      return {
        role: role as "interviewer" | "candidate" | "unknown",
        text: u.text,
        start: u.start,
        end: u.end,
      };
    });

    try {
      const resp = await fetch("/api/preanalyze-recording", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jd: store.liveJd,
          resume: store.liveResume,
          lang: store.commentLang,
          utterances: forApi,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`preanalyze ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = (await resp.json()) as {
        timeline?: {
          questions: Array<{
            id: string;
            text: string;
            parentId?: string;
            askedAtSec: number;
          }>;
          commentary: Array<{
            id: string;
            questionId: string;
            atSec: number;
            text: string;
          }>;
          listeningHints: Array<{ id: string; atSec: number; text: string }>;
          phases: Array<{
            fromSec: number;
            kind: string;
            questionId?: string;
          }>;
        };
      };
      if (!data.timeline) return;

      // Seed liveQuestions with timeline questions so ArchivedMainBlock,
      // scoring (which reads liveQuestions), and past-session rendering
      // all work the same way they do for live sessions.
      const questionComments = new Map<string, typeof data.timeline.commentary>();
      for (const c of data.timeline.commentary) {
        const list = questionComments.get(c.questionId) ?? [];
        list.push(c);
        questionComments.set(c.questionId, list);
      }
      for (const q of data.timeline.questions) {
        const comments = (questionComments.get(q.id) ?? [])
          .slice()
          .sort((a, b) => a.atSec - b.atSec)
          .map((c) => ({ id: c.id, text: c.text, atSeconds: c.atSec }));
        store.addQuestion({
          id: q.id,
          text: q.text,
          askedAtSeconds: q.askedAtSec,
          comments,
          parentQuestionId: q.parentId ?? undefined,
        });
      }

      // Store the full timeline for the live view to index into.
      store.setLiveTimeline({
        questions: data.timeline.questions,
        commentary: data.timeline.commentary,
        listeningHints: data.timeline.listeningHints,
        phases: data.timeline.phases.map((p) => ({
          fromSec: p.fromSec,
          kind: p.kind as
            | "chitchat"
            | "interviewer_asking_first"
            | "interviewer_probing"
            | "candidate_answering"
            | "between_questions",
          questionId: p.questionId,
        })),
      });
      this.usingTimeline = true;
    } catch (e) {
      // Non-fatal — but the user deserves to know: without the timeline,
      // commentary/listening-hints/phases won't pre-populate, and
      // scrubbing backward shows stale UI state. Let the session
      // continue with in-session processing as a graceful fallback.
      const msg = e instanceof Error ? e.message : "unknown";
      window.dispatchEvent(
        new CustomEvent("ic:error", {
          detail: `Pre-analysis failed (${msg}). Commentary will build up as the recording plays.`,
        })
      );
    }
  }

  /**
   * Called once at the start of an upload-mode session. Runs
   * identify-speakers against a BALANCED sample drawn from the whole
   * transcript — preamble + middle + late Q&A — so Haiku sees the real
   * interviewer/candidate dynamic, not just the "interviewer sells the
   * role" opening that throws off rolling-window identification. Seeds
   * the store roles AND pre-fills the per-speaker streak counters at
   * the stability threshold, so the in-session refresh loop trusts this
   * result and doesn't start second-guessing it mid-playback.
   *
   * Non-fatal on any failure: if the call doesn't succeed (network,
   * missing key, thin transcript), we just fall through and the
   * in-session identify loop takes over as usual.
   */
  private async preIdentifyRolesFromFullTranscript(
    utterances: TranscribedUtterance[]
  ) {
    const bySpeaker = new Map<number, string[]>();
    for (const u of utterances) {
      if (typeof u.speaker !== "number") continue;
      const list = bySpeaker.get(u.speaker) ?? [];
      list.push(u.text);
      bySpeaker.set(u.speaker, list);
    }
    if (bySpeaker.size < 2) return; // nothing to disambiguate

    // Budget ~50 total utterances sent to Haiku — plenty of context,
    // well inside token limits. Distribute evenly across speakers and
    // across time within each speaker's turns.
    const BUDGET = 50;
    const perSpeaker = Math.max(1, Math.floor(BUDGET / bySpeaker.size));
    const sample: Array<{ speaker: number; text: string }> = [];
    for (const [dg, list] of bySpeaker.entries()) {
      // Spread picks uniformly across this speaker's turns — opening,
      // middle, late — so the preamble isn't over-weighted.
      if (list.length <= perSpeaker) {
        for (const text of list) sample.push({ speaker: dg, text });
      } else {
        const step = list.length / perSpeaker;
        for (let i = 0; i < perSpeaker; i++) {
          sample.push({ speaker: dg, text: list[Math.floor(i * step)] });
        }
      }
    }

    try {
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
      if (Object.keys(numKeyed).length === 0) return;

      // Seed the store so captions render with the right labels from
      // utterance #1. Also flag the session as preIdentified so the
      // in-session identify loop doesn't second-guess this call (upload
      // mode got to inspect the full transcript — any in-session
      // review would see strictly less context).
      useStore.getState().mergeSpeakerRoles(numKeyed);
      this.lastIdentifyResult = numKeyed;
      this.pendingRoles = { ...numKeyed };
      // Seed the streak high enough that the first in-session run
      // (which shouldn't happen for upload, but if it somehow did) won't
      // invalidate this result on a single dissent.
      for (const n of Object.keys(numKeyed).map(Number)) {
        this.roleAgreementStreak[n] = IDENTIFY_CONFIDENCE_THRESHOLD;
      }
      this.preIdentified = true;
    } catch {
      /* non-fatal — fall through to in-session identify */
    }
  }

  private resetSessionState() {
    this.knownDgSpeakers.clear();
    this.identifyInFlight = false;
    this.identifyLastUtteranceCount = 0;
    this.lastIdentifyResult = {};
    this.roleAgreementStreak = {};
    this.pendingRoles = {};
    this.preIdentified = false;
    this.lastDgSpeaker = undefined;
    this.lastTranscriptAt = 0;
    this.classifyInFlight = false;
    this.answerBuffer = "";
    this.pendingAnswerBuffer = "";
    this.dialogueBuffer = [];
    this.interviewerMonologueBuffer = "";
    this.lastListeningHintBufferSize = 0;
    this.pendingListeningHint = false;
    this.lastListeningHintAt = 0;
    this.candidateWarmupBuffer = "";
    this.lastWarmupBufferSize = 0;
    this.pendingWarmupCommentary = false;
    this.lastWarmupCommentAt = 0;
    this.lastCommentaryReadyAt = 0;
    this.lastCommentaryText = "";
    this.pendingCommentaryFor = null;
    // Abort any in-flight Lead validation from the previous session.
    if (this.pendingLead?.timer) clearTimeout(this.pendingLead.timer);
    this.pendingLead = null;
    this.rejectedQTexts.clear();
    this.lastLeadCommitAt = 0;
    this.lastCommittedQText = "";
    this.momentHysteresisPending = null;
    this.lastCommentAt.clear();
    this.commentCountPerQ.clear();
    this.usingTimeline = false;
  }

  private makeCallbacks() {
    return {
      onInterimTranscript: (text: string) => {
        window.dispatchEvent(new CustomEvent("ic:interim", { detail: text }));
      },
      onFinalTranscript: (text: string, speaker?: number, duration?: number) =>
        this.onUtterance(text, speaker, duration),
      onAudioReady: (audioUrl: string) => {
        (window as unknown as { __ic_audioUrl?: string }).__ic_audioUrl = audioUrl;
      },
      onError: (msg: string) => {
        window.dispatchEvent(new CustomEvent("ic:error", { detail: msg }));
        useStore.getState().setLiveStatus("idle");
      },
      onPlaybackEnded: () => {
        // Forwarded to the page as a distinct event so it can show a
        // "recording complete — view scoring" toast without coupling UI
        // code to the session class.
        window.dispatchEvent(new CustomEvent("ic:playback-ended"));
      },
    };
  }

  /** Playback-only hook. Pushes every remaining utterance into the
   *  orchestrator right now, regardless of where audio playback is.
   *  Called before End & Save so scoring sees the full transcript even
   *  if the user stopped playback early. No-op for live mic sessions. */
  flushBeforeEnd() {
    if (this.audio instanceof PlaybackSession) {
      this.audio.flushAllRemaining();
    }
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
    log("session", "stop");
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

    // Closing-silence timer: any substantive (≥10 char) utterance means
    // the interview isn't over after all — cancel the pending prompt.
    // Filler ("yeah", "ok", "thanks") under 10 chars doesn't count.
    if (
      this.closingSilenceTimer &&
      clean.length >= LiveOrchestrator.CLOSING_UTTERANCE_MIN_CHARS
    ) {
      this.cancelClosingSilenceTimer("substantive-utterance");
    }

    {
      const state = useStore.getState();
      state.addUtterance({
        id: rand("u"),
        dgSpeaker,
        text: clean,
        atSeconds: state.live.elapsedSeconds,
        duration,
      });
      // Debug log: every utterance we receive from Deepgram, with its
      // raw speaker number + role (if already assigned) + text preview.
      const role =
        dgSpeaker !== undefined
          ? state.liveSpeakerRoles[dgSpeaker]
          : undefined;
      log("utterance", "new", {
        dg: dgSpeaker,
        role: role ?? "?",
        text: preview(clean, 100),
      });
    }

    // ===== LIVE-MODE MANUAL SPEAKER ASSIGNMENT =====
    // Replaces the Haiku identify-speakers flow entirely for live mic
    // sessions. When a new dgSpeaker appears:
    //   (a) if another dgSpeaker already has a role committed, auto-
    //       assign the OPPOSITE role to this new one. Interviews are
    //       two-person by default, so one manual assignment fully
    //       disambiguates the pair.
    //   (b) otherwise, surface a manual-assignment prompt to the user
    //       (stored as `liveSpeakerPrompt`; rendered by the UI as a
    //       floating card). Commentary / questions remain gated until
    //       the user resolves the prompt.
    // No periodic review / no Haiku-based second-guessing — user input
    // is treated as source of truth. Upload mode keeps its own
    // preIdentify path (unchanged by this block).
    if (dgSpeaker !== undefined && !this.preIdentified) {
      this.knownDgSpeakers.add(dgSpeaker);
      const state = useStore.getState();
      const committedRoles = state.liveSpeakerRoles;
      const myRole = committedRoles[dgSpeaker];

      if (myRole === undefined) {
        const otherValues = Object.values(committedRoles);
        const hasInterviewer = otherValues.includes("interviewer");
        const hasCandidate = otherValues.includes("candidate");

        if (hasInterviewer && !hasCandidate) {
          // Partner is interviewer — this speaker is the candidate.
          state.mergeSpeakerRoles({ [dgSpeaker]: "candidate" });
          log("roles", "auto", { dg: dgSpeaker, role: "candidate" });
        } else if (hasCandidate && !hasInterviewer) {
          // Partner is candidate — this speaker is the interviewer.
          state.mergeSpeakerRoles({ [dgSpeaker]: "interviewer" });
          log("roles", "auto", { dg: dgSpeaker, role: "interviewer" });
        } else if (hasInterviewer && hasCandidate) {
          // Both sides already have a dg assigned, and yet a NEW dg is
          // speaking. Overwhelmingly this is Deepgram diarization
          // creating a duplicate speaker ID for the SAME person whose
          // voice drifted slightly — most often the candidate (one
          // voice, shifting mic position, emotional state). Rather
          // than interrupting the user with another popup, silently
          // merge the new dg into the candidate role. If it genuinely
          // is a third person (rare — colleague joining late), the
          // user will see it in captions and can correct manually via
          // a future UI. Default-to-candidate minimizes friction in
          // the common case.
          state.mergeSpeakerRoles({ [dgSpeaker]: "candidate" });
          log("roles", "auto-dup", {
            dg: dgSpeaker,
            role: "candidate",
            note: "both-filled-assumed-candidate-dup",
          });
        } else if (!state.liveSpeakerPrompt) {
          // No role known yet (first speaker of session). Ask the user.
          // Only open one prompt at a time; if a prompt is already
          // pending we wait for them to resolve it before opening
          // another.
          state.setLiveSpeakerPrompt({
            dgSpeaker,
            sampleText: clean,
          });
          log("roles", "prompt", {
            dg: dgSpeaker,
            sample: preview(clean, 60),
          });
        }
      }
    }

    this.lastTranscriptAt = Date.now();
    // Short-circuit: when a pre-computed timeline is driving the UI
    // (upload mode with successful preanalyze), skip classify-moment +
    // commentary + hint triggers entirely. Utterances still landed in
    // liveUtterances above — that's all we need for the captions path.
    if (this.usingTimeline) return;
    // LIVE-MODE GATE: don't classify moments or fire commentary until
    // both interviewer AND candidate roles have been confidently
    // identified. Without this, we'd run classify-moment with "Speaker
    // 1 / 2" labels and produce garbage state, or worse, kick off
    // commentary labeled with a wrong role. Captions still show
    // (utterances were added to liveUtterances above), but the phase
    // chip / Lead-Question panel / commentary all stay in "identifying
    // speakers" mode until we're sure who's who.
    if (!rolesAreConfirmed(useStore.getState().liveSpeakerRoles)) {
      this.lastTranscriptAt = Date.now();
      return;
    }
    this.armSilenceTimer();
    if (dgSpeaker !== undefined && dgSpeaker !== this.lastDgSpeaker) {
      this.lastDgSpeaker = dgSpeaker;
      this.scheduleClassifyMoment();
    }

    const role =
      dgSpeaker !== undefined
        ? useStore.getState().liveSpeakerRoles[dgSpeaker]
        : undefined;

    // Layer 3 of the question-lock filter: if the interviewer is still
    // talking while we have a pending Lead being validated, the
    // proposed Q clearly wasn't the FINAL word — discard and let the
    // next classify pass take another shot.
    if (role === "interviewer" && this.pendingLead) {
      this.cancelPendingOnInterviewerTurn();
    }

    const momentState = useStore.getState().liveMomentState.state;

    // Track the back-and-forth during the current question for commentary
    // context — includes INTERVIEWER utterances (backchannel reactions
    // like "huh", "interesting", "great", laughs, follow-up nudges) that
    // otherwise never reach /api/commentary. Without this, commentary
    // judges the answer in a vacuum and misses human-dynamics signals.
    //
    // Short (<10 chars) utterances are Deepgram diarization artifacts
    // ~half the time: a tiny interjection that actually came from the
    // interviewer gets mis-tagged as the candidate (or vice versa),
    // polluting the dialogue sample fed to commentary. Real meaningful
    // backchannels ("interesting", "right", "got it") are 7+ chars and
    // still get through. We drop the noise below that floor to keep the
    // commentary prompt clean.
    const DIALOGUE_MIN_CHARS = 10;
    if (
      (momentState === "question_finalized" ||
        momentState === "candidate_questioning") &&
      (role === "candidate" || role === "interviewer") &&
      clean.length >= DIALOGUE_MIN_CHARS
    ) {
      // Both states benefit from running dialogue context:
      //   - question_finalized: commentary judges how the answer is
      //     landing; interviewer reactions are part of that signal.
      //   - candidate_questioning: commentary judges question quality
      //     and references what was discussed earlier; the interviewer
      //     answering the candidate's question is also useful context.
      this.dialogueBuffer.push({ speaker: role, text: clean });
      // Cap to keep prompt latency reasonable — last 30 turns is plenty
      // for commentary to read the room.
      if (this.dialogueBuffer.length > 30) {
        this.dialogueBuffer = this.dialogueBuffer.slice(-30);
      }
    }

    // Listening-hint buffer: accumulate ANY interviewer utterance,
    // independent of momentState. The classifier frequently wobbles
    // between "interviewer_speaking" and "chitchat" mid-monologue —
    // especially for long setups that look conversational — which
    // used to drop interviewer utterances on the floor and prevent
    // the buffer from ever crossing the 400-char trigger. By keying
    // purely on role, the buffer reflects what actually happened
    // (who spoke, in what order) rather than the classifier's label.
    //
    // The buffer is drained at question-finalization (see
    // applyMoment's pre-anchored question_finalized branch,
    // addFollowUpAndStart, archiveCurrentMainAndStartNew), which is
    // the RIGHT semantic boundary — a monologue ends when a concrete
    // question emerges. We also reset on a substantive candidate
    // utterance (≥ 40 chars) so a real handoff doesn't let a stale
    // pre-candidate monologue keep triggering hints.
    if (role === "interviewer") {
      this.interviewerMonologueBuffer +=
        (this.interviewerMonologueBuffer ? " " : "") + clean;
      if (this.shouldTriggerListeningHint()) {
        void this.generateListeningHint();
      }
    } else if (role === "candidate" && clean.length >= 40) {
      // Candidate actually took the floor — discard whatever
      // setup the interviewer was building. Short backchannels
      // ("mhm", "yeah", "right") under 40 chars don't count.
      this.interviewerMonologueBuffer = "";
      this.lastListeningHintBufferSize = 0;
    }

    if (role !== "candidate") return;

    const liveState = useStore.getState().live;
    const hasLockedQ = !!liveState.currentQuestionId;

    if (momentState === "question_finalized" && hasLockedQ) {
      const {
        liveQuestions,
        live,
        setAnswerInProgress,
        appendCandidateAnswerText,
      } = useStore.getState();
      this.answerBuffer += (this.answerBuffer ? " " : "") + clean;
      // Persist the candidate utterance onto the locked question's
      // `answerText` IMMEDIATELY. We can't rely on bucketing
      // `liveUtterances` at endLive — that array is a rolling 30-entry
      // window for the captions UI and gets evicted long before a
      // 20+ minute session ends. By appending here we ensure the full
      // per-question answer text survives onto the Question object,
      // which is what scoring reads.
      appendCandidateAnswerText(live.currentQuestionId!, clean);
      setAnswerInProgress(true);
      if (this.shouldTriggerComment(live.currentQuestionId!)) {
        const currentQ = liveQuestions.find((q) => q.id === live.currentQuestionId);
        if (currentQ) void this.generateComment(currentQ);
      }
    } else if (momentState === "interviewer_speaking") {
      this.pendingAnswerBuffer +=
        (this.pendingAnswerBuffer ? " " : "") + clean;
    }

    // === Warm-up commentary trigger ===
    // Candidate is speaking and NO Lead Question has been locked yet.
    // Typically the self-introduction phase after the interviewer's
    // opening background talk. Accumulate their text and coach on how
    // they're presenting themselves, independent of any Q-A pair.
    if (!hasLockedQ) {
      this.candidateWarmupBuffer +=
        (this.candidateWarmupBuffer ? " " : "") + clean;
      if (this.shouldTriggerWarmupCommentary()) {
        void this.generateWarmupCommentary();
      }
    }
  }

  /** Compute how long a piece of commentary should stay on screen
   *  before the next one of its kind (or the next hint/warmup) is
   *  allowed to replace it. Based on a typical mixed-language reading
   *  pace + a baseline reaction window.
   *
   *  Speed: ~8 chars/sec. Blended estimate for bilingual coaching text
   *  with embedded English technical terms — English is faster per-char
   *  but Chinese packs more meaning per char, and context-switching
   *  between scripts costs time. Conservative on the slow side.
   *
   *  Baseline: +3 seconds for the eye to find the new text, parse its
   *  structure, and decide whether it's actionable. Below this even a
   *  one-word hint would blink past.
   *
   *  Cap: 20 seconds. In practice the cap was hitting on nearly every
   *  piece of commentary (200+ chars → raw formula yields 28s+), which
   *  suppressed most new coaching content when the interviewer started
   *  a fresh monologue. 20s keeps hints flowing at a pace that matches
   *  the interview cadence while still giving the reader enough time
   *  for the gist of anything reasonably short.
   */
  private computeReadingTimeMs(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    const BASE_MS = 3000;
    const CHARS_PER_SEC = 8;
    const textMs = Math.round((trimmed.length / CHARS_PER_SEC) * 1000);
    return Math.min(20000, BASE_MS + textMs);
  }

  /** True when the previously-displayed commentary still needs time to
   *  be read. Used to gate listening hints + warm-up commentary
   *  generation so a new piece doesn't overwrite something the user is
   *  still absorbing. Q-A commentary is NOT gated on this (see the
   *  note on lastCommentaryText above). */
  private isStillBeingRead(): boolean {
    if (!this.lastCommentaryText) return false;
    const elapsed = Date.now() - this.lastCommentaryReadyAt;
    const required = this.computeReadingTimeMs(this.lastCommentaryText);
    return elapsed < required;
  }

  /** Update the shared reading-protection state. Called at the end of
   *  any commentary stream that actually put content on screen. */
  private markCommentaryDisplayed(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastCommentaryText = trimmed;
    this.lastCommentaryReadyAt = Date.now();
  }

  /** True when we should fire a warm-up commentary generation right now.
   *
   *  Semantic constraint: warm-up is a **one-time phase** at the very
   *  start of a session. Once ANY Lead Question has locked (even if it
   *  later gets archived by a new_topic pivot), we're permanently out
   *  of warm-up — the candidate has entered the Q-A flow. During the
   *  brief "between-questions" gap (previous Lead archived, new Lead
   *  not yet locked), currentQuestionId is null but it's NOT a return
   *  to warm-up, so warm-up commentary must not fire here. */
  private shouldTriggerWarmupCommentary(): boolean {
    if (this.pendingWarmupCommentary) return false;
    // One-time gate: any Lead ever in this session → never fire warm-up again.
    const hasEverHadLead = useStore
      .getState()
      .liveQuestions.some((q) => !q.parentQuestionId);
    if (hasEverHadLead) return false;
    const newChars =
      this.candidateWarmupBuffer.length - this.lastWarmupBufferSize;
    // Log the reading-protection block ONLY when other conditions would
    // otherwise let the fire go through — so we don't spam the log on
    // every utterance arrival.
    if (
      newChars >= WARMUP_COMMENTARY_TRIGGER_CHARS &&
      Date.now() - this.lastWarmupCommentAt >= WARMUP_COMMENTARY_MIN_GAP_MS &&
      this.isStillBeingRead()
    ) {
      const required = this.computeReadingTimeMs(this.lastCommentaryText);
      const elapsed = Date.now() - this.lastCommentaryReadyAt;
      log("read-gate", "hold-wu", {
        elapsedMs: elapsed,
        requiredMs: required,
        prev: preview(this.lastCommentaryText, 60),
      });
      return false;
    }
    if (this.isStillBeingRead()) return false;
    if (newChars < WARMUP_COMMENTARY_TRIGGER_CHARS) return false;
    if (Date.now() - this.lastWarmupCommentAt < WARMUP_COMMENTARY_MIN_GAP_MS)
      return false;
    return true;
  }

  /**
   * Shared SSE streaming helper with exponential-backoff retry.
   *
   * Called by the three commentary generators (Q-A, listening hint,
   * warm-up). Handles the fetch → stream → parse-SSE loop and retries
   * on network errors / 5xx / 429 up to 3 total attempts with
   * 500ms / 1500ms backoffs. The UI's displayed text resets and
   * re-streams on retry — brief flash, but far better than a silently-
   * dropped hint.
   *
   * 4xx (non-429) responses are NOT retried — they're parameter
   * problems that won't succeed on a second try.
   *
   * Returns the fully-accumulated text on success, or null if all
   * attempts failed. `onDelta` is called with the running accumulated
   * string as each chunk arrives; the caller uses it to update the
   * store. `onApiError` is called if the stream itself carries an
   * `{type:"error"}` event (upstream Anthropic error) — embedded
   * errors do NOT trigger retry (the API explicitly declined).
   */
  private async streamCommentarySSE(
    body: unknown,
    onDelta: (accumulated: string) => void,
    kind: "commentary" | "listen-hint" | "warmup-cmt" | "cand-q-cmt",
    onApiError?: (err: string) => void
  ): Promise<string | null> {
    const BACKOFFS_MS = [500, 1500]; // delay before attempt #2 and attempt #3
    const MAX_ATTEMPTS = BACKOFFS_MS.length + 1; // 3
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch("/api/commentary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok || !resp.body) {
          log(kind, "error", { status: resp.status, attempt });
          // Only retry transient failures. 4xx (except 429) won't
          // succeed a second time.
          const retriable =
            resp.status === 429 ||
            (resp.status >= 500 && resp.status < 600);
          if (retriable && attempt < BACKOFFS_MS.length) {
            await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
            continue;
          }
          return null;
        }
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
                onDelta(accumulated);
              } else if (evt.type === "error") {
                const errStr = String(evt.error ?? "");
                onApiError?.(errStr);
                log(kind, "api-err", {
                  err: preview(errStr, 180),
                  attempt,
                });
              }
            } catch {
              /* ignore malformed line */
            }
          }
        }
        return accumulated;
      } catch (e) {
        // Network-level failure (ECONNRESET, abort, DNS). Always
        // retry if we have attempts left — the caller's UI state
        // stays intact during backoff (we don't reset liveListeningHint
        // / displayed comment / etc. here).
        const msg = e instanceof Error ? e.message : String(e);
        log(kind, "net-err", { attempt, err: preview(msg, 120) });
        if (attempt < BACKOFFS_MS.length) {
          await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
          continue;
        }
      }
    }
    return null;
  }

  /** Fire a warm-up commentary call. Streams into `liveWarmupCommentary`
   *  so the Commentary pane can render it while no Lead Q is locked. */
  private async generateWarmupCommentary() {
    this.pendingWarmupCommentary = true;
    const warmupText = this.candidateWarmupBuffer;
    const { liveJd, liveResume, commentLang, setLiveWarmupCommentary } =
      useStore.getState();

    setLiveWarmupCommentary(""); // clear previous — streaming starts fresh
    log("warmup-cmt", "request", {
      bufLen: warmupText.length,
      preview: preview(warmupText, 80),
    });

    try {
      let sawApiError = false;
      const accumulated = await this.streamCommentarySSE(
        {
          jd: liveJd,
          resume: liveResume,
          question: "",
          answer: "",
          mode: "warmup",
          candidateWarmup: warmupText,
          recentDialogue: this.dialogueBuffer.slice(-12),
          lang: commentLang,
        },
        (acc) => useStore.getState().setLiveWarmupCommentary(acc),
        "warmup-cmt",
        () => {
          sawApiError = true;
        }
      );
      this.lastWarmupCommentAt = Date.now();
      // Watermark so next fire needs genuinely new candidate content.
      this.lastWarmupBufferSize = this.candidateWarmupBuffer.length;
      if (accumulated !== null && !sawApiError && accumulated.length > 0) {
        this.markCommentaryDisplayed(accumulated);
        log("warmup-cmt", "done", {
          chars: accumulated.length,
          readMs: this.computeReadingTimeMs(accumulated),
          preview: preview(accumulated, 100),
        });
      }
    } finally {
      this.pendingWarmupCommentary = false;
    }
  }

  /** Fire a candidate-question commentary call. Reverse-Q&A phase: the
   *  candidate is asking the interviewer questions, and we evaluate the
   *  QUALITY of their question (specific vs. generic, ties to what was
   *  discussed, suggests a follow-up). Streams into
   *  `liveCandidateQuestionCommentary` which the UI renders in the
   *  commentary pane while momentState === "candidate_questioning".
   *
   *  Re-fires when applyMomentInner detects a NEW candidate question
   *  text (different from the prior one). Same question text → no fire,
   *  the existing commentary stays on screen. */
  private async generateCandidateQuestionCommentary(candidateQuestion: string) {
    const { liveJd, liveResume, commentLang, setLiveCandidateQuestionCommentary } =
      useStore.getState();
    setLiveCandidateQuestionCommentary(""); // clear previous — streaming starts fresh
    log("cand-q-cmt", "request", {
      cqLen: candidateQuestion.length,
      preview: preview(candidateQuestion, 80),
    });

    let sawApiError = false;
    const accumulated = await this.streamCommentarySSE(
      {
        jd: liveJd,
        resume: liveResume,
        question: "",
        answer: "",
        mode: "candidate_question",
        candidateQuestion,
        // Pass recent dialogue so the model can spot whether the
        // question ties back to specifics the interviewer revealed
        // earlier (e.g. "you mentioned EMR migration — …"). Without
        // this it would have to evaluate the question in a vacuum.
        recentDialogue: this.dialogueBuffer.slice(-15),
        lang: commentLang,
      },
      (acc) => useStore.getState().setLiveCandidateQuestionCommentary(acc),
      "cand-q-cmt",
      () => {
        sawApiError = true;
      }
    );
    if (accumulated !== null && !sawApiError && accumulated.length > 0) {
      this.markCommentaryDisplayed(accumulated);
      log("cand-q-cmt", "done", {
        chars: accumulated.length,
        readMs: this.computeReadingTimeMs(accumulated),
        preview: preview(accumulated, 100),
      });
    }
  }

  /** True when we should fire a listening-hint generation right now.
   *
   *  Gating, in priority order:
   *    (1) No generation already pending.
   *    (2) Enough NEW monologue content since the last hint
   *        (LISTENING_HINT_TRIGGER_CHARS, watermarked by buffer size,
   *        so a stagnant 500-char buffer doesn't re-fire on a timer).
   *    (3) Past the LISTENING_HINT_MIN_GAP_MS cooldown.
   *    (4) Previous hint has been on screen long enough — i.e. its
   *        length-derived min-display window has elapsed. Without
   *        this, a new hint generation calls setLiveListeningHint("")
   *        which yanks a still-being-read 200-char hint off screen
   *        and replaces it with streaming-in tokens of the next one.
   *        We were seeing this in the 32-min log: 21:43 hint (147
   *        chars, ~38s of reading) was clobbered by the 22:04
   *        generation, which is well within its window.
   */
  private shouldTriggerListeningHint(): boolean {
    if (this.pendingListeningHint) return false;
    // Need LISTENING_HINT_TRIGGER_CHARS of NEW monologue content since
    // the last hint. Raw buffer length alone would re-trigger on stale
    // content every time the cooldown expires.
    const newCharsSinceLastHint =
      this.interviewerMonologueBuffer.length -
      this.lastListeningHintBufferSize;
    if (newCharsSinceLastHint < LISTENING_HINT_TRIGGER_CHARS) return false;
    if (Date.now() - this.lastListeningHintAt < LISTENING_HINT_MIN_GAP_MS)
      return false;
    // Reading-protection: don't clobber the previous hint while it's
    // still inside its content-length-based min-display window. We
    // reuse `lastCommentaryReadyAt` + `lastCommentaryText` which are
    // already set by markCommentaryDisplayed at the end of every hint
    // generation (and by Q-A / warmup successes too). If the previous
    // commentary slot is still being read, defer.
    if (this.lastCommentaryReadyAt > 0 && this.lastCommentaryText) {
      const required = computeMinDisplayMs(this.lastCommentaryText);
      const elapsed = Date.now() - this.lastCommentaryReadyAt;
      if (elapsed < required) {
        log("listen-hint", "deferred-reading", {
          elapsedMs: elapsed,
          requiredMs: required,
          prev: preview(this.lastCommentaryText, 60),
        });
        return false;
      }
    }
    return true;
  }

  /** Generate a listening hint for the candidate. Streams into
   *  `liveListeningHint` so the UI can show it in the commentary pane
   *  while the interviewer is still talking. */
  private async generateListeningHint() {
    this.pendingListeningHint = true;
    const monologue = this.interviewerMonologueBuffer;
    // Don't drain the buffer here — it keeps growing while the
    // interviewer talks. We just remember how many chars we've seen at
    // generation time and wait for additional LISTENING_HINT_TRIGGER_CHARS
    // on top before allowing another hint (handled via lastListeningHintAt).

    const { liveJd, liveResume, commentLang, setLiveListeningHint } =
      useStore.getState();

    setLiveListeningHint(""); // clear any previous hint — streaming begins fresh

    log("listen-hint", "request", {
      monolLen: monologue.length,
      monolPrev: preview(monologue, 80),
    });

    try {
      let sawApiError = false;
      const accumulated = await this.streamCommentarySSE(
        {
          jd: liveJd,
          resume: liveResume,
          question: "",
          answer: "",
          mode: "listening",
          interviewerMonologue: monologue,
          recentDialogue: this.dialogueBuffer.slice(-10),
          lang: commentLang,
        },
        (acc) => useStore.getState().setLiveListeningHint(acc),
        "listen-hint",
        () => {
          sawApiError = true;
        }
      );
      this.lastListeningHintAt = Date.now();
      this.lastListeningHintBufferSize =
        this.interviewerMonologueBuffer.length;
      if (accumulated !== null && !sawApiError && accumulated.length > 0) {
        this.markCommentaryDisplayed(accumulated);
        log("listen-hint", "done", {
          chars: accumulated.length,
          readMs: this.computeReadingTimeMs(accumulated),
          preview: preview(accumulated, 100),
        });
      }
    } finally {
      this.pendingListeningHint = false;
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

      log("classify", "request", {
        from: currentState,
        sampleN: sample.length,
        currentQ: preview(currentMainQuestionText, 50),
      });

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
      if (!resp.ok) {
        log("classify", "error", { status: resp.status });
        return;
      }
      const data = (await resp.json()) as {
        state?: MomentStateKind;
        summary?: string;
        question?: string;
        candidateQuestion?: string;
        questionRelation?: QuestionRelation;
      };
      if (!data.state) {
        log("classify", "empty");
        return;
      }

      log("classify", "response", {
        state: data.state,
        rel: data.questionRelation,
        q: preview(data.question || "", 60),
        candQ: preview(data.candidateQuestion || "", 60),
        summary: preview(data.summary || "", 60),
      });

      this.applyMoment(
        data.state,
        data.summary || "",
        data.question || "",
        data.questionRelation ?? null,
        data.candidateQuestion || ""
      );
    } catch (e) {
      log("classify", "error", {
        message: e instanceof Error ? e.message : String(e),
      });
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
    rel: QuestionRelation,
    candidateQuestion: string = ""
  ) {
    const prev = useStore.getState().liveMomentState.state;

    // ==== Hysteresis gate ====
    // Require MOMENT_HYSTERESIS_THRESHOLD consecutive votes in the
    // same direction before a non-question transition commits.
    // question_finalized bypasses this (handled by its own 4-layer
    // filter). When the new state equals the current state, reset
    // any pending vote (the session has stabilized).
    if (next === prev) {
      // Classifier agrees with current state — clear pending counter.
      this.momentHysteresisPending = null;
    } else if (next !== "question_finalized") {
      const p = this.momentHysteresisPending;
      if (!p || p.state !== next) {
        // New direction proposed. Start counting.
        this.momentHysteresisPending = { state: next, count: 1 };
        log("hysteresis", "pending", {
          proposed: next,
          from: prev,
          count: 1,
          need: MOMENT_HYSTERESIS_THRESHOLD,
        });
        return;
      }
      p.count += 1;
      if (p.count < MOMENT_HYSTERESIS_THRESHOLD) {
        log("hysteresis", "hold", {
          proposed: next,
          from: prev,
          count: p.count,
          need: MOMENT_HYSTERESIS_THRESHOLD,
        });
        return;
      }
      // Vote passed the threshold — clear pending and commit.
      this.momentHysteresisPending = null;
    } else {
      // question_finalized: bypass hysteresis. The 4-layer filter
      // decides whether to actually lock the Q; clear any stale
      // pending to avoid a chitchat vote holding across a real Q.
      this.momentHysteresisPending = null;
    }

    try {
      this.applyMomentInner(next, summary, questionText, rel, candidateQuestion);
    } finally {
      // Log transit ONLY when the store state actually changed, not
      // when the classifier merely proposed a change that anchored-mode
      // logic deliberately ignored. Fires post-apply so the log
      // reflects the reality of the store.
      const after = useStore.getState().liveMomentState.state;
      if (prev !== after) {
        log("moment", "transit", { from: prev, to: after, rel });
      }
    }
  }

  private applyMomentInner(
    next: MomentStateKind,
    summary: string,
    questionText: string,
    rel: QuestionRelation,
    candidateQuestion: string = ""
  ) {
    const store = useStore.getState();
    const currentSubQ = store.liveQuestions.find(
      (q) => q.id === store.live.currentQuestionId
    );
    const currentMainQ = currentSubQ?.parentQuestionId
      ? store.liveQuestions.find((q) => q.id === currentSubQ.parentQuestionId)
      : currentSubQ;
    const currentFollowUpQ =
      currentSubQ && currentSubQ !== currentMainQ ? currentSubQ : undefined;

    // ============================================================
    // Reverse-Q&A branch: candidate is asking the interviewer questions
    // ("any questions for me?" → candidate asks). Handle this BEFORE the
    // anchored / pre-anchored branches because it can fire from either —
    // a session can flip into reverse-Q&A directly from question_finalized
    // (interviewer wraps "any questions?" right after the candidate's
    // answer) or from chitchat (interviewer goodbyes + remembers to ask).
    // ============================================================
    if (next === "candidate_questioning") {
      const cq = candidateQuestion.trim();
      // Strict empty-q guard. If the classifier reports the state but
      // didn't extract a question text, this is internally inconsistent
      // — refresh summary only and leave display state intact rather
      // than nuking the prior Lead based on uncertain signal.
      if (cq.length < 5) {
        log("filter", "ignore-empty-cand-q", {
          len: cq.length,
          summary: preview(summary, 60),
        });
        const currentState = store.liveMomentState.state;
        store.setMomentState({ state: currentState, summary });
        return;
      }
      // Discard any pending Lead validation — the interview has moved
      // into reverse Q&A, the proposed Lead is stale.
      if (this.pendingLead) {
        this.discardPendingLead("entered-candidate-questioning");
      }
      // Archive any locked Lead. Old Q + its commentary stay in
      // liveQuestions so the post-session review still has them; we
      // just clear currentQuestionId so the UI's Phase region switches
      // to the candidate's question.
      if (currentMainQ) {
        store.setCurrentQuestionId(null);
      }
      // Drain answer-side buffers — the candidate isn't answering
      // anything anymore. Keep dialogueBuffer intact: the prior Q&A
      // turns are exactly the context the candidate-question commentary
      // needs to judge "did the question tie back to what was
      // discussed earlier?". Trim to the last 20 turns so it doesn't
      // grow unbounded across a long Q&A tail.
      this.answerBuffer = "";
      this.pendingAnswerBuffer = "";
      if (this.dialogueBuffer.length > 20) {
        this.dialogueBuffer = this.dialogueBuffer.slice(-20);
      }
      this.interviewerMonologueBuffer = "";
      this.lastListeningHintBufferSize = 0;
      useStore.getState().setLiveListeningHint("");
      this.candidateWarmupBuffer = "";
      this.lastWarmupBufferSize = 0;
      useStore.getState().setLiveWarmupCommentary("");
      store.setDisplayedComment(null);
      store.setAnswerInProgress(false);
      this.pendingCommentaryFor = null;

      // First-entry timestamp — once Q&A reverse phase starts, the
      // UI uses this to gate "fallback to a previous Lead Question":
      // any archived Lead with askedAtSeconds BEFORE this timestamp is
      // treated as closed and won't be displayed again. Only set on
      // the FIRST entry; subsequent re-entries (state churned out
      // briefly and back) keep the original timestamp so the gate
      // logic stays stable.
      if (store.liveCandidateQuestioningSince == null) {
        store.setLiveCandidateQuestioningSince(store.live.elapsedSeconds);
        log("candidate-q", "phase-started", {
          atSec: store.live.elapsedSeconds,
        });
      }

      // Was the previous candidate question text the same as this one?
      // Classifier ticks every 2-3s; while the candidate is still
      // talking and the interviewer is answering, the classifier may
      // re-emit the same question text many times in a row. Only fire
      // a fresh commentary when the question text genuinely changes.
      const prevCq = (store.liveMomentState.candidateQuestion || "").trim();
      store.setMomentState({
        state: "candidate_questioning",
        summary,
        candidateQuestion: cq,
      });
      if (cq !== prevCq) {
        // New question — clear prior commentary text and fire a fresh
        // generation. (Same pattern as warmup commentary.)
        useStore.getState().setLiveCandidateQuestionCommentary("");
        log("candidate-q", "new", { text: preview(cq, 80) });
        void this.generateCandidateQuestionCommentary(cq);
      }
      return;
    }

    // Anchored mode — once a main question is locked, be conservative.
    if (currentMainQ) {
      if (next === "question_finalized") {
        const txt = (questionText || "").trim();
        // Strict empty-q guard: if the classifier says question_finalized
        // but the question text is empty or too short to be a real Q
        // (< 5 chars), the response is internally inconsistent — keep
        // the current state entirely and just refresh the summary.
        // Previously this path would setMomentState(q_finalized) even
        // with empty q, which was a no-op in anchored mode but caused
        // UI flicker in pre-anchored mode.
        if (txt.length < 5) {
          log("filter", "ignore-empty-q", {
            len: txt.length,
            summary: preview(summary, 60),
          });
          // Refresh summary only; state stays question_finalized
          // because currentMainQ is locked.
          store.setMomentState({ state: "question_finalized", summary });
          return;
        }
        // Same as current main or current follow-up → no-op.
        if (
          txt === currentMainQ.text.trim() ||
          (currentFollowUpQ && txt === currentFollowUpQ.text.trim())
        ) {
          // Just refresh state/summary in case display is stale (e.g. came
          // back from chitchat).
          store.setMomentState({ state: "question_finalized", summary });
          return;
        }
        // Route through the 4-layer question-lock filter. The commit
        // happens ONLY if Layer 1 (grounding) + Layer 2 (parallel
        // confirm) + Layer 3 (3s continuation silence) all pass.
        this.queueLeadValidation(txt, summary, rel, currentMainQ.id);
        return;
      }
      if (next === "interviewer_speaking" && rel === "new_topic") {
        // Interviewer pivoting to a new topic. We used to archive the
        // current Lead immediately here so the Phase bar would shift
        // to "Between Questions · Interviewer Transitioning" while the
        // next question was forming. Per the user's spec ("interview
        // 期间无非两种情况:面试官问问题 or 候选人问问题, 完全去掉
        // Between Questions phase"), we now KEEP the current Lead
        // visible right up until the new one actually locks via
        // archiveCurrentMainAndStartNew. Net: one phase, not two —
        // the bar goes Lead-A → Lead-B atomically with no empty gap
        // in between, and Live Commentary doesn't get yanked into
        // an "AI is observing…" idle state during the interviewer's
        // pivot monologue.
        //
        // We still refresh the summary line and clear the listening-
        // hint slot (so a stale old-topic hint isn't reused), but the
        // currentQuestionId / displayedComment / answer buffers stay
        // intact so the previous Q&A context lives until the new
        // commit point.
        store.setMomentState({ state: "interviewer_speaking", summary });
        useStore.getState().setLiveListeningHint("");
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

    // Pre-anchored — no current main yet.
    if (next === "question_finalized") {
      // Use ONLY the classifier's question text. Previously we fell
      // back to `summary` when q was empty — but summary is a
      // description ("Candidate describing background and experience"),
      // not a question. Feeding that to queueLeadValidation produced
      // repeated L1-fails on junk text. If q is empty here, the
      // classifier's finalize signal is unreliable; treat as
      // interviewer_speaking and wait for a real Q to emerge.
      const text = (questionText || "").trim();
      if (text.length >= 5) {
        // Keep the UI in interviewer_speaking while we validate the
        // proposal. The momentState only flips to question_finalized
        // after the filter commits — otherwise the user would briefly
        // see a pending Lead flash up and potentially disappear.
        store.setMomentState({ state: "interviewer_speaking", summary });
        this.queueLeadValidation(text, summary, rel, undefined);
        return;
      }
      // Strict empty-q guard: q is empty or < 5 chars. Response is
      // internally inconsistent — keep the CURRENT state as-is (do
      // not change it), just refresh the summary so the UI can still
      // reflect what's happening. Previously we force-set
      // interviewer_speaking, which could be a downgrade from the
      // user's current phase.
      log("filter", "ignore-empty-q", {
        len: text.length,
        summary: preview(summary, 60),
      });
      const currentState = store.liveMomentState.state;
      store.setMomentState({ state: currentState, summary });
      return;
    }

    // Non-finalize states — any pending Lead's validation becomes
    // moot. Discard the pending so we don't commit a stale proposal
    // after the classifier has already moved on.
    if (this.pendingLead) {
      this.discardPendingLead("state-changed");
    }
    // Leaving candidate_questioning → clear its commentary slot so a
    // stale "evaluation of last candidate question" doesn't linger
    // into chitchat / interviewer_speaking.
    const wasCandidateQuestioning =
      store.liveMomentState.state === "candidate_questioning";
    store.setMomentState({ state: next, summary });
    if (wasCandidateQuestioning) {
      useStore.getState().setLiveCandidateQuestionCommentary("");
    }
    if (next === "interviewer_speaking" || next === "chitchat") {
      this.pendingAnswerBuffer = "";
    }
    // Closing-state side effect: arm the 3-second silence timer so we
    // can detect a mutual-goodbye + silence pattern and prompt the user
    // to End & Save. Single-shot per session.
    if (next === "closing") {
      this.armClosingSilenceTimer();
    }
  }

  // ============================================================
  // Closing-detection helpers
  // ============================================================

  /** Arm the 3-second silence timer when state enters "closing". A
   *  substantive utterance (>10 chars, see onUtterance) cancels it.
   *  No-op once fired or once user opted to keep recording. */
  private armClosingSilenceTimer(): void {
    if (this.closingDetectionDisabled) return;
    if (this.closingDetectionFired) return;
    if (this.closingSilenceTimer) {
      clearTimeout(this.closingSilenceTimer);
    }
    log("closing", "armed", {
      ms: LiveOrchestrator.CLOSING_SILENCE_MS,
    });
    this.closingSilenceTimer = setTimeout(() => {
      this.closingSilenceTimer = null;
      if (this.closingDetectionDisabled) return;
      // Verify we're STILL in closing at fire time. If the classifier
      // moved us back to interviewer_speaking / chitchat in the
      // intervening 3s (e.g. interviewer pivoted to "actually one more
      // question…"), silently abandon — don't prompt the user to save
      // when the interview clearly isn't over.
      const stateNow = useStore.getState().liveMomentState.state;
      if (stateNow !== "closing") {
        log("closing", "abandoned", { stateNow });
        return;
      }
      this.closingDetectionFired = true;
      log("closing", "fired", {});
      // Dispatch to the UI. Caught by LiveView, which renders the
      // "Save now?" confirmation dialog. If the user picks "continue
      // recording", they'll call disableClosingDetection() to silence
      // future fires.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("ic:closing-detected"));
      }
    }, LiveOrchestrator.CLOSING_SILENCE_MS);
  }

  /** Cancel the in-flight closing-silence timer. Called from
   *  onUtterance whenever a substantive utterance lands — speech
   *  means the interview isn't over. */
  private cancelClosingSilenceTimer(reason: string): void {
    if (this.closingSilenceTimer) {
      clearTimeout(this.closingSilenceTimer);
      this.closingSilenceTimer = null;
      log("closing", "cancelled", { reason });
    }
  }

  /** Public hook for the UI to call when the user picks "continue
   *  recording" from the closing-detected dialog. Permanently disables
   *  closing detection for the rest of this session so the dialog
   *  doesn't keep popping every time the classifier re-enters closing. */
  public disableClosingDetection(): void {
    this.closingDetectionDisabled = true;
    this.cancelClosingSilenceTimer("user-dismissed-dialog");
    log("closing", "disabled-by-user", {});
  }

  // ============================================================
  // 4-layer question-lock filter
  // ============================================================

  /** Normalize a proposed Q for the rejected-texts cache. Lowercase,
   *  collapse whitespace, strip trailing punctuation so minor
   *  classifier variation ("Tell me about yourself." vs "Tell me about
   *  yourself" vs "Tell me about yourself?") all hash to the same
   *  entry. */
  private normalizeQText(s: string): string {
    return s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!?,;:\u3002\uff01\uff1f]+$/g, "")
      .trim();
  }

  /** Tokenize a Q for similarity comparison. Lowercase, drop short
   *  stopwords (<4 chars), strip trailing punctuation, and light
   *  plural stripping ("projects" → "project", "interests" → "interest")
   *  so minor morphological variation doesn't pull Jaccard below the
   *  threshold. Set-based so duplicates don't inflate similarity. */
  private tokenizeForSim(s: string): Set<string> {
    const out = new Set<string>();
    for (const raw of s.toLowerCase().split(/\s+/)) {
      const stripped = raw.replace(/[.,!?;:\u3002\uff01\uff1f]+$/g, "");
      if (stripped.length < 4) continue;
      const base =
        stripped.length > 4 && stripped.endsWith("s")
          ? stripped.slice(0, -1)
          : stripped;
      out.add(base);
    }
    return out;
  }

  /** True when two Q texts share enough tokens to be considered a
   *  restatement of the same underlying question. Uses Jaccard index
   *  over stripped, stemmed token sets. */
  private isSemanticallySimilar(a: string, b: string): boolean {
    const A = this.tokenizeForSim(a);
    const B = this.tokenizeForSim(b);
    if (A.size === 0 || B.size === 0) return false;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    if (union === 0) return false;
    return inter / union >= RESTATEMENT_JACCARD_THRESHOLD;
  }

  /** Layer 1: does the proposed Q text actually appear in the recent
   *  interviewer transcript? Classifier can hallucinate — if the
   *  proposed text shares <GROUNDING_MIN_TOKEN_MATCH of its non-stop
   *  tokens with what the interviewer actually said in the last
   *  GROUNDING_RECENT_SEC seconds, treat as a hallucination. Pure
   *  local check, zero cost / zero latency. */
  private isGrounded(questionText: string): boolean {
    const store = useStore.getState();
    const nowSec = store.live.elapsedSeconds;
    const recentCutoff = nowSec - GROUNDING_RECENT_SEC;
    const roles = store.liveSpeakerRoles;
    const interviewerText: string[] = [];
    for (const u of store.liveUtterances) {
      if (u.atSeconds < recentCutoff) continue;
      if (u.dgSpeaker === undefined) continue;
      if (roles[u.dgSpeaker] !== "interviewer") continue;
      interviewerText.push(u.text.toLowerCase());
    }
    const haystack = interviewerText.join(" ");
    if (!haystack) return false;
    const tokens = questionText
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 4);
    if (tokens.length === 0) return true; // too short to meaningfully check
    let matched = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) matched++;
    }
    return matched / tokens.length >= GROUNDING_MIN_TOKEN_MATCH;
  }

  /** Layer 2: focused second-opinion API call. Returns a verdict that
   *  the primary classifier's Q proposal has to be "done" for us to
   *  commit. Runs in PARALLEL with the Layer 3 timer so it doesn't
   *  stack latency. */
  private async runConfirmPass(
    questionText: string
  ): Promise<"done" | "still_setting_up" | "not_a_question"> {
    const sample = this.buildClassifySample();
    try {
      const resp = await fetch("/api/classify-moment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          utterances: sample,
          currentState: "idle",
          msSinceLastTranscript: 0,
          mode: "confirm",
          candidateQuestion: questionText,
        }),
      });
      if (!resp.ok) return "still_setting_up";
      const data = (await resp.json()) as {
        verdict?: "done" | "still_setting_up" | "not_a_question";
      };
      return data.verdict ?? "still_setting_up";
    } catch {
      return "still_setting_up";
    }
  }

  /** Main gate. Intercepts classifier's question_finalized proposal,
   *  runs Layer 1 locally, launches Layer 2 in parallel, and sets a
   *  Layer 3 timer that commits the Lead after CONTINUATION_GATE_MS
   *  of interviewer silence — IF Layer 2 also agreed by then.
   *
   *  parentMainId: when a main question is currently locked, pass its
   *  id so a rel=follow_up commit attaches correctly. undefined means
   *  pre-anchored (first Lead of the session). */
  private queueLeadValidation(
    text: string,
    summary: string,
    rel: QuestionRelation,
    parentMainId: string | undefined
  ): void {
    // Restatement gate (pre-L0): if a Lead/Probe was just committed
    // within the cooldown window AND the new proposal is semantically
    // similar to it, drop it. Fixes the case where the classifier
    // emits the same Q twice back-to-back with slightly different
    // wording ("Can you speak a little bit…" → commit Q1; 1s later
    // "Can you speak a bit…" → commit Q2). Strict-equality dedupe
    // misses this because the strings differ; token-Jaccard catches
    // it. Cooldown is short enough that genuinely different new Qs
    // minutes later still pass through.
    const sinceLastCommit = Date.now() - this.lastLeadCommitAt;
    if (
      this.lastCommittedQText &&
      sinceLastCommit < RESTATEMENT_COOLDOWN_MS &&
      this.isSemanticallySimilar(text, this.lastCommittedQText)
    ) {
      log("filter", "restated-Q", {
        text: preview(text, 60),
        sinceLastMs: sinceLastCommit,
        prev: preview(this.lastCommittedQText, 60),
      });
      return;
    }

    // Layer 0 (cheap short-circuit): the classifier loves to hallucinate
    // the SAME imaginary Q over and over ("Tell me about yourself"
    // proposed 6 times in 40s even though it was never asked). Remember
    // texts we've already rejected and skip them without re-running
    // Layer 1/2/3. Saves significant Anthropic budget + noise.
    const normalized = this.normalizeQText(text);
    if (this.rejectedQTexts.has(normalized)) {
      log("filter", "L0-cached-reject", {
        text: preview(text, 60),
      });
      return;
    }
    // Layer 1: text grounding — cheap filter against hallucination.
    if (!this.isGrounded(text)) {
      log("filter", "L1-fail", {
        reason: "not-grounded",
        text: preview(text, 60),
      });
      this.rejectedQTexts.add(normalized);
      return;
    }
    log("filter", "L1-pass", { text: preview(text, 60) });

    // Dedupe: if we already have a pending with the SAME text, just
    // let the existing timer run. Replace only if text differs.
    if (this.pendingLead && this.pendingLead.text.trim() === text.trim()) {
      return;
    }
    // Different pending in flight — discard it and start over with
    // the new proposal.
    if (this.pendingLead) {
      this.discardPendingLead("replaced-by-newer");
    }

    log("filter", "pending", {
      text: preview(text, 60),
      rel,
      gateMs: CONTINUATION_GATE_MS,
    });

    // Layer 2: fire parallel confirm. We store the promise so the
    // timer can await it when it fires. This way total latency is
    // max(Layer 3 timer, Layer 2 API call) — NOT their sum.
    const confirmPromise = this.runConfirmPass(text);

    // Layer 3: continuation gate. Commits after CONTINUATION_GATE_MS
    // if Layer 2 has come back "done" AND no interviewer utterance
    // has arrived in the meantime (arrival clears the timer via
    // cancelPendingOnInterviewerTurn).
    const timer = setTimeout(async () => {
      // Timer fires → check Layer 2.
      const pending = this.pendingLead;
      if (!pending) return; // was cancelled
      const verdict = await confirmPromise;
      if (verdict !== "done") {
        log("filter", "L2-fail", {
          verdict,
          text: preview(text, 60),
        });
        // Cache this rejection so the same classifier hallucination
        // doesn't spin up another Layer 2 API call 2 seconds later.
        this.rejectedQTexts.add(normalized);
        this.discardPendingLead("L2-" + verdict);
        return;
      }
      log("filter", "L2-pass", { text: preview(text, 60) });
      log("filter", "L3-pass", {
        text: preview(text, 60),
        gateMs: CONTINUATION_GATE_MS,
      });
      // All three layers passed — actually commit.
      this.pendingLead = null;
      this.commitLead(text, summary, rel, parentMainId);
    }, CONTINUATION_GATE_MS);

    this.pendingLead = {
      text,
      summary,
      rel,
      committedAt: Date.now(),
      timer,
    };
  }

  /** Called when a new interviewer utterance arrives while a pending
   *  Lead is being gated. That means the interviewer kept talking —
   *  they weren't actually done — so the proposed Q isn't valid.
   *  Discard and let the next classify pass take another shot. */
  private cancelPendingOnInterviewerTurn(): void {
    if (!this.pendingLead) return;
    this.discardPendingLead("L3-interviewer-continued");
  }

  private discardPendingLead(reason: string): void {
    const p = this.pendingLead;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pendingLead = null;
    log("filter", "discard", { reason, text: preview(p.text, 60) });
  }

  /** Final commit step once all three layers have passed. Does the
   *  actual work of updating the store — adding the question, setting
   *  moment state, resetting buffers, kicking off commentary. This
   *  used to be inlined in applyMoment's two question_finalized
   *  branches; centralized here now. */
  private commitLead(
    text: string,
    summary: string,
    rel: QuestionRelation,
    parentMainId: string | undefined
  ): void {
    // Mark this commit for the restatement-cooldown gate. Any near-
    // duplicate proposal within RESTATEMENT_COOLDOWN_MS will be
    // dropped instead of committed as a second Q.
    this.lastLeadCommitAt = Date.now();
    this.lastCommittedQText = text;
    // Clear the rejected-texts cache. A Lead just locked; the session
    // has moved on and any prior rejected hallucinations are stale
    // (some of them may even become legitimate in the new context).
    this.rejectedQTexts.clear();

    const store = useStore.getState();
    const currentMainQ = parentMainId
      ? store.liveQuestions.find((q) => q.id === parentMainId)
      : undefined;

    if (currentMainQ) {
      if (rel === "follow_up") {
        this.addFollowUpAndStart(currentMainQ.id, text, summary);
      } else {
        this.archiveCurrentMainAndStartNew(text, summary);
      }
      return;
    }

    // Pre-anchored first Lead path.
    const q: Question = {
      id: rand("q"),
      text,
      askedAtSeconds: store.live.elapsedSeconds,
      comments: [],
    };
    store.addQuestion(q);
    store.setMomentState({ state: "question_finalized", summary });
    log("question", "lead", {
      qid: q.id,
      text: preview(text, 80),
      kind: "first",
    });
    this.answerBuffer = this.pendingAnswerBuffer;
    // Seed the new question's answerText with any candidate speech that
    // landed BEFORE the lock (during the interviewer_speaking phase).
    // Without this, the first ~3 seconds of the answer — which is what
    // tipped the classifier over to question_finalized in the first
    // place — would never reach the persistent question.answerText.
    if (this.pendingAnswerBuffer) {
      store.appendCandidateAnswerText(q.id, this.pendingAnswerBuffer);
    }
    this.pendingAnswerBuffer = "";
    this.dialogueBuffer = [];
    this.interviewerMonologueBuffer = "";
    this.lastListeningHintBufferSize = 0;
    useStore.getState().setLiveListeningHint("");
    // Warm-up ended — clear its buffer + clear the pane text.
    this.candidateWarmupBuffer = "";
    this.lastWarmupBufferSize = 0;
    useStore.getState().setLiveWarmupCommentary("");
    this.pendingCommentaryFor = null;
    store.setAnswerInProgress(this.answerBuffer.length > 0);
    if (this.shouldTriggerComment(q.id)) {
      void this.generateComment(q);
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
    log("question", "probe", {
      qid: q.id,
      parent: parentId,
      text: preview(text, 80),
    });
    store.setMomentState({ state: "question_finalized", summary });
    // Carry over any candidate text accumulated while interviewer was asking
    // this follow-up.
    this.answerBuffer = this.pendingAnswerBuffer;
    if (this.pendingAnswerBuffer) {
      store.appendCandidateAnswerText(q.id, this.pendingAnswerBuffer);
    }
    this.pendingAnswerBuffer = "";
    this.dialogueBuffer = [];
    this.interviewerMonologueBuffer = "";
    this.lastListeningHintBufferSize = 0;
    useStore.getState().setLiveListeningHint("");
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
    log("question", "lead", {
      qid: q.id,
      text: preview(text, 80),
      kind: "new-topic",
    });
    store.setMomentState({ state: "question_finalized", summary });
    store.setDisplayedComment(null);
    this.answerBuffer = this.pendingAnswerBuffer;
    if (this.pendingAnswerBuffer) {
      store.appendCandidateAnswerText(q.id, this.pendingAnswerBuffer);
    }
    this.pendingAnswerBuffer = "";
    this.dialogueBuffer = [];
    this.interviewerMonologueBuffer = "";
    this.lastListeningHintBufferSize = 0;
    useStore.getState().setLiveListeningHint("");
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

      // Snapshot the utterance count BEFORE the request fires. After a
      // successful run we use this to gate the next refresh — so we only
      // re-run once N more utterances have arrived since this call.
      const utteranceCountAtStart =
        useStore.getState().liveUtterances.length;

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
      // Per-speaker commit + streak bookkeeping with CONFIDENCE gate.
      // We no longer commit on the very first agreeing run — a first
      // run with only 3 utterances of context can easily flip interviewer/
      // candidate. Instead:
      //
      //   - Each run updates `pendingRoles[n]` + `roleAgreementStreak[n]`.
      //     Same proposal as last time → streak++. Different → reset to 1.
      //   - Commit to the store only when streak reaches
      //     IDENTIFY_CONFIDENCE_THRESHOLD AND the committed role differs
      //     from what we'd commit. ~90% confidence: three independent
      //     runs reading the same body of conversation.
      //   - A committed role can still FLIP if Haiku proposes a new one
      //     for THRESHOLD runs in a row (the pending + streak logic
      //     handles this naturally — streak resets on dissent, grows on
      //     agreement, commits when it hits threshold).
      //
      // This gives the UI an honest "Speaker 1 / Speaker 2" state until
      // we're genuinely sure who's asking vs answering.
      const existing = useStore.getState().liveSpeakerRoles;
      const toCommit: Record<number, "interviewer" | "candidate"> = {};
      for (const [k, v] of Object.entries(numKeyed)) {
        const n = Number(k);
        if (this.pendingRoles[n] === v) {
          this.roleAgreementStreak[n] =
            (this.roleAgreementStreak[n] ?? 0) + 1;
        } else {
          this.pendingRoles[n] = v;
          this.roleAgreementStreak[n] = 1;
        }
        const streak = this.roleAgreementStreak[n] ?? 0;
        if (streak >= IDENTIFY_CONFIDENCE_THRESHOLD && existing[n] !== v) {
          toCommit[n] = v;
        }
      }
      if (Object.keys(toCommit).length > 0) {
        const prevConfirmed = rolesAreConfirmed(existing);
        useStore.getState().mergeSpeakerRoles(toCommit);
        const nextRoles = useStore.getState().liveSpeakerRoles;
        const nowConfirmed = rolesAreConfirmed(nextRoles);
        // Confirmation just flipped from false → true. Fire an
        // immediate classify-moment to process the accumulated
        // utterances so the first question + commentary land right
        // away instead of waiting for another speaker change.
        if (!prevConfirmed && nowConfirmed) {
          console.log(
            "[orchestrator] roles confirmed — triggering catch-up classify-moment"
          );
          this.scheduleClassifyMoment();
        }
      }
      this.lastIdentifyResult = numKeyed;
      this.identifyLastUtteranceCount = utteranceCountAtStart;
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
   *   - Enough new answer text — threshold ESCALATES per Q so later
   *     commentaries on the same question need substantially more new
   *     content (prevents drowning one Q in 7+ repetitive observations)
   *   - Hard cap at 5 commentaries per question
   *   - Hard cooldown since last commentary on this question
   *   - Currently displayed comment has finished its minimum-display window
   */
  private shouldTriggerComment(questionId: string): boolean {
    if (this.pendingCommentaryFor) return false;

    const count = this.commentCountPerQ.get(questionId) ?? 0;
    // Hard cap: no more than 5 commentaries on any single question.
    // Past 5, the observations start repeating; better to wait for a
    // new Q to open the coaching slot back up.
    if (count >= 5) return false;

    // Escalating threshold: 1st fires at 450 chars, 2nd needs 650,
    // 3rd needs 900, 4th needs 1200, 5th needs 1500. Rewards the
    // first observation (most likely to catch the useful early signal)
    // and progressively demands more new content for follow-ups.
    const threshold = COMMENT_TRIGGER_CHARS + count * 200 + (count > 0 ? 50 : 0);
    if (this.answerBuffer.length < threshold) return false;

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

    log("commentary", "request", {
      qid: currentQ.id,
      q: preview(currentQ.text, 60),
      answerChars: bufferForThisComment.length,
      answerPrev: preview(bufferForThisComment, 80),
    });

    try {
      let sawApiError = false;
      const accumulated = await this.streamCommentarySSE(
        {
          jd: liveJd,
          resume: liveResume,
          question: currentQ.text,
          answer: bufferForThisComment,
          priorComments: currentQ.comments.map((c) => c.text),
          // Recent back-and-forth dialogue so the model can read the
          // INTERVIEWER's reactions (laughs, "interesting", "good point",
          // quick follow-ups, long silences) when judging how the answer
          // is landing. Last 20 turns max to keep latency tight.
          recentDialogue: this.dialogueBuffer.slice(-20),
          lang: commentLang,
        },
        (acc) => this.patchCommentText(currentQ.id, commentId, acc),
        "commentary",
        (err) => {
          sawApiError = true;
          log("commentary", "api-err", {
            qid: currentQ.id,
            err: preview(err, 180),
          });
        }
      );
      if (accumulated === null) {
        // Both attempts failed outright (no text ever arrived). Surface
        // the generic error to the UI and bail without claiming the
        // display slot — otherwise an empty comment would sit there
        // blocking future commentary for minMs.
        log("commentary", "error", {
          qid: currentQ.id,
          message: "network failure after retry",
        });
        window.dispatchEvent(
          new CustomEvent("ic:error", { detail: "Commentary failed" })
        );
        return;
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
      if (!sawApiError && accumulated.length > 0) {
        // Q-A isn't gated by the reading-protection check itself, but we
        // update the shared state so subsequent listening hints / warm-up
        // commentary wait for the Q-A observation to be read.
        this.markCommentaryDisplayed(accumulated);
        // Count this commentary against the escalating-threshold cap.
        const prevCount = this.commentCountPerQ.get(currentQ.id) ?? 0;
        this.commentCountPerQ.set(currentQ.id, prevCount + 1);
        log("commentary", "done", {
          qid: currentQ.id,
          chars: accumulated.length,
          readMs: this.computeReadingTimeMs(accumulated),
          countOnQ: prevCount + 1,
          preview: preview(accumulated, 100),
        });
      }
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
