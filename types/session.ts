// Core domain types for an interview session.
// Questions preserve their original language (never translated).
// Only Commentary adapts to the user's selected language.

export type CommentLanguage = "en" | "zh";

export type Speaker = "interviewer" | "candidate" | "unknown";

/** Locally-stored user identity. There is no backend — signing in just
 *  records a name + email so the sidebar can show it and past sessions can
 *  be attributed. Null means "not signed in". */
export interface User {
  name: string;
  email: string;
}

/** State of the current moment — what's happening in the room right now.
 *  Drives the top bar in the live view. */
export type MomentStateKind =
  | "idle"                  // session just started, nothing classified yet
  | "chitchat"              // small talk, intros, audio check
  | "interviewer_speaking"  // interviewer is mid-question, not yet finalized
  | "question_finalized"    // a complete question is ready; commentary can flow
  | "candidate_questioning"; // reverse Q&A: candidate is asking the interviewer
                              // questions ("what does the team look like?",
                              // "what's the day-to-day?"). UI top bar switches
                              // to "Candidate's Question" mode and commentary
                              // evaluates the QUESTION quality, not an answer.

export interface MomentState {
  state: MomentStateKind;
  /** One-line human-readable summary, shown in the top bar. */
  summary: string;
  /** When state === "candidate_questioning", the candidate's current question
   *  text (in the language they used). Shown in the top bar. Carried on the
   *  MomentState so a single setMomentState call can update both phase + text
   *  atomically. Undefined for all other states. */
  candidateQuestion?: string;
}

/** A finalized chunk of transcript. The role (interviewer/candidate) is
 *  NOT stored — it's derived at render time from the session's speaker-role
 *  map, so identity changes (after Haiku identification) automatically
 *  re-label all historical utterances. */
export interface Utterance {
  id: string;
  /** Deepgram speaker number (0, 1, 2, ...). undefined if diarization couldn't assign. */
  dgSpeaker?: number;
  text: string;
  /** Seconds from session start when the utterance was finalized. */
  atSeconds: number;
  /** Length of audio this segment covers, in seconds. From Deepgram's per-
   *  Results "duration" field. Used to compute the live-captions window
   *  (last N seconds of actual SPEAKING time, not wall-clock). */
  duration?: number;
}

/** A single piece of AI commentary on what the candidate just said. */
export interface Comment {
  id: string;
  text: string; // may contain <strong>, <em> HTML tags
  /** Seconds from session start when this comment was generated. */
  atSeconds: number;
}

/** An interviewer's question + all commentary on the candidate's answer. */
export interface Question {
  id: string;
  /** Original text of the question, in the language the interviewer used. */
  text: string;
  /** Seconds from session start when the question was detected. */
  askedAtSeconds: number;
  /** Newest-first ordering is a UI concern; we store chronological. */
  comments: Comment[];
  /** If this question is a follow-up that drills into a parent main question,
   *  the parent's id. undefined for top-level (main) questions. Follow-ups
   *  archive together with their main when a new_topic question arrives. */
  parentQuestionId?: string;
}

/** Tracking for the single piece of commentary currently shown in the live
 *  pane. New commentary that arrives while the displayed one is still in its
 *  minimum-display window is DROPPED — no queue. */
export interface DisplayedComment {
  /** Matches a Comment.id under one of the live questions. */
  id: string;
  /** Which question this comment belongs to (so we can stop showing it when
   *  the question changes). */
  questionId: string;
  /** ms timestamp when the comment finished streaming and entered display. */
  displayedAt: number;
  /** Minimum ms this comment must remain on screen before being replaced. */
  minMs: number;
}

/** Kinds of phase in an upload-mode timeline. Mirrors the derived
 *  phase taxonomy used by the live view but is produced up-front by the
 *  /api/preanalyze-recording endpoint.
 *
 *  "candidate_asking" covers the reverse-Q&A tail of a session: the
 *  interviewer has finished their questions and turned the floor over
 *  ("any questions for me?"), and the candidate is now asking. UI
 *  renders this as its own top-bar phase ("Candidate Q&A") with the
 *  candidate's current question as the content.
 */
export type PhaseKind =
  | "chitchat"
  | "interviewer_asking_first"
  | "interviewer_probing"
  | "candidate_answering"
  | "between_questions"
  | "candidate_asking";

/** Pre-computed coaching timeline for an uploaded recording. Lets the
 *  live view render correct phase / question / commentary / listening
 *  hint for any playback position, including after a seek. */
export interface RecordingTimeline {
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
  listeningHints: Array<{
    id: string;
    atSec: number;
    text: string;
  }>;
  phases: Array<{
    fromSec: number;
    kind: PhaseKind;
    questionId?: string;
  }>;
}

/** Overall end-of-session assessment produced by /api/score-session.
 *  Computed once when the session ends and cached on the Session so the
 *  past-session view can redisplay without re-calling the model. */
export interface SessionScore {
  /** Sum of judged dimension scores. 0 when verdict is "insufficient_data". */
  total: number;
  /** Sum of `max` across judged dimensions. 100 when all five were judged,
   *  smaller when some were N/A. 0 when verdict is "insufficient_data". */
  totalMax: number;
  /** Percentage = total / totalMax * 100, rounded. Used for the verdict
   *  thresholds so pro-rated totals still map to the same pass/fail bands. */
  percent: number;
  /** Verdict. "insufficient_data" when the transcript didn't contain enough
   *  content for the model to form a judgment (e.g. 2-minute session with
   *  only pleasantries). */
  verdict:
    | "strong_pass"
    | "pass"
    | "borderline"
    | "fail"
    | "insufficient_data";
  /** One or two sentence overall summary of how the interview went. When
   *  verdict is "insufficient_data", this is the REASON why — e.g. "Only
   *  one substantive question was asked; not enough to judge."
   */
  summary: string;
  /** Per-dimension breakdown. `score` is null when the dimension couldn't
   *  be judged from the available transcript (e.g. Role Fit when no JD-
   *  aligned questions were asked) — in that case `justification` explains
   *  why and the dimension is excluded from `total` / `totalMax`. */
  dimensions: Array<{
    /** Stable identifier: one of
     *  question_addressing | specificity | depth | role_fit | communication */
    key: string;
    /** Human-readable label, e.g. "Question Addressing". */
    label: string;
    /** Max points for this dimension (25 / 25 / 20 / 15 / 15). */
    max: number;
    /** Points awarded, 0 .. max. null = not assessable from transcript. */
    score: number | null;
    /** One-line justification tied to moments from the transcript (or, when
     *  `score` is null, the reason this dimension couldn't be judged). */
    justification: string;
  }>;
  /** 2–3 actionable suggestions referencing specific moments. May be empty
   *  when verdict is "insufficient_data". */
  improvements: string[];
}

export interface Session {
  id: string;
  title: string;
  jd: string;
  resume: string; // may be empty
  questions: Question[];
  /** When the session started, ISO string. */
  startedAt: string;
  /** Duration in seconds. Set when the session is ended. */
  durationSeconds: number;
  /** Raw audio blob URL (object URL, lost on refresh since we don't persist). */
  audioUrl?: string;
  /** Overall assessment — undefined while scoring is in flight or if it failed. */
  score?: SessionScore;
}

/** Transient state during a live recording. */
export interface LiveState {
  status: "idle" | "recording" | "paused";
  elapsedSeconds: number;
  /** Current question being answered (top of the feed). null before first question detected. */
  currentQuestionId: string | null;
}
