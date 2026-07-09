// Core domain types for an interview session.
// Questions preserve their original language (never translated).
// Only Commentary adapts to the user's selected language.

export type CommentLanguage = "en" | "zh";

export type Speaker = "interviewer" | "candidate" | "unknown";

/** User identity. Signing in client-side validates the (alpha) hardcoded
 *  admin credential, then calls /api/users/upsert which inserts or
 *  finds a row in `users` and returns its UUID. The UUID lives on
 *  `userId` and is sent as `x-user-id` on every persistence call so
 *  the server can attribute sessions. Null means "not signed in".
 *
 *  When DATABASE_URL isn't configured (local dev without DB) the
 *  upsert short-circuits and `userId` stays undefined — store falls
 *  back to localStorage-only persistence (the legacy path). */
export interface User {
  name: string;
  email: string;
  /** Server-issued UUID. Undefined when DB isn't reachable
   *  (local-dev-without-DB or upsert failed) — persistence calls
   *  silently no-op in that state. */
  userId?: string;
}

/** State of the current moment — what's happening in the room right now.
 *  Drives the top bar in the live view.
 *
 *  NOTE: a former "chitchat" state was merged into "interviewer_speaking"
 *  after the 5-state UI consolidation. The UI no longer rendered chitchat
 *  distinctly (collapsed into "Interview Ongoing"), and chitchat didn't
 *  gate any commentary trigger differently from interviewer_speaking —
 *  classifier wobble between the two used to lose candidate utterances
 *  from `pendingAnswerBuffer` (only accumulated under interviewer_speaking).
 *  Merging the two fixed that wobble bug. */
export type MomentStateKind =
  | "idle"                  // session just started, nothing classified yet
  | "interviewer_speaking"  // interviewer is mid-question OR small-talk /
                              // intros / audio check / brief acknowledgments —
                              // any "non-substantive interviewer speech" not
                              // yet forming a complete question
  | "question_finalized"    // a complete question is ready; commentary can flow
  | "candidate_questioning" // reverse Q&A: candidate is asking the interviewer
                              // questions ("what does the team look like?",
                              // "what's the day-to-day?"). UI top bar switches
                              // to "Candidate's Question" mode and commentary
                              // evaluates the QUESTION quality, not an answer.
  | "closing";              // both sides have entered goodbye register
                              // ("thanks for your time, we'll be in touch",
                              // "have a good day"). Once detected, the
                              // orchestrator starts a 3s silence timer; if no
                              // new substantive utterance arrives, it dispatches
                              // ic:closing-detected so the UI can prompt the
                              // user to End & Save.

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

/** A single piece of AI commentary attached to a question. Three kinds:
 *  - "answer"    (default) — standard Q-A commentary fired while the
 *                candidate is answering an interviewer question.
 *  - "listening" — listening hint fired during an interviewer
 *                monologue (introducing team / setting up a case)
 *                BEFORE this question locked — buffered while no
 *                question was active, then drained onto the first Lead
 *                that follows.
 *  - "cand-q-cmt" — commentary on the QUALITY of a candidate's
 *                reverse-Q&A question. Only appears under a Question
 *                whose own kind is "candidate". The text body grades
 *                the question (specificity, ties to discussion, etc.);
 *                expandedSuggestion is unused for this kind (the
 *                candidate already asked something — no "Try saying").
 *
 *  All three render under the same question in PastView; the label and
 *  surrounding chrome differ per kind. */
export interface Comment {
  id: string;
  text: string; // may contain <strong>, <em> HTML tags
  /** Seconds from session start when this comment was generated. */
  atSeconds: number;
  /** Fuller version of the brief "Try" suggestion in `text`. Generated
   *  by /api/expand-suggestions after the session ends — Live
   *  Commentary's "Try" block is intentionally short (one line) for
   *  glanceability while answering, but the Past view review wants a
   *  complete, deliverable answer the user can rehearse from. May
   *  contain <strong>/<em> HTML tags. Undefined while the post-session
   *  expansion is in flight or when expansion failed. Unused when
   *  kind is "cand-q-cmt". */
  expandedSuggestion?: string;
  /** See type-level docblock for what each value means. */
  kind?: "answer" | "listening" | "cand-q-cmt";
  /** For listening hints (kind="listening") only: the interviewer's
   *  monologue snapshot the AI was looking at when this hint fired.
   *  Captures the SUBSTANTIVE content that triggered the coaching,
   *  not just whatever happened to be at the tail of the time window
   *  when the hint logged its atSeconds. PastView renders this as
   *  "Interviewer mentioned …" above the hint so the reader can see
   *  WHICH stretch of the interview the coaching reacted to.
   *
   *  Undefined on:
   *    - non-listening kinds (answer / cand-q-cmt — context is implicit
   *      in the question or candidate question text respectively)
   *    - legacy listening hints persisted before the column landed
   *      (May 2026); for those PastView falls back to a time-window
   *      heuristic over `utterances`. */
  contextText?: string;
}

/** A question + its associated commentary. Two kinds, distinguished
 *  by who asked:
 *  - "interviewer" (default, omitted on legacy entries) — the standard
 *    case. Interviewer asks, candidate answers. `answerText` holds the
 *    candidate's response, `comments` are AI feedback on the answer.
 *  - "candidate" — REVERSE Q&A: candidate asks the interviewer a
 *    question (during the "any questions for me?" phase). `answerText`
 *    is unused (the interviewer's verbal answer isn't structured today).
 *    `parentQuestionId` is always undefined for candidate kind.
 *    `comments` are AI feedback on the QUALITY of the question (kind
 *    "cand-q-cmt"). */
export interface Question {
  id: string;
  /** Original text of the question, in the language the asker used. */
  text: string;
  /** Seconds from session start when the question was detected. */
  askedAtSeconds: number;
  /** Newest-first ordering is a UI concern; we store chronological. */
  comments: Comment[];
  /** If this question is a follow-up that drills into a parent main question,
   *  the parent's id. undefined for top-level (main) questions. Follow-ups
   *  archive together with their main when a new_topic question arrives.
   *  Always undefined for kind="candidate". */
  parentQuestionId?: string;
  /** Concatenated candidate speech that landed under this question — i.e.
   *  every candidate utterance whose `atSeconds` is between this question's
   *  `askedAtSeconds` and the next question's `askedAtSeconds` (or end of
   *  session). Computed once at `endLive` and stashed here so the scoring
   *  endpoint can grade against the actual answer rather than only the
   *  in-flight coach commentary. Empty string when no candidate speech
   *  was attributable to this question (e.g. interviewer pivoted before
   *  the candidate answered). Optional for backward compatibility with
   *  sessions saved before this field existed. Unused when kind is
   *  "candidate". */
  answerText?: string;
  /** "interviewer" (default, omitted on legacy entries) | "candidate".
   *  See type-level docblock. */
  kind?: "interviewer" | "candidate";
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
  /** Per-dimension breakdown. The model assigns a per-session WEIGHT
   *  to each dimension (carried on `max`); the five weights always sum
   *  to exactly 100, so `totalMax` on this Session is always 100.
   *  Dimensions that don't apply (e.g. Role Fit on a pure technical
   *  screen) get max=0 and score=null. */
  dimensions: Array<{
    /** Stable identifier: one of
     *  question_addressing | specificity | depth | role_fit | communication */
    key: string;
    /** Human-readable label, e.g. "Question Addressing". */
    label: string;
    /** Per-session weight assigned by the model (sum of `max` across
     *  the five dimensions = 100). 0 = not assessed this session. */
    max: number;
    /** Points awarded, 0 .. max. null = dimension not assessed
     *  (`max === 0`) or insufficient evidence. */
    score: number | null;
    /** One-line justification tied to moments from the transcript (or,
     *  when `score` is null, the reason this dimension wasn't assessed). */
    justification: string;
  }>;
  /** Up to 5 actionable suggestions referencing specific moments. The
   *  FIRST entry is the candidate's single biggest issue, with full
   *  elaboration + concrete adjustment guidance. Entries 2-5 are
   *  secondary issues, more terse. May be empty when verdict is
   *  "insufficient_data".
   *
   *  Backward compat: legacy sessions stored `improvements` as
   *  `string[]`. The render layer in PastView accepts BOTH shapes —
   *  string entries are treated as { title: <string>, fix: "" }. New
   *  sessions always use the structured shape. */
  improvements: SessionImprovement[];
}

/** One actionable improvement item in the score-session output. */
export interface SessionImprovement {
  /** Short headline of the issue, e.g. "Filler word density disrupts
   *  delivery". 8-15 words. Always populated. */
  title: string;
  /** Expanded explanation. ONLY populated for the first/main item —
   *  the rest leave this empty. 2-4 sentences naming concrete
   *  transcript moments. */
  detail?: string;
  /** Concrete adjustment guidance — what to do differently next time.
   *  ONLY populated for the first/main item. 1-3 sentences. */
  fix?: string;
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
  /** Raw audio blob URL (object URL). In-memory only — lost on
   *  refresh. Populated immediately at endLive so the just-saved
   *  past-view plays without waiting for the S3 upload to finish.
   *  After upload completes (`audioS3Key` set), PastView prefers a
   *  fresh presigned GET URL signed via /api/uploads/get so the
   *  recording survives reloads. */
  audioUrl?: string;
  /** Screen-recording blob URL. Same in-memory caveat as audioUrl. */
  videoUrl?: string;
  /** S3 object key for the persistent audio recording. Set by the
   *  client after the post-endLive upload finishes (PATCH
   *  /api/sessions/:id with { audioS3Key }). Replaces the
   *  blob-URL-only path so a refresh/cross-device load can still
   *  play the recording. Undefined while upload is in flight, the
   *  user didn't grant mic, or DB isn't reachable. */
  audioS3Key?: string;
  /** S3 object key for the persistent video recording. Same lifecycle
   *  as audioS3Key — only set when "capture screen video" was on
   *  AND the upload completed. */
  videoS3Key?: string;
  /** S3 object key for the pre-transcoded MOV (h264 + AAC). Set by
   *  the server-side background ffmpeg job that runs after a WebM
   *  upload lands. NULL = transcode pending or failed; the Download
   *  button falls back to on-demand transcode in that case. */
  videoMovS3Key?: string;
  /** Transient client-side flag. True between "user clicked End" and
   *  "the multi-segment ffmpeg-concat finished and the final mp4 is
   *  on S3". PastView shows a "Recording is being prepared…"
   *  placeholder while this is true so the user understands the
   *  short delay (~5-10s for ffmpeg `-c copy` over the segments).
   *  Never persisted server-side — only lives in the client store
   *  for the same-tab UX between End and concat-complete. */
  videoConcatPending?: boolean;
  /** Overall assessment — undefined while scoring is in flight. Once
   *  set, scoring is finalized (success or insufficient_data verdict).
   *  See `scoreError` for the failure case. */
  score?: SessionScore;
  /** Set when scoring failed at the network / server level (i.e. couldn't
   *  even produce an insufficient_data verdict). Distinguishes "scoring
   *  in flight" (both undefined) from "scoring permanently failed"
   *  (scoreError set, score still undefined) — without this the UI
   *  would render a forever-loading spinner. The user can retry via the
   *  Re-score button which clears this and re-fires. */
  scoreError?: string;
  /** AI-generated short summary of the JD (paraphrased role + key
   *  responsibilities). Computed once after the session ends so the
   *  Past view's Context block can show concise context above the
   *  transcript without making the user re-read the raw JD. Undefined
   *  while the post-session summarize call is in flight or has failed. */
  jdSummary?: string;
  /** AI-generated short summary of the candidate's resume — only set
   *  when the original resume field was non-empty. Undefined OR empty
   *  string both mean "skip this row in the Context block". */
  resumeSummary?: string;
  /** Optional RAW interviewer profile paste captured at session start
   *  (typically a copy-paste from LinkedIn, or manually written notes
   *  in the StartModal). Threaded INTO Live Commentary at session
   *  time so the coach can tailor framing to who's asking. Often
   *  hundreds of lines — too long to render verbatim in the Past view,
   *  so it stays raw here and `interviewerProfileSummary` carries the
   *  user-facing short version. Empty / undefined → no profile. */
  interviewerProfile?: string;
  /** AI-generated short summary of `interviewerProfile` — name +
   *  current role + company + 1-2 background points, ~40-60 words.
   *  Computed once after the session ends by /api/summarize-context.
   *  Undefined while in flight, the input was blank, or summarization
   *  failed. The Past view's Context block prefers this over the raw
   *  paste. */
  interviewerProfileSummary?: string;
  /** Map from Deepgram speaker number → role assignment, snapshotted
   *  at endLive. The server keeps it as a JSONB column on `sessions`
   *  (`speaker_roles`) so PastView can resolve historical utterances'
   *  roles even after the live store has been reset. Keys are stored
   *  as STRINGS (JSON object keys) but the in-memory shape uses
   *  number keys when constructed live; consumers should index with
   *  String(dgSpeaker) for safety. Empty object when no roles were
   *  assigned (e.g. session ended before identification). */
  speakerRoles?: Record<string, "interviewer" | "candidate">;
  /** When this session is a Retake (AI-interviewer mock session
   *  generated from a completed original), the id of the original
   *  session it mirrors. Undefined for regular live sessions and for
   *  retakes whose parent was later deleted (DB uses ON DELETE SET
   *  NULL so the retake stays reviewable on its own). */
  parentSessionId?: string;
  /** Distinguishes a regular 'live' coaching session from an AI-run
   *  'retake' mock interview. Undefined on legacy rows — treat
   *  undefined as 'live'. */
  sessionMode?: "live" | "retake";
  /** Title of the parent session, resolved server-side via JOIN on
   *  GET /api/sessions/:id purely for display ("Retake of: …").
   *  Never persisted as a column. */
  parentTitle?: string;
}

/** Transient state during a live recording. */
export interface LiveState {
  /** Lifecycle of the live recording.
   *
   *  - `idle`     — no session, empty state on the live pane.
   *  - `starting` — user clicked Continue in StartModal but has NOT
   *                 yet accepted Chrome's tab-share dialog. JD /
   *                 resume / interviewer profile are stashed so the
   *                 ready-bar can show, title-fetch is in flight,
   *                 but no MediaRecorder is running and no audio is
   *                 being captured. The Topbar Dock cluster (Start
   *                 / Pause / End + timer) is hidden during this
   *                 phase to avoid implying recording is active.
   *  - `recording`— share accepted, orchestrator.start() resolved,
   *                 audio flowing, timer ticking. Dock cluster
   *                 visible.
   *  - `paused`   — user clicked Pause; mic released, MediaRecorder
   *                 stopped, but accumulated chunks held for resume.
   */
  status: "idle" | "starting" | "recording" | "paused";
  elapsedSeconds: number;
  /** Current question being answered (top of the feed). null before first question detected. */
  currentQuestionId: string | null;
}
