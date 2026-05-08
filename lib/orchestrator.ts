import { AudioSession } from "./audioSession";
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
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  stop(): Promise<void>;
  /** True after stop() has fully run OR start() aborted partway via
   *  abortSession() (no audio source / declined screen share / no
   *  video track). Lets the orchestrator detect "this CaptureSource
   *  is dead, drop the ref before re-Start" — without this, a Try
   *  Again click would early-return on the corpse instance. */
  readonly isStopped: boolean;
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
 *  must appear in the last GROUNDING_RECENT_SEC of transcript. Below
 *  this the Q is assumed hallucinated and discarded.
 *
 *  Lowered from 0.5 → 0.35 (2026-05-07): in a case interview the
 *  interviewer's question often has 6-10 substantive tokens and only
 *  3-4 of them appear in the recent transcript window because the
 *  candidate has been the dominant speaker. Examples that previously
 *  L1-failed in McKinsey session sess-1778129512327:
 *    "On what would it take to build a new electric vehicle charging…"
 *    "What are all the things to consider?"
 *    "What other considerations should the CEO have in mind…"
 *    "And what data would you use for that?"
 *  These are real interviewer asks; the 0.5 bar caught hallucinations
 *  but also blocked these legit questions. 0.35 is permissive enough
 *  to let them through while still discarding the obvious fabrications
 *  (which typically have 0% token overlap, not 35%). */
const GROUNDING_MIN_TOKEN_MATCH = 0.35;
/** Layer 1: how far back to look for grounding (seconds of speech).
 *  Extended from 30s → 60s (2026-05-07): case-style follow-ups often
 *  reference content the interviewer set up 30-50s earlier in the
 *  case prompt, which falls outside a 30s window. 60s covers the
 *  typical case-prompt + clarifier round without bleeding into the
 *  unrelated previous Lead. */
const GROUNDING_RECENT_SEC = 60;
/** Layer 3: milliseconds of interviewer silence required after the
 *  proposed Lead before we commit. If a new interviewer utterance
 *  arrives within this window, pending is discarded. */
const CONTINUATION_GATE_MS = 3000;
/** Cooldown window after a Lead/Probe commits, during which any
 *  semantically-similar new proposal is dropped as a restatement. The
 *  classifier sometimes emits the same Q twice back-to-back with
 *  slightly different wording; without this, both end up committed as
 *  separate Questions. 20s is long enough to cover the typical
 *  classifier-flap window but short enough that a genuine new Q on
 *  the same topic minutes later still gets through.
 *
 *  Bumped from 10s → 20s (2026-05-07): the 10s window let through
 *  duplicates 14-16s apart that we observed in McKinsey session
 *  sess-1778129512327 (sec 284 + 298 same Q2 text; sec 2093 + 2109
 *  same Q5 text). The Jaccard threshold of 0.5 still gates against
 *  truly different questions in the cooldown window, so widening to
 *  20s only catches actual restatements. */
const RESTATEMENT_COOLDOWN_MS = 20000;
/** Token-Jaccard threshold above which a new proposal is considered a
 *  restatement of the just-committed Q. ≥ 0.5 reliably catches the
 *  "a little bit" vs "a bit" type reword but lets genuinely different
 *  questions through (topically related but distinct Qs cluster near
 *  0.2-0.3). */
const RESTATEMENT_JACCARD_THRESHOLD = 0.5;
/** Cooldown for candidate-question (reverse-Q&A) dedup. Mirrors the
 *  lead-question RESTATEMENT_COOLDOWN_MS but applies to the candidate's
 *  questions: while the candidate is still asking ("are there any
 *  restrictions on the remote position?"), the classifier ticks every
 *  2-3s and re-emits the same intent with slightly varied wording each
 *  tick. Without dedup, each variant fires a fresh cand-q-cmt API call,
 *  yanking the previous commentary off screen before the user can read
 *  it. 10s is long enough to cover the typical multi-tick window for
 *  one logical question yet short enough that a genuine second question
 *  on the same topic gets through. */
const CAND_Q_DEDUP_COOLDOWN_MS = 10000;
/** After exiting candidate_questioning (interviewer just started
 *  answering the candidate's reverse Q), how long to be EXTRA
 *  conservative about locking a new Lead Question. Within this window,
 *  the interviewer is mid-answer and may use rhetorical "what are X..."
 *  phrasing that's syntactically a question but contextually narration.
 *  We block Lead lock here unless the candidate has actually started
 *  to answer (signal: pendingAnswerBuffer above the min-chars threshold
 *  — interviewer's own talking doesn't fill that buffer, so its size
 *  is a clean "candidate has spoken since exit" gauge). 15s covers the
 *  typical mid-answer window where false-positive lock risk is highest;
 *  past 15s we revert to standard 4-layer filtering. */
const REVERSE_QA_LEAD_COOLDOWN_MS = 15000;
/** Min candidate-side chars accumulated since exiting candidate_
 *  questioning before a Lead can lock during the cooldown window. 30
 *  chars filters out backchannel "yeah" / "okay" while letting through
 *  any substantive answer start. */
const REVERSE_QA_ANSWER_MIN_CHARS = 30;

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

  /** PER-KIND reading protection. Each commentary kind tracks its own
   *  most-recent display + finish time. We used to share a single
   *  field across all three kinds, which had a bad failure mode:
   *  during a long interviewer monologue we'd queue a listening hint,
   *  the candidate would flip into reverse-Q&A asking a question, and
   *  the cand-q-cmt fire path would defer because "the previous
   *  listening hint is still being read" — even though the UI had
   *  already moved on to the candidate-question commentary slot.
   *  Splitting per-kind means a listening hint never blocks a
   *  cand-q-cmt and vice versa; only repeats within the same kind
   *  defer (which is what reading protection is actually for).
   *  Q-A commentary doesn't appear here — it gates on its own
   *  liveDisplayedComment.minMs window inside generateComment. */
  /** Buffer of listening hints that completed during interviewer
   *  monologue while no question was locked. Drained onto the next
   *  Lead question that locks (in commitLead / addFollowUpAndStart /
   *  archiveCurrentMainAndStartNew) as listening-kind comments. The
   *  drained hints surface in PastView's transcript under that
   *  question, with the same UI treatment as Q-A commentary so the
   *  candidate can review what they were supposed to listen for at
   *  that moment + the suggested phrasing to react with. */
  private pendingListeningHints: Array<{
    id: string;
    text: string;
    atSeconds: number;
    /** Snapshot of the interviewer monologue buffer the AI saw when
     *  it generated this hint. Persisted to comments.context_text so
     *  PastView can render "Interviewer mentioned …" using the same
     *  content the model reacted to, rather than guessing from a
     *  time window over utterances (which catches the tail filler
     *  "Okay. Yeah." instead of the substantive case prompt). */
    contextText: string;
  }> = [];
  private lastListenHintReadyAt = 0;
  private lastListenHintText = "";
  private lastCandQCmtReadyAt = 0;
  private lastCandQCmtText = "";
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

  /** Timestamp + text of the most-recently-fired candidate-question
   *  commentary call. Mirrors `lastLeadCommitAt` / `lastCommittedQText`
   *  but for the reverse-Q&A path. While the candidate is asking, the
   *  classifier emits the same logical question with varied wording on
   *  each 2-3s tick — without dedup we'd fire 4+ cand-q-cmt API calls
   *  for a single question and the commentary would be yanked off
   *  screen before the user can read it. We update these AT FIRE TIME
   *  (not only on stream completion) so subsequent variants within the
   *  cooldown window are deduped even while the API is still returning. */
  private lastCandQCommitAt = 0;
  private lastCommittedCandQText = "";

  /** Timestamp (ms) of the most recent transition OUT of candidate_
   *  questioning. Used by queueLeadValidation to apply REVERSE_QA_LEAD_
   *  COOLDOWN_MS — within this window the interviewer is mid-answer
   *  to the candidate's reverse Q and any new Lead-Q proposal needs
   *  evidence the candidate actually started answering before locking.
   *  Set in applyMomentInner whenever prevState === candidate_questioning
   *  and next !== candidate_questioning (catches all exit paths,
   *  including direct → question_finalized which bypasses the non-
   *  finalize branch). 0 = never been in candidate_questioning yet
   *  this session, no cooldown applies. */
  private lastExitedCandidateQuestioningAt = 0;

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
  /** When hysteresis is pending on a "closing" transit (count:1/need:2),
   *  the second confirm ordinarily comes from another classify cycle —
   *  but after a real goodbye there's typically no new speech, so no
   *  new utterance, so no new classify, so hysteresis stays stuck and
   *  the closing prompt never fires. This timer auto-confirms the
   *  pending closing transit after CLOSING_SILENCE_AUTOCONFIRM_MS of
   *  silence. Cancelled if new substantive speech arrives (someone
   *  said one more thing, conversation isn't over) or if hysteresis
   *  flips to a different proposed state. */
  private closingHysteresisAutoTimer: ReturnType<typeof setTimeout> | null =
    null;

  private knownDgSpeakers = new Set<number>();
  /** Fold map: phantom dgSpeaker → real dgSpeaker. Populated when a
   *  brand-new dg arrives but BOTH roles are already filled by other
   *  dgs (= Deepgram diarization minted a third speaker label for one
   *  of the two real people, typically the candidate as their voice
   *  drifts). Once mapped, every subsequent utterance from the
   *  phantom dg gets remapped to the real dg before storage — so the
   *  captions / transcript / scoring all see one coherent run instead
   *  of fragmented single-word noise. The fold is one-way and final
   *  for the session (we never un-fold). */
  private dgFoldMap: Map<number, number> = new Map();
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
  //   - "Continue recording"  → call `disableClosingDetection()`. Used
  //     to PERMANENTLY mute the prompt for the rest of the session;
  //     that was wrong because real interviews routinely have multiple
  //     "near-closings" (chitchat wrap-up → real goodbye 5+ minutes
  //     later) and the user would never see the prompt at the actual
  //     end. Replaced with a COOLDOWN timestamp instead — see
  //     `closingDetectionMutedUntil` below.
  private closingSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** When > 0, closing detection is silenced until this Date.now() ms.
   *  Set after the user clicks "Continue recording" (5 min cooldown)
   *  or after a successful fire (so we don't re-fire while the modal
   *  itself is up — UI handles its own dismissal). 0 = not muted. */
  private closingDetectionMutedUntil = 0;
  /** Cooldown after the user dismisses ("Continue recording"). 5 min
   *  is long enough that the interview's small-talk wrap-up has
   *  genuinely transitioned into more content, but short enough that
   *  if the real goodbye comes ~7-10 min later we still catch it. */
  private static CLOSING_DISMISS_COOLDOWN_MS = 5 * 60 * 1000;
  /** Cooldown after we successfully fire (to debounce repeat fires
   *  while the modal is on screen and the user hasn't decided yet). */
  private static CLOSING_FIRE_COOLDOWN_MS = 30 * 1000;
  /** ms; tunable via the user spec ("3-second silence after closing"). */
  private static CLOSING_SILENCE_MS = 3000;
  /** ms; minimum utterance length that counts as "they're still talking,
   *  cancel the closing timer". Filler like "yeah" / "ok" doesn't count. */
  private static CLOSING_UTTERANCE_MIN_CHARS = 10;
  /** ms; if classify-moment said state="closing" and the room has been
   *  silent for at least this long, we treat that silence as the
   *  hysteresis confirmation cycle — without this, a real goodbye
   *  followed by silence (the most common ending pattern) keeps
   *  hysteresis stuck at count:1/need:2 forever and the prompt never
   *  fires. */
  private static CLOSING_SILENCE_AUTOCONFIRM_MS = 8000;

  /** Silence-based session-end detection. Two thresholds while
   *  status === "recording":
   *    - IDLE_PROMPT_MS (2 min) → dispatch `ic:idle-prompt` so the
   *      UI can ask "Session quiet for 2 min — save now or continue?"
   *      Fires once per idle window; new speech / user clicking
   *      "Continue" resets the baseline.
   *    - IDLE_AUTO_SAVE_MS (5 min) → dispatch `ic:auto-save-requested`
   *      The page treats this as an automatic End & Save with the
   *      currently-derived live title. Saves whatever was recorded
   *      rather than losing it to a forgotten tab.
   *  Both reset the moment a real Deepgram utterance arrives (which
   *  bumps lastTranscriptAt in onUtterance). */
  private static IDLE_PROMPT_MS = 2 * 60 * 1000;
  private static IDLE_AUTO_SAVE_MS = 5 * 60 * 1000;
  private static IDLE_CHECK_INTERVAL_MS = 30 * 1000;
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Track which thresholds we've already fired this idle window so
   *  events are one-shot. Reset when activity resumes (new utterance
   *  OR user-clicked Continue on the idle prompt). */
  private idlePromptFired = false;
  /** Wall-clock when start() / resume() last fired. Used as the
   *  inactivity baseline when no transcript has arrived yet — prevents
   *  a forgotten session from sitting in "lastTranscriptAt = 0" state
   *  forever and bypassing the auto-save check. */
  private sessionLastResumedAt = 0;

  async start(
    options: {
      captureTabAudio?: "auto" | "on" | "off";
      captureVideo?: boolean;
      useMic?: boolean;
    } = {}
  ): Promise<boolean> {
    // Already-running guard. A "live" AudioSession (not stopped /
    // not aborted) means a session is genuinely in progress — bail.
    // BUT: if `this.audio` is set yet stopped, that's a corpse from
    // a prior abortSession() call (no-audio-source / declined screen
    // share / no video track). The abort path doesn't null this ref
    // because it doesn't have a back-reference to the orchestrator;
    // we clean it up here so a re-Start after Try Again actually
    // creates a fresh AudioSession instead of silently no-op'ing.
    if (this.audio) {
      // Already running — caller should NOT bump status (it's already
      // "recording"). Return true so the page treats this as success.
      if (!this.audio.isStopped) return true;
      this.audio = null;
    }
    resetClientLog();
    log("session", "start", {
      mode: "live",
      captureTabAudio: options.captureTabAudio ?? "auto",
      captureVideo: options.captureVideo ?? false,
      useMic: options.useMic ?? true,
    });
    this.resetSessionState();
    this.audio = new AudioSession(this.makeCallbacks(), {
      captureTabAudio: options.captureTabAudio ?? "auto",
      captureVideo: options.captureVideo ?? false,
      useMic: options.useMic ?? true,
    });
    await this.audio.start();
    // Bail out of the post-start setup if start() aborted partway —
    // armIdleCheck etc. would set timers on a session that doesn't
    // actually exist. Clear the dead ref so the next start() can
    // run cleanly without going through the stopped-check path
    // again. Returning false signals the caller that the session
    // didn't actually arm; the page's `ic:session-aborted` event
    // handler has already flipped live.status back to "idle" by
    // this point, so the caller MUST NOT bump status to "recording"
    // (which would overwrite the abort's idle and leave the user
    // staring at a "live" topbar over a session that never started).
    if (this.audio.isStopped) {
      this.audio = null;
      return false;
    }
    this.sessionLastResumedAt = Date.now();
    this.idlePromptFired = false;
    this.armIdleCheck();
    return true;
  }
  private resetSessionState() {
    this.knownDgSpeakers.clear();
    this.dgFoldMap.clear();
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
    this.lastListenHintReadyAt = 0;
    this.pendingListeningHints = [];
    this.sessionLastResumedAt = 0;
    this.idlePromptFired = false;
    this.lastListenHintText = "";
    this.lastCandQCmtReadyAt = 0;
    this.lastCandQCmtText = "";
    this.pendingCommentaryFor = null;
    // Abort any in-flight Lead validation from the previous session.
    if (this.pendingLead?.timer) clearTimeout(this.pendingLead.timer);
    this.pendingLead = null;
    this.rejectedQTexts.clear();
    this.lastLeadCommitAt = 0;
    this.lastCommittedQText = "";
    this.lastCandQCommitAt = 0;
    this.lastCommittedCandQText = "";
    this.lastExitedCandidateQuestioningAt = 0;
    this.momentHysteresisPending = null;
    this.lastCommentAt.clear();
    this.commentCountPerQ.clear();
    // Closing detection: clear any in-flight timers + reset cooldown
    // so a fresh session starts with no muting from the previous one.
    this.closingDetectionMutedUntil = 0;
    if (this.closingSilenceTimer) {
      clearTimeout(this.closingSilenceTimer);
      this.closingSilenceTimer = null;
    }
    if (this.closingHysteresisAutoTimer) {
      clearTimeout(this.closingHysteresisAutoTimer);
      this.closingHysteresisAutoTimer = null;
    }
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
      onVideoReady: (
        segmentUrls: string[],
        _duration: number,
        mime: string
      ) => {
        // Stash recording artifacts on window so app/page.tsx's
        // End-&-Save flow can read them and pass to endLive(). Cleared
        // there after consumption so stale URLs can't leak into the
        // next session.
        //
        // segmentUrls: blob: URL per pause/resume cycle (length 1
        //   when the user never paused). The store uploads each as
        //   its own S3 object, then calls /api/uploads/concat which
        //   ffmpeg-stitches them into one MP4 with `-c copy`.
        // mime: container/codec MIME, e.g. "video/mp4" or
        //   "video/webm" — passed to the upload code so the
        //   presigned PUT URL is signed with the right Content-Type.
        // __ic_videoUrl: backward-compat single URL. Set to the
        //   FIRST segment so the just-ended same-tab past view has
        //   SOMETHING to play before the server concat completes;
        //   the PastView signed-URL effect overrides this once the
        //   final MP4 is ready.
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
        // Informational / warning channel — used by AudioSession for
        // mid-flow toasts ("Next: pick THIS interview-coach tab",
        // "Tab audio capture declined — continuing with mic-only",
        // "Deepgram reconnected — replaying buffered chunks", etc.).
        // We DO NOT idle the live session here: a soft toast must not
        // kill an otherwise-healthy session. Genuinely fatal failures
        // throw out of audio.start() and are caught by the page's
        // handleStartConfirm catch block, which idles status there.
        window.dispatchEvent(new CustomEvent("ic:error", { detail: msg }));
      },
      onPlaybackEnded: () => {
        // Forwarded to the page as a distinct event so it can show a
        // "recording complete — view scoring" toast without coupling UI
        // code to the session class.
        window.dispatchEvent(new CustomEvent("ic:playback-ended"));
      },
      // Diagnostic hook — every Deepgram WebSocket close (clean or not)
      // gets persisted as a structured event. Without this, silent
      // socket deaths look identical to "real silence" in postmortems
      // (no transcripts arrive, but we have no signal to distinguish
      // "DG died" vs "speakers stopped talking" vs "tab audio source
      // disappeared"). Pairs with audio:level RMS heartbeats and the
      // tab-audio:track-ended log to triangulate "why did transcripts
      // stop?" failures.
      onWsClose: (info: {
        code: number;
        reason: string;
        wasClean: boolean;
        reconnectAttempt: number;
        willReconnect: boolean;
      }) => {
        log("dg-ws", "close", info as unknown as Record<string, unknown>);
      },
      // Bridge AudioSession's diagnostic log calls into the client
      // debug buffer. AudioSession emits events as `"source:event"`
      // strings ("video:share-granted", "zoom:locked",
      // "mic:dg-reconnect", etc.); we split into source/event so the
      // LiveDebugPanel's REASONING dictionary keys match (it indexes
      // on `source:event` already). Without this bridge every call
      // through `this.callbacks.onLog?.(...)` was a silent no-op —
      // half the orchestrator's diagnostic surface (audio path,
      // screen recording path, zoom lock state) never reached the
      // panel or the persisted session_events.
      onLog: (event: string, data?: Record<string, unknown>) => {
        const m = /^([^:]+):(.+)$/.exec(event);
        if (m) {
          log(m[1], m[2], data);
        } else {
          // Unknown format: keep it but tag under a generic source so
          // it's still findable.
          log("audio-session", event, data);
        }
      },
    };
  }
  /** Re-prime the Region Capture cropTarget on the active video
   *  track. Public hook the page calls after layout-changing events
   *  (fullscreen toggle) so the recording recovers a clean crop. */
  public async refreshVideoCrop(): Promise<void> {
    if (this.audio instanceof AudioSession) {
      await this.audio.refreshVideoCrop();
    }
  }

  /** Re-acquire the screen share after Chrome ended the original
   *  track (typically caused by moving the browser window between
   *  displays — Chrome invalidates tab-capture on display changes).
   *  Audio + transcript are unaffected; this only restarts the
   *  videoRecorder on a fresh share. Must be called from a user-
   *  gesture handler. Returns true if recovery succeeded. */
  public async resumeScreenShare(): Promise<boolean> {
    if (this.audio instanceof AudioSession) {
      return this.audio.resumeScreenShare();
    }
    return false;
  }

  /** Pause-then-refresh-then-resume around a known layout transition.
   *  Same machinery the zoom keydown / wheel listeners use, just
   *  triggered explicitly by the page when it's about to perform a
   *  React-driven layout change that isn't observable from the audio
   *  session itself (the canonical case is the Fullscreen toggle:
   *  React re-renders the wrapper, the cropTarget element's bounding
   *  box jumps, Chrome's Region Capture auto-tracking emits 1-3s of
   *  garbled frames). The handler:
   *    1. Pauses the videoRecorder immediately so no garbled frame
   *       is encoded
   *    2. After 500ms (layout settles, CSS transitions complete)
   *       fires refreshVideoCrop() to re-bind cropTo to the
   *       element's new bounds
   *    3. Waits 2 RAFs for the new crop to flush through the
   *       compositor, then resumes the recorder
   *
   *  Recording shows a frozen frame during the ~500ms transition —
   *  much better than 1-3 seconds of garbled output. Caller does
   *  NOT need to await; the transition runs async in the background. */
  public triggerCropTransition(reason: string): void {
    if (this.audio instanceof AudioSession) {
      this.audio.triggerCropTransition(reason);
    }
  }

  /** Pause the live session. Per user spec, this is a FULL pause —
   *  the underlying AudioSession releases the mic, closes its
   *  Deepgram socket, and stops MediaRecorders. The mic system
   *  indicator goes off. Accumulated audio/video chunks are kept
   *  on the AudioSession instance so resume() can continue the
   *  same recording. */
  async pause() {
    await this.audio?.pause();
    useStore.getState().setLiveStatus("paused");
    // While paused, mic is released and no utterances arrive by
    // definition — the silence check would always trigger. Stop it
    // so a paused-and-walked-away session doesn't get auto-saved
    // out from under the user. Resume re-arms.
    this.cancelIdleCheck();
  }

  /** Resume after a paused live session. Re-acquires the mic, re-
   *  opens Deepgram, restarts MediaRecorders. If the original session
   *  had captureSystemAudio enabled, the browser will re-prompt for
   *  tab/window share (unavoidable per browser security model — the
   *  share permission isn't held across the underlying getDisplayMedia
   *  release). */
  async resume() {
    await this.audio?.resume();
    useStore.getState().setLiveStatus("recording");
    this.sessionLastResumedAt = Date.now();
    this.idlePromptFired = false;
    this.armIdleCheck();
  }

  /** Public hook the UI calls when the user clicks "Continue
   *  recording" on the idle prompt — counts as activity, resets the
   *  silence baseline so the prompt doesn't immediately re-fire and
   *  auto-save doesn't trip in 3 more minutes. */
  public notifyUserStillActive(): void {
    this.lastTranscriptAt = Date.now();
    this.idlePromptFired = false;
    log("session", "idle-user-continue", {});
  }

  /** Periodic check: dispatch idle prompt at IDLE_PROMPT_MS, dispatch
   *  auto-save at IDLE_AUTO_SAVE_MS. New utterances reset the baseline
   *  via lastTranscriptAt; the user clicking "Continue" on the prompt
   *  resets via notifyUserStillActive(). */
  private armIdleCheck(): void {
    this.cancelIdleCheck();
    this.idleCheckTimer = setInterval(() => {
      const status = useStore.getState().live.status;
      if (status !== "recording") return;
      // lastTranscriptAt = 0 means no utterance has EVER arrived
      // since session start. Fall back to the resume timestamp so a
      // session that starts and immediately goes silent (mic share
      // issue, etc.) still triggers a prompt at the 2-min mark.
      const refTime = this.lastTranscriptAt || this.sessionLastResumedAt;
      if (refTime === 0) return;
      const idleMs = Date.now() - refTime;

      if (
        idleMs >= LiveOrchestrator.IDLE_AUTO_SAVE_MS &&
        typeof window !== "undefined"
      ) {
        // Auto-save threshold reached. Fire and stop the timer —
        // the page will run the End & Save flow which calls stop()
        // and clears state.
        log("session", "idle-auto-save", { idleMs });
        this.cancelIdleCheck();
        window.dispatchEvent(new CustomEvent("ic:auto-save-requested"));
        return;
      }
      if (
        idleMs >= LiveOrchestrator.IDLE_PROMPT_MS &&
        !this.idlePromptFired &&
        typeof window !== "undefined"
      ) {
        this.idlePromptFired = true;
        log("session", "idle-prompt", { idleMs });
        window.dispatchEvent(new CustomEvent("ic:idle-prompt"));
      }
    }, LiveOrchestrator.IDLE_CHECK_INTERVAL_MS);
  }

  private cancelIdleCheck(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  async stop() {
    log("session", "stop");
    this.cancelIdleCheck();
    if (this.classifyDebounceTimer) {
      clearTimeout(this.classifyDebounceTimer);
      this.classifyDebounceTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    // Cancel closing-detection timers up-front so they can't fire
    // mid-stop and dispatch ic:closing-detected (which would pop
    // a "session looks done?" prompt while the user is already in
    // the End flow). disableClosingDetection() is the public path,
    // also called from handleEndConfirm — this is belt-and-
    // suspenders for paths that bypass that hook.
    if (this.closingSilenceTimer) {
      clearTimeout(this.closingSilenceTimer);
      this.closingSilenceTimer = null;
    }
    if (this.closingHysteresisAutoTimer) {
      clearTimeout(this.closingHysteresisAutoTimer);
      this.closingHysteresisAutoTimer = null;
    }
    // Flush any residual listening hints onto the most recent
    // question. Common case: hint fired during the interviewer's
    // closing remarks ("here's what to expect from HR next week...")
    // and the session ends before another Lead locks. Attaching to
    // the last question keeps the hint in the transcript instead of
    // silently dropping it.
    if (this.pendingListeningHints.length > 0) {
      const store = useStore.getState();
      const lastQ = store.liveQuestions[store.liveQuestions.length - 1];
      if (lastQ) {
        this.drainPendingListeningHints(lastQ.id);
      } else {
        log("listen-hint", "drained-discarded", {
          reason: "no-question-locked",
          count: this.pendingListeningHints.length,
        });
        this.pendingListeningHints = [];
      }
    }
    if (!this.audio) return;
    await this.audio.stop();
    this.audio = null;
  }

  // ----- internals -----

  private async onUtterance(text: string, dgSpeaker?: number, duration?: number) {
    const clean = text.trim();
    if (!clean) return;
    // Belt-and-suspenders: drop any utterance that arrives after the
    // session has been stopped. AudioSession's onWsMessage already
    // gates by `stopped`, but the callback is bound at construction
    // time and async classify responses can still race the teardown.
    // `this.audio === null` is the orchestrator-level signal that
    // stop() finished; once null, any further onUtterance call is a
    // dangling Deepgram message from a half-closed socket and should
    // not fan out into addUtterance / classify.
    if (!this.audio) return;

    // === Phantom-dg fold ===
    // Must run BEFORE addUtterance (otherwise phantom dg pollutes
    // liveUtterances and the rolling-window captions logic ends up
    // showing fragmented single-word junk). Two cases:
    //   (a) Already in fold map → remap silently.
    //   (b) Brand-new dg with both roles already filled by OTHER dgs
    //       → Deepgram minted a phantom speaker label; populate fold
    //       map (default to the candidate role, which is by far the
    //       common case — interviewer voice is more stable on a
    //       headset/desk mic; candidate often shifts position and
    //       trips diarization mid-session). All subsequent utterances
    //       from this phantom dg also fold via case (a).
    if (dgSpeaker !== undefined && !this.preIdentified) {
      const mapped = this.dgFoldMap.get(dgSpeaker);
      if (mapped !== undefined) {
        log("roles", "fold-applied", { phantom: dgSpeaker, foldTo: mapped });
        dgSpeaker = mapped;
      } else {
        const roles = useStore.getState().liveSpeakerRoles;
        if (roles[dgSpeaker] === undefined) {
          const candidateDgs = Object.entries(roles)
            .filter(([, r]) => r === "candidate")
            .map(([d]) => Number(d));
          const interviewerDgs = Object.entries(roles)
            .filter(([, r]) => r === "interviewer")
            .map(([d]) => Number(d));
          if (candidateDgs.length > 0 && interviewerDgs.length > 0) {
            const foldTo = candidateDgs[0];
            this.dgFoldMap.set(dgSpeaker, foldTo);
            log("roles", "fold-mapped", {
              phantom: dgSpeaker,
              foldTo,
              note: "both-roles-filled-fold-into-existing-candidate",
            });
            dgSpeaker = foldTo;
          }
        }
      }
    }

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

    // ===== LIVE-MODE MANUAL SPEAKER ASSIGNMENT =====
    // Run this BEFORE adding the utterance to the store. Otherwise the
    // first utterance from a freshly-arrived dgSpeaker enters
    // liveUtterances + the debug log with role="?" — even if the
    // OPPOSITE-role auto-assign immediately commits the right role
    // afterward, captions briefly flash "?" and the persisted
    // `utterance:new` event records role="?" instead of the resolved
    // role. Reordering means the role is committed FIRST, so the
    // utterance log + captions render with the correct role on the
    // very first frame the speaker appears.
    //
    // When a new dgSpeaker appears:
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
      // Role lookup happens AFTER the assignment block above, so a
      // newly-arrived dg that just got auto-tagged shows the resolved
      // role here instead of "?".
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

    this.lastTranscriptAt = Date.now();
    // Short-circuit: when a pre-computed timeline is driving the UI
    // (upload mode with successful preanalyze), skip classify-moment +
    // commentary + hint triggers entirely. Utterances still landed in
    // liveUtterances above — that's all we need for the captions path.
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

  }

  /** Compute how long a piece of commentary should stay on screen
   *  before the next one of its kind (or the next hint) is
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
  /** Update the per-kind reading-protection state. Called at the end
   *  of any commentary stream that actually put content on screen.
   *  Q-A commentary doesn't call this — it has its own minMs gate via
   *  liveDisplayedComment. listen-hint and cand-q-cmt write here so
   *  REPEATS within the same kind defer correctly without blocking the
   *  OTHER kind. */
  private markCommentaryDisplayed(
    kind: "listen-hint" | "cand-q-cmt",
    text: string
  ): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (kind === "listen-hint") {
      this.lastListenHintText = trimmed;
      this.lastListenHintReadyAt = Date.now();
    } else {
      this.lastCandQCmtText = trimmed;
      this.lastCandQCmtReadyAt = Date.now();
    }
  }

  /**
   * Shared SSE streaming helper with exponential-backoff retry.
   *
   * Called by the commentary generators (Q-A, listening hint,
   * cand-q-cmt). Handles the fetch → stream → parse-SSE loop and retries
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
    kind: "commentary" | "listen-hint" | "cand-q-cmt",
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
  private async generateCandidateQuestionCommentary(
    candidateQuestion: string,
    /** Question.id of the kind="candidate" row this commentary attaches
     *  to. The orchestrator-side caller (applyMomentInner reverse-Q&A
     *  branch) creates this row + passes the id through so the streamed
     *  commentary can be persisted as a Comment(kind="cand-q-cmt") under
     *  it on completion. Optional for backward compat — undefined means
     *  "live-only, don't persist", which matches legacy behavior for any
     *  pre-2026-05 callers. */
    candidateQuestionId?: string
  ) {
    const {
      liveJd,
      liveResume,
      liveInterviewerProfile,
      liveInterviewerProfileSummary,
      commentLang,
      setLiveCandidateQuestionCommentary,
    } = useStore.getState();
    // Prefer the AI summary (~50 words) over the raw paste (~3000
    // words) — same coaching signal at a fraction of the input tokens.
    // Falls back to raw if the session-start summarization hasn't
    // returned yet, to None if neither is available.
    const interviewerProfileForCall =
      liveInterviewerProfileSummary || liveInterviewerProfile;
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
        interviewerProfile: interviewerProfileForCall,
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
      this.markCommentaryDisplayed("cand-q-cmt", accumulated);
      log("cand-q-cmt", "done", {
        chars: accumulated.length,
        readMs: this.computeReadingTimeMs(accumulated),
        preview: preview(accumulated, 100),
      });
      // Persist this commentary stream as a Comment(kind="cand-q-cmt")
      // under the candidate question. Without this, the in-memory
      // commentary is lost when endLive snapshots the session, leaving
      // PastView's Transcript with a candidate-question entry that has
      // an empty comments[] array — defeating the entire reverse-Q&A
      // surface. The store mutation matches what the listening-hint
      // path does (addCommentToQuestion); the only difference is kind.
      if (candidateQuestionId) {
        const commentId = `cand-q-cmt-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        useStore.getState().addCommentToQuestion(candidateQuestionId, {
          id: commentId,
          text: accumulated,
          atSeconds: useStore.getState().live.elapsedSeconds,
          kind: "cand-q-cmt",
        });
      }
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
    // Reading-protection: don't clobber the previous LISTENING HINT
    // while it's still inside its content-length-based min-display
    // window. Cross-kind defers (Q-A or cand-q-cmt blocking a listen-
    // hint) were removed — those occupy different logical phases of
    // the UI; a stale Q-A reading window shouldn't block a hint that
    // belongs to the interviewer's current monologue.
    if (this.lastListenHintReadyAt > 0 && this.lastListenHintText) {
      const required = computeMinDisplayMs(this.lastListenHintText);
      const elapsed = Date.now() - this.lastListenHintReadyAt;
      if (elapsed < required) {
        log("listen-hint", "deferred-reading", {
          elapsedMs: elapsed,
          requiredMs: required,
          prev: preview(this.lastListenHintText, 60),
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

    const {
      liveJd,
      liveResume,
      liveInterviewerProfile,
      liveInterviewerProfileSummary,
      commentLang,
      setLiveListeningHint,
    } = useStore.getState();
    // See generateCandidateQuestionCommentary for the rationale —
    // prefer the AI summary, fall back to the raw paste.
    const interviewerProfileForCall =
      liveInterviewerProfileSummary || liveInterviewerProfile;

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
          interviewerProfile: interviewerProfileForCall,
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
        this.markCommentaryDisplayed("listen-hint", accumulated);
        // Buffer this hint for attachment to the next Lead question
        // that locks. We don't have a question yet (state is
        // interviewer_speaking by definition when hints fire), so we
        // can't write it to the store directly — drainPendingListening
        // Hints picks it up on the next commitLead / addFollowUpAndStart
        // / archiveCurrentMainAndStartNew. Falls through to endLive's
        // flush if the session ends before another Lead locks.
        this.pendingListeningHints.push({
          id: rand("c"),
          text: accumulated,
          atSeconds: useStore.getState().live.elapsedSeconds,
          // Capture the monologue snapshot the AI just saw — see the
          // pendingListeningHints type docblock for why time-window
          // recovery doesn't work.
          contextText: monologue,
        });
        log("listen-hint", "done", {
          chars: accumulated.length,
          readMs: this.computeReadingTimeMs(accumulated),
          preview: preview(accumulated, 100),
          buffered: this.pendingListeningHints.length,
        });
      }
    } finally {
      this.pendingListeningHint = false;
    }
  }

  /** Drain the buffered listening hints onto the given question as
   *  listening-kind comments. Called from each Lead-commit path so the
   *  hint that fired during the preceding interviewer monologue lands
   *  under the question that monologue led into. No-op when buffer is
   *  empty. */
  private drainPendingListeningHints(questionId: string): void {
    if (this.pendingListeningHints.length === 0) return;
    const store = useStore.getState();
    const drained = this.pendingListeningHints;
    this.pendingListeningHints = [];
    for (const h of drained) {
      store.addCommentToQuestion(questionId, {
        id: h.id,
        text: h.text,
        atSeconds: h.atSeconds,
        kind: "listening",
        contextText: h.contextText,
      });
    }
    log("listen-hint", "drained-to-question", {
      questionId,
      count: drained.length,
    });
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
      this.cancelClosingHysteresisAutoTimer("classifier-agrees");
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
        // If the pending state is "closing", arm the silence auto-
        // confirm timer (a real goodbye followed by silence won't
        // produce another classify cycle to provide the second vote).
        // Any other pending state cancels an in-flight closing auto-
        // timer — we're no longer drifting toward closing.
        if (next === "closing") {
          this.armClosingHysteresisAutoTimer(summary, questionText, rel, candidateQuestion);
        } else {
          this.cancelClosingHysteresisAutoTimer("pending-flipped-away");
        }
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
      this.cancelClosingHysteresisAutoTimer("vote-confirmed");
    } else {
      // question_finalized: bypass hysteresis. The 4-layer filter
      // decides whether to actually lock the Q; clear any stale
      // pending to avoid a chitchat vote holding across a real Q.
      this.momentHysteresisPending = null;
      this.cancelClosingHysteresisAutoTimer("question-finalized");
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
    // Mark reverse-Q&A exit BEFORE branching so all exit paths
    // (including direct → question_finalized) get the timestamp.
    // queueLeadValidation reads this to apply the post-reverse-Q&A
    // cooldown that blocks rhetorical-Q false positives during
    // interviewer mid-answer.
    const prevState = store.liveMomentState.state;
    if (prevState === "candidate_questioning" && next !== "candidate_questioning") {
      this.lastExitedCandidateQuestioningAt = Date.now();
    }
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
      store.setDisplayedComment(null);
      store.setAnswerInProgress(false);
      // Clear any locked Probe Q — reverse Q&A starts; the prior
      // Lead/Probe context is closed.
      useStore.getState().setLiveLockedProbeQuestion(null);
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
      // Always update the moment state's candidateQuestion text — the
      // store's text reflects the latest classifier output even when we
      // dedup or defer the commentary fire. Spec: "只静默更新内部 candQ
      // 文本" — UI's currently-displayed commentary stays put.
      store.setMomentState({
        state: "candidate_questioning",
        summary,
        candidateQuestion: cq,
      });
      if (cq === prevCq) return;

      // === Layer A: Jaccard-similarity dedup ===
      // Mirrors the lead-question `restated-Q` filter. The classifier
      // re-emits a single logical question 2-4 times during the
      // candidate's monologue with slightly varied wording each tick
      // ("are there any restrictions or on-site requirements...",
      //  "I just want to make sure that you saw, like, any restrictions...",
      //  "can you clarify any restrictions on the remote position...").
      // All share enough tokens that Jaccard ≫ 0.5; we treat them as
      // one question and silently skip the fresh API call. The store's
      // `candidateQuestion` text was already updated above, so the UI
      // shows the latest text — only the *commentary* is preserved.
      const sinceLastCandQCommit = Date.now() - this.lastCandQCommitAt;
      if (
        this.lastCommittedCandQText &&
        sinceLastCandQCommit < CAND_Q_DEDUP_COOLDOWN_MS &&
        this.isSemanticallySimilar(cq, this.lastCommittedCandQText)
      ) {
        log("candidate-q", "dedup", {
          text: preview(cq, 60),
          sinceLastMs: sinceLastCandQCommit,
          prev: preview(this.lastCommittedCandQText, 60),
        });
        return;
      }

      // === Layer B: read-gate ===
      // Don't replace an actively-displayed CAND-Q-CMT while it's still
      // inside its content-length-derived min-display window. A 472-
      // char cand-q-cmt needs ~70s of reading time; firing a new one
      // 6s later (because the classifier emitted a slightly different
      // wording of the same intent that slipped past Jaccard, or even
      // a genuinely different question that arrived too fast) yanks
      // it off screen mid-read.
      //
      // CAP at CAND_Q_MAX_READ_GATE_MS (25s): in the reverse-Q&A
      // phase the candidate cycles through 3-5 questions in 1-2
      // minutes — they're not stopping to fully reread a 70-second
      // hint between each. Without a cap, the read-gate held the
      // channel open long enough that 7 of 11 follow-up commentaries
      // got dropped on the Uber session (post-mortem 2026-05-06).
      // 25s is enough to skim a typical hint but short enough that
      // a genuinely new candidate question gets coaching.
      //
      // Per-kind defer only: a stale listening-hint reading window
      // does NOT block a fresh cand-q-cmt anymore. Phase has changed
      // (interviewer monologue → reverse Q&A); the UI slot has
      // already turned over.
      const CAND_Q_MAX_READ_GATE_MS = 25_000;
      if (this.lastCandQCmtReadyAt > 0 && this.lastCandQCmtText) {
        const computed = computeMinDisplayMs(this.lastCandQCmtText);
        const required = Math.min(computed, CAND_Q_MAX_READ_GATE_MS);
        const elapsed = Date.now() - this.lastCandQCmtReadyAt;
        if (elapsed < required) {
          log("cand-q-cmt", "deferred-reading", {
            elapsedMs: elapsed,
            requiredMs: required,
            computedMs: computed,
            cappedAt: CAND_Q_MAX_READ_GATE_MS,
            prev: preview(this.lastCandQCmtText, 60),
            droppedCq: preview(cq, 60),
          });
          return;
        }
      }

      // Cleared both gates — fire a fresh generation.
      // Update the dedup state AT FIRE TIME (not only on stream
      // completion) so subsequent variants emitted during the API call
      // are also deduped against this commit, not just against whatever
      // committed before this one.
      this.lastCandQCommitAt = Date.now();
      this.lastCommittedCandQText = cq;
      // Lock the candidate-question text for the Phase bar. Mirrors the
      // Lead-Question lock semantics: once a candidate question is
      // "established" (passed both gates), keep it on screen until a
      // new candidate question commits or a Lead Question locks. Without
      // this lock, two things go wrong:
      //   (a) Within candidate_questioning the classifier re-emits
      //       slightly varied wording each tick and the Phase bar
      //       flickers between rephrasings of the same logical Q.
      //   (b) When the interviewer is mid-answer, the moment-state
      //       machine briefly transits to interviewer_speaking /
      //       chitchat (hysteresis can flip on a long answer), and the
      //       UI loses the candidate question — falling back to
      //       "Interview Ongoing" while the answer to that exact
      //       question is being delivered.
      // Lock + UI-side `!mainQuestion` gate together solve both.
      useStore.getState().setLiveLockedCandidateQuestion(cq);
      useStore.getState().setLiveCandidateQuestionCommentary("");
      // Persist this candidate question as a Question row with
      // kind="candidate" so it survives endLive into PastView's
      // Transcript. Without this row the AI commentary on the
      // question (cand-q-cmt) would have no attachment point in the
      // existing comments-belong-to-questions schema, and the entire
      // reverse-Q&A phase would be lost from the Past view.
      // ID prefix is "cand-q-" so it's visually distinct from the
      // interviewer-question IDs ("q-…") in logs and DB queries.
      const candQId = `cand-q-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const askedAtSec = useStore.getState().live.elapsedSeconds;
      useStore.getState().addQuestion({
        id: candQId,
        text: cq,
        askedAtSeconds: askedAtSec,
        comments: [],
        kind: "candidate",
        // parentQuestionId / answerText intentionally undefined — these
        // are interviewer-question concepts that don't apply.
      });
      log("candidate-q", "new", {
        text: preview(cq, 80),
        candQId,
        atSec: askedAtSec,
      });
      void this.generateCandidateQuestionCommentary(cq, candQId);
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
    if (next === "interviewer_speaking") {
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
   *  Skips if we're inside the cooldown window from a prior fire or
   *  user dismissal. */
  private armClosingSilenceTimer(): void {
    const now = Date.now();
    if (now < this.closingDetectionMutedUntil) {
      log("closing", "muted", {
        remainingMs: this.closingDetectionMutedUntil - now,
      });
      return;
    }
    if (this.closingSilenceTimer) {
      clearTimeout(this.closingSilenceTimer);
    }
    log("closing", "armed", {
      ms: LiveOrchestrator.CLOSING_SILENCE_MS,
    });
    this.closingSilenceTimer = setTimeout(() => {
      this.closingSilenceTimer = null;
      const fireNow = Date.now();
      if (fireNow < this.closingDetectionMutedUntil) return;
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
      // Mute future fires for 30s so we don't re-fire while the modal
      // is still on screen. The user's choice (Save / Continue) extends
      // this — see disableClosingDetection.
      this.closingDetectionMutedUntil =
        fireNow + LiveOrchestrator.CLOSING_FIRE_COOLDOWN_MS;
      log("closing", "fired", {});
      // Dispatch to the UI. Caught by LiveView, which renders the
      // "Save now?" confirmation dialog. If the user picks "continue
      // recording", they'll call disableClosingDetection() which
      // extends the mute window to a longer cooldown.
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

  /** Arm the silence auto-confirm timer for a pending closing transit.
   *  See `closingHysteresisAutoTimer` doc for rationale. Args mirror
   *  applyMomentInner so we can replay the commit at fire time with
   *  the same context the original classify response carried. */
  private armClosingHysteresisAutoTimer(
    summary: string,
    questionText: string,
    rel: QuestionRelation,
    candidateQuestion: string
  ): void {
    if (this.closingHysteresisAutoTimer) {
      clearTimeout(this.closingHysteresisAutoTimer);
    }
    log("closing", "hysteresis-auto-armed", {
      ms: LiveOrchestrator.CLOSING_SILENCE_AUTOCONFIRM_MS,
    });
    this.closingHysteresisAutoTimer = setTimeout(() => {
      this.closingHysteresisAutoTimer = null;
      // Re-check: pending might have flipped to a different state in
      // the meantime, OR a fresh utterance might have transitioned us
      // out of the "drifting toward closing" zone.
      const p = this.momentHysteresisPending;
      if (!p || p.state !== "closing") {
        log("closing", "hysteresis-auto-skip", {
          reason: "pending-not-closing",
        });
        return;
      }
      const msSinceLastUtterance = this.lastTranscriptAt
        ? Date.now() - this.lastTranscriptAt
        : Infinity;
      if (
        msSinceLastUtterance < LiveOrchestrator.CLOSING_SILENCE_AUTOCONFIRM_MS
      ) {
        log("closing", "hysteresis-auto-skip", {
          reason: "speech-after-arm",
          msSinceLastUtterance,
        });
        return;
      }
      // Treat the silence as the second confirmation vote. Clear the
      // pending counter and commit the closing transit, which arms the
      // 3-second silence-then-fire timer in armClosingSilenceTimer.
      log("closing", "hysteresis-auto-confirm", {});
      this.momentHysteresisPending = null;
      try {
        this.applyMomentInner(
          "closing",
          summary,
          questionText,
          rel,
          candidateQuestion
        );
      } finally {
        const after = useStore.getState().liveMomentState.state;
        log("moment", "transit", {
          from: "<auto-confirm>",
          to: after,
          rel,
        });
      }
    }, LiveOrchestrator.CLOSING_SILENCE_AUTOCONFIRM_MS);
  }

  /** Cancel the closing hysteresis auto-confirm timer. Called whenever
   *  hysteresis pending clears or flips to a non-closing state. */
  private cancelClosingHysteresisAutoTimer(reason: string): void {
    if (this.closingHysteresisAutoTimer) {
      clearTimeout(this.closingHysteresisAutoTimer);
      this.closingHysteresisAutoTimer = null;
      log("closing", "hysteresis-auto-cancel", { reason });
    }
  }

  /** Public hook for the UI to call when the user picks "continue
   *  recording" from the closing-detected dialog. Mutes closing
   *  detection for CLOSING_DISMISS_COOLDOWN_MS (default 5 min) — long
   *  enough that the user isn't repeatedly nagged during ongoing small
   *  talk, short enough that a real goodbye 5-10 minutes later still
   *  triggers the prompt. The previous behavior of permanently
   *  disabling for the session caused real end-of-interview goodbyes
   *  to silently miss the prompt. */
  public disableClosingDetection(): void {
    this.closingDetectionMutedUntil =
      Date.now() + LiveOrchestrator.CLOSING_DISMISS_COOLDOWN_MS;
    this.cancelClosingSilenceTimer("user-dismissed-dialog");
    // Also cancel the hysteresis-auto-confirm timer. Without this,
    // an in-flight 8s timer from a recent classifier "closing"
    // proposal can fire AFTER the user has already clicked End,
    // dispatching ic:closing-detected and popping the "Looks like
    // the interview just wrapped up" prompt mid-stop. That prompt
    // confused users into clicking through it during the End flow,
    // routing through a SECOND handleEndConfirm and racing the
    // first one to a corrupted save.
    if (this.closingHysteresisAutoTimer) {
      clearTimeout(this.closingHysteresisAutoTimer);
      this.closingHysteresisAutoTimer = null;
      log("closing", "hysteresis-auto-cancel", {
        reason: "disable-closing-detection",
      });
    }
    log("closing", "muted-cooldown", {
      cooldownMs: LiveOrchestrator.CLOSING_DISMISS_COOLDOWN_MS,
    });
  }

  /** Public hook for the UI to call AFTER the user picks a role from
   *  the speaker-identity prompt (resolveSpeakerPrompt has already
   *  committed the chosen dg's role).
   *
   *  Why this exists: the auto-assign branch in onUtterance ("if one
   *  side has a role, the new dg gets the OPPOSITE role") only fires
   *  when an unassigned dg PRODUCES an utterance. Common race:
   *    1. dg:0 speaks first → prompt fires for dg:0
   *    2. dg:1 speaks (still unassigned, prompt for dg:0 still up)
   *       → fall-through (both roles unfilled, prompt already pending)
   *    3. User tags dg:0 as interviewer
   *    4. dg:1 doesn't speak again for a long time
   *    → dg:1 never auto-assigns to candidate, captions stay broken.
   *
   *  Fix: when the prompt resolves, immediately walk knownDgSpeakers
   *  and auto-assign any unassigned ones using the same OPPOSITE-role
   *  rule. Since the prompt just committed exactly one role, every
   *  other known dg gets the other role. */
  public notifySpeakerPromptResolved(): void {
    const state = useStore.getState();
    const committed = state.liveSpeakerRoles;
    const hasInterviewer = Object.values(committed).includes("interviewer");
    const hasCandidate = Object.values(committed).includes("candidate");
    // Both sides already filled or nothing to fill — nothing to do.
    if (hasInterviewer === hasCandidate) return;
    const fillRole: "interviewer" | "candidate" = hasInterviewer
      ? "candidate"
      : "interviewer";
    const updates: Record<number, "interviewer" | "candidate"> = {};
    for (const dg of this.knownDgSpeakers) {
      if (committed[dg] === undefined) {
        updates[dg] = fillRole;
      }
    }
    if (Object.keys(updates).length === 0) return;
    state.mergeSpeakerRoles(updates);
    for (const [dg, role] of Object.entries(updates)) {
      log("roles", "auto-after-resolve", { dg: Number(dg), role });
    }
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
   *  transcript? Classifier can hallucinate — if the proposed text
   *  shares <GROUNDING_MIN_TOKEN_MATCH of its non-stop tokens with
   *  what was actually said in the last GROUNDING_RECENT_SEC seconds,
   *  treat as a hallucination. Pure local check, zero cost / zero
   *  latency.
   *
   *  Diarization-fold safety: we no longer restrict the haystack to
   *  utterances tagged "interviewer". Deepgram occasionally splits a
   *  single candidate or interviewer into two phantom speaker IDs;
   *  the live system folds them back later but during the few
   *  seconds before fold-applied lands, real interviewer text can be
   *  filed under "candidate". The Uber session post-mortem
   *  (2026-05-06) caught this: 3 substantive interviewer questions
   *  were L1-failed because their tokens lived in mis-tagged
   *  utterances. Including the full transcript as the haystack still
   *  catches the real hallucination case (fabricated text doesn't
   *  appear in EITHER role's recent speech) without being defeated
   *  by diarization wobble. */
  private isGrounded(questionText: string): boolean {
    const store = useStore.getState();
    const nowSec = store.live.elapsedSeconds;
    const recentCutoff = nowSec - GROUNDING_RECENT_SEC;
    const recentText: string[] = [];
    for (const u of store.liveUtterances) {
      if (u.atSeconds < recentCutoff) continue;
      recentText.push(u.text.toLowerCase());
    }
    const haystack = recentText.join(" ");
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
   *  stack latency.
   *
   *  When we're inside REVERSE_QA_LEAD_COOLDOWN_MS of exiting candidate_
   *  questioning, pass `priorWasCandidateQuestioning: true` so the
   *  verifier biases stricter against rhetorical-Q false positives in
   *  the interviewer's mid-answer narration. Method-A's hard reject
   *  catches the common case (candidate hasn't answered yet); Method-B
   *  here is the deeper safeguard for cases where A passes (candidate
   *  has spoken some but interviewer is still narrating). */
  private async runConfirmPass(
    questionText: string
  ): Promise<"done" | "still_setting_up" | "not_a_question"> {
    const sample = this.buildClassifySample();
    const sinceExitMs =
      this.lastExitedCandidateQuestioningAt > 0
        ? Date.now() - this.lastExitedCandidateQuestioningAt
        : Number.POSITIVE_INFINITY;
    const priorWasCandidateQuestioning =
      sinceExitMs < REVERSE_QA_LEAD_COOLDOWN_MS;
    // Maturity hints for the L2 verifier — relaxes the
    // "still_setting_up" rejection in late-session sessions where
    // short logistics questions ("Where are you located?") were
    // historically being eaten by the verifier biased for setup-phase
    // signals.
    const store = useStore.getState();
    const sessionElapsedSec = store.live.elapsedSeconds;
    const priorLeadCount = store.liveQuestions.filter(
      (q) => !q.parentQuestionId
    ).length;
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
          priorWasCandidateQuestioning,
          sessionElapsedSec,
          priorLeadCount,
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
    // Pre-L0 gate: reverse-Q&A cooldown. The interviewer just exited
    // candidate_questioning (was answering a candidate's reverse Q),
    // and a Lead-Q proposal arriving within the cooldown window is
    // highly suspicious — interviewer mid-answer often contains
    // syntactic-question fragments ("what are the default drivers?")
    // that are narration, not directed questions. We require evidence
    // the candidate has actually started answering (pendingAnswerBuffer
    // above min-chars) before allowing a Lead lock during this window.
    // If past the window or candidate has spoken substantively, fall
    // through to standard 4-layer filtering.
    if (this.lastExitedCandidateQuestioningAt > 0) {
      const sinceExitMs = Date.now() - this.lastExitedCandidateQuestioningAt;
      if (
        sinceExitMs < REVERSE_QA_LEAD_COOLDOWN_MS &&
        this.pendingAnswerBuffer.length < REVERSE_QA_ANSWER_MIN_CHARS
      ) {
        log("filter", "reverse-qa-cooldown", {
          sinceExitMs,
          pendingAnswerLen: this.pendingAnswerBuffer.length,
          requiredChars: REVERSE_QA_ANSWER_MIN_CHARS,
          text: preview(text, 60),
        });
        return;
      }
    }

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
    // Don't cancel if the candidate has ALREADY substantively answered
    // the pending Lead. In that case the interviewer's continuation is
    // a follow-up reaction ("oh wait, I see Texas on your resume...")
    // not "I wasn't done asking" — the original question landed, was
    // answered, and the proposed Lead should still commit.
    //
    // Threshold mirrors REVERSE_QA_ANSWER_MIN_CHARS — same logic, same
    // floor. Without this guard, late-session questions like "Where
    // are you located?" got eaten by L3 every time the interviewer
    // interjected after a brief candidate reply.
    const REPLY_LANDED_MIN_CHARS = 30;
    if (this.pendingAnswerBuffer.length >= REPLY_LANDED_MIN_CHARS) {
      log("filter", "L3-interviewer-continued-ignored", {
        reason: "candidate-already-answering",
        answerChars: this.pendingAnswerBuffer.length,
        text: preview(this.pendingLead.text, 60),
      });
      return;
    }
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
    // Clear any locked candidate question. Interviewer asking a fresh
    // Lead supersedes whatever the candidate was previously asking —
    // the Phase bar should now show the Lead, not the stale candidate
    // question. (Locked candQ persists across moment-state transitions
    // specifically so it survives interviewer mid-answer chitchat
    // flicker; only a Lead-Question commit resets it.)
    useStore.getState().setLiveLockedCandidateQuestion(null);

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
    // Drain any listening hints that fired during the preceding
    // interviewer monologue (typically the team intro / case setup
    // before the first Lead) — they belong under this question in the
    // PastView transcript.
    this.drainPendingListeningHints(q.id);
    // Defensive: clear any locked Probe Q. Pre-anchored path means
    // there was no current Lead before, so no probe could be locked —
    // but if a prior session's state somehow leaked through, this is
    // the right moment to reset.
    store.setLiveLockedProbeQuestion(null);
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
    // Drain any listening hints that fired during the preceding
    // interviewer monologue onto this Probe.
    this.drainPendingListeningHints(q.id);
    // Lock the Probe Q text. Mirrors the Lead-Q lock pattern: the Phase
    // bar's Probe sub-row should persist as long as this probe is the
    // active sub-question of the current Lead, even when the moment
    // state machine briefly oscillates (interviewer_speaking ↔
    // question_finalized during a long answer flap). The
    // currentQuestionId-based display already works in steady state but
    // the lock survives any transient null-frame between state updates.
    // Cleared by:
    //   - archiveCurrentMainAndStartNew (interviewer pivots to new Lead)
    //   - pre-anchored first-Lead path (defensive — no probe was active)
    //   - candidate_questioning entry (reverse Q&A starts)
    //   - session reset
    store.setLiveLockedProbeQuestion(text);
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
    // NOTE: do NOT call setCurrentQuestionId(null) here before addQuestion.
    // addQuestion atomically sets currentQuestionId = newQ.id, so the
    // explicit pre-clear was redundant — and it caused a one-frame flicker
    // where currentQuestionId was null between the two store updates,
    // briefly dropping the Phase bar to "Interview Ongoing" before
    // re-rendering with the new Lead. Archiving is implicit: old Qs stay
    // in liveQuestions array; the "Earlier in this interview" filter
    // picks them up via parentQuestionId / askedAtSeconds.
    const q: Question = {
      id: rand("q"),
      text,
      askedAtSeconds: store.live.elapsedSeconds,
      comments: [],
    };
    store.addQuestion(q);
    // Drain any listening hints that fired during the preceding
    // interviewer monologue onto this new Lead.
    this.drainPendingListeningHints(q.id);
    // Clear the locked Probe Q text — interviewer pivoted to a new Lead,
    // any prior probe is now stale.
    store.setLiveLockedProbeQuestion(null);
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

    const {
      liveJd,
      liveResume,
      liveInterviewerProfile,
      liveInterviewerProfileSummary,
      commentLang,
      addCommentToQuestion,
      live,
    } = useStore.getState();
    // See generateCandidateQuestionCommentary for the rationale —
    // prefer the AI summary, fall back to the raw paste.
    const interviewerProfileForCall =
      liveInterviewerProfileSummary || liveInterviewerProfile;

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
          interviewerProfile: interviewerProfileForCall,
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
        // Q-A commentary doesn't write to the shared reading-protection
        // state anymore. Each kind tracks its own; Q-A is gated by
        // liveDisplayedComment.minMs (set above) which is its native
        // mechanism. Cross-kind blocking caused listening-hint reading
        // windows to defer cand-q-cmt unnecessarily — fixed by the
        // per-kind split.
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
