// Core domain types for an interview session.
// Questions preserve their original language (never translated).
// Only Commentary adapts to the user's selected language.

export type CommentLanguage = "en" | "zh";

export type Speaker = "interviewer" | "candidate" | "unknown";

/** A finalized chunk of transcript with its detected speaker. */
export interface Utterance {
  id: string;
  speaker: Speaker;
  text: string;
  /** Seconds from session start when the utterance was finalized. */
  atSeconds: number;
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
