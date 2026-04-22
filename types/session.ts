// Core domain types for an interview session.
// Questions preserve their original language (never translated).
// Only Commentary adapts to the user's selected language.

export type CommentLanguage = "en" | "zh";

export type Speaker = "interviewer" | "candidate" | "unknown";

/** State of the current moment — what's happening in the room right now.
 *  Drives the top bar in the live view. */
export type MomentStateKind =
  | "idle"                  // session just started, nothing classified yet
  | "chitchat"              // small talk, intros, audio check
  | "interviewer_speaking"  // interviewer is mid-question, not yet finalized
  | "question_finalized";   // a complete question is ready; commentary can flow

export interface MomentState {
  state: MomentStateKind;
  /** One-line human-readable summary, shown in the top bar. */
  summary: string;
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
}

/** Transient state during a live recording. */
export interface LiveState {
  status: "idle" | "recording" | "paused";
  elapsedSeconds: number;
  /** Current question being answered (top of the feed). null before first question detected. */
  currentQuestionId: string | null;
}
