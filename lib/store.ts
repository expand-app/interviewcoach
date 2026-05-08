import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  CommentLanguage,
  Comment,
  Question,
  Session,
  SessionScore,
  LiveState,
  Utterance,
  MomentState,
  DisplayedComment,
  User,
} from "@/types/session";
import {
  postSession,
  patchSession,
  deletePastSessionRemote,
  fetchPastSessions,
  fetchPastSession,
  uploadRecording,
  type PastSessionListItem,
} from "./client-api";
import { snapshotDebugEvents } from "./debug-buffer";

/** How many recent utterances to keep in the live transcript ribbon.
 *  This cap applies to `liveUtterances` (the rolling window the live
 *  captions UI reads). The full uncapped log lives on
 *  `liveAllUtterances`, snapshotted into the saved Session at endLive
 *  so PastView's Review Panel can show the entire transcript. */
const UTTERANCE_DISPLAY_CAP = 30;

/** Plain-object capture of every store field endLive needs. Returned
 *  by snapshotForEnd() and passed through handleEndConfirm's await
 *  to insulate against the store being reset mid-flight (closing
 *  prompt firing during stop, double-end-click, etc). */
export interface EndSnapshot {
  jd: string;
  resume: string;
  questions: Question[];
  allUtterances: Utterance[];
  speakerRoles: Record<number, "interviewer" | "candidate">;
  elapsedSeconds: number;
  interviewerProfile: string;
  interviewerProfileSummary: string;
}

interface StoreState {
  // === Auth ===
  // Phase 2: signIn writes the local user record. The login UI calls
  // /api/users/upsert separately and passes the resulting userId on
  // the User object — see components/LoginView.tsx. signOut clears
  // local state only; server rows persist (we keyed by email).
  user: User | null;
  signIn: (user: User) => void;
  signOut: () => void;
  /** Merge a server-issued userId onto the existing user record.
   *  Used by the optimistic sign-in flow: LoginView signs in
   *  immediately with no userId so the user lands on /app without
   *  waiting for the upsert round-trip (5-15s when Aurora wakes
   *  from paused). When the upsert returns, this action attaches
   *  the userId, which re-triggers hydratePastSessions on /app. */
  setUserId: (userId: string) => void;

  // === Recording upload state ===
  /** Counter of in-flight post-session uploads (audio.webm + each
   *  video segment + the concat call). Incremented when the upload
   *  IIFE starts inside endLive, decremented when it finishes. The
   *  beforeunload guard reads this so a tab-close attempt while
   *  uploads are running surfaces a "Don't leave" warning — without
   *  this guard, closing the tab right after End would silently
   *  abort the in-flight fetch and the recording bytes (which only
   *  ever lived in browser memory as blob URLs) get permanently
   *  lost. */
  uploadsInFlight: number;
  /** Starts a tracked upload. Increments uploadsInFlight; the
   *  caller's finally clause must call markUploadDone(). */
  markUploadStart: () => void;
  /** Pairs with markUploadStart. */
  markUploadDone: () => void;

  /** Mobile sidebar drawer open/closed. On <sm viewports the sidebar
   *  collapses into an off-canvas drawer that slides in from the
   *  left when this is true. Desktop ignores it (sidebar is always
   *  visible inside the grid). */
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  // === Language for AI commentary (questions stay in original language) ===
  commentLang: CommentLanguage;
  setCommentLang: (lang: CommentLanguage) => void;

  // === Sidebar navigation ===
  /** Null = live session is selected. Otherwise it's the id of a past session. */
  selectedPastId: string | null;
  selectPast: (id: string | null) => void;

  // === Past sessions ===
  // Phase 2: server is source of truth. Entries here are a local
  // cache populated by hydratePastSessions() on app mount and kept
  // in sync by the various setter actions (each PATCHes the server
  // alongside the local update). Refresh re-fetches from /api/sessions.
  pastSessions: Session[];
  /** Light-weight list of saved sessions (id/title/date/score-flag),
   *  populated by hydratePastSessions(). The sidebar reads this when
   *  the full Session detail hasn't been lazy-loaded yet. */
  pastSessionList: PastSessionListItem[];
  addPastSession: (s: Session) => void;
  renamePastSession: (id: string, title: string) => void;
  deletePastSession: (id: string) => void;
  /** GET /api/sessions and replace the lightweight list. Called once
   *  on app mount after sign-in. Idempotent — re-running just refreshes. */
  hydratePastSessions: () => Promise<void>;
  /** GET /api/sessions/:id and merge the full detail (questions +
   *  comments) into pastSessions. Called when the user clicks a
   *  list-only entry in the sidebar that hasn't been loaded yet. */
  loadPastSession: (id: string) => Promise<Session | null>;
  /** Attach a computed overall score to a past session. Clears any
   *  scoreError on the session as a side effect (success replaces a
   *  prior failure). */
  setPastSessionScore: (id: string, score: SessionScore) => void;
  /** Mark a past session's scoring as permanently failed. Mutually
   *  exclusive with `score` — setting one clears the other. The UI
   *  uses this to distinguish "still loading" (both undefined) from
   *  "failed, retry-able" (scoreError set). */
  setPastSessionScoreError: (id: string, error: string) => void;
  /** Per-session re-score in-flight tracking. Stored as a Set so
   *  multiple sessions can refresh concurrently without blocking each
   *  other. PastView reads `refreshingSessionIds.has(session.id)` to
   *  decide whether to show the "Re-scoring…" spinner — meaning the
   *  spinner follows the SESSION, not the component. Switching to a
   *  different session while a refresh is in flight no longer (a)
   *  bleeds the spinner onto the new session, or (b) blocks the user
   *  from re-scoring the new session in parallel. */
  refreshingSessionIds: Set<string>;
  /** Mark a session's re-score as in-flight. Idempotent — adding the
   *  same id twice is a no-op. */
  markRefreshStart: (sessionId: string) => void;
  /** Pairs with markRefreshStart. Removes the id from the set. */
  markRefreshDone: (sessionId: string) => void;
  /** Attach the post-session JD + (optional) resume + (optional)
   *  interviewer summaries — rendered in PastView's Context block
   *  above the transcript. Pass any optional summary as `undefined`
   *  to skip that row. */
  setPastSessionContext: (
    id: string,
    summaries: {
      jdSummary: string;
      resumeSummary?: string;
      interviewerProfileSummary?: string;
    }
  ) => void;
  /** Merge per-comment expanded "Try" suggestions onto a past
   *  session. Existing comments without an entry in the map are
   *  left untouched (partial success is fine). */
  setPastSessionExpandedSuggestions: (
    id: string,
    expansionsByCommentId: Record<string, string>
  ) => void;

  // === Live session in progress ===
  live: LiveState;
  setLiveStatus: (status: LiveState["status"]) => void;
  setElapsed: (s: number) => void;
  setCurrentQuestionId: (id: string | null) => void;

  liveQuestions: Question[];
  liveJd: string;
  liveResume: string;
  /** Full uncapped utterance log for the current session. Parallel
   *  to `liveUtterances` (the 30-entry rolling window for captions
   *  UI). At endLive this gets shipped with the session POST so the
   *  Past view's Review Panel can render the same transcript /
   *  captions stream that played live. */
  liveAllUtterances: Utterance[];
  /** Optional RAW interviewer-profile paste (often a verbatim
   *  LinkedIn copy). Empty string when the StartModal field was left
   *  blank. Kept as a fallback for commentary calls when the AI
   *  summary hasn't returned yet, and snapshotted onto the saved
   *  Session at endLive. */
  liveInterviewerProfile: string;
  /** AI-summarized version of `liveInterviewerProfile` — ~50-80 word
   *  prose blurb produced by /api/summarize-interviewer at session
   *  start. Empty until the call returns. The orchestrator prefers
   *  this over the raw paste in commentary requests, dramatically
   *  cutting per-call tokens (raw can be 3000+ words on a long
   *  LinkedIn profile). Snapshotted onto the saved Session at endLive
   *  so PastView can show it without re-summarizing post-session. */
  liveInterviewerProfileSummary: string;
  setLiveInterviewerProfileSummary: (summary: string) => void;
  /** Auto-derived title for the current live session (role + company from
   *  the JD). Empty string until /api/session-title returns, at which
   *  point the heading swaps in. */
  liveTitle: string;
  setLiveTitle: (title: string) => void;
  /** Rolling window of finalized utterances (newest last). */
  liveUtterances: Utterance[];
  /** Map of Deepgram speaker number → resolved role. Set as Haiku identifies
   *  speakers; once set, sticks for the rest of the session. */
  liveSpeakerRoles: Record<number, "interviewer" | "candidate">;
  /** Current "moment" — drives the top bar's three-state display. */
  liveMomentState: MomentState;
  /** The single commentary currently shown in the live pane, with its
   *  minimum-display window. null between comments. */
  liveDisplayedComment: DisplayedComment | null;
  /** True when the candidate has started speaking under the current
   *  question and no commentary is yet displayed — drives the
   *  "AI is observing…" dots indicator. */
  liveAnswerInProgress: boolean;
  /** Listening-hint text shown while the interviewer is monologuing
   *  (describing the team, setting up a case, elaborating) and no
   *  question has finalized yet. Streams in as the model generates the
   *  hint; clears when the moment state leaves interviewer_speaking. */
  liveListeningHint: string;
  setLiveListeningHint: (hint: string) => void;

  /** Commentary shown when the candidate is asking the interviewer
   *  questions in the reverse-Q&A phase ("any questions for me?").
   *  The model evaluates the QUALITY of the candidate's question
   *  rather than judging an answer. Streams in like listeningHint;
   *  the UI renders this in the commentary pane while
   *  momentState === "candidate_questioning". */
  liveCandidateQuestionCommentary: string;
  setLiveCandidateQuestionCommentary: (text: string) => void;

  /** Currently-locked candidate question text. Set by the orchestrator
   *  when a candidate-question commentary commit happens (Jaccard +
   *  read-gate both pass) and cleared when a Lead Question locks. Acts
   *  like the Lead-Question lock for the reverse-Q&A path: once a
   *  candidate question is "established", the UI keeps showing it even
   *  when the moment state machine briefly transits out of
   *  candidate_questioning (interviewer mid-answer can flip state to
   *  interviewer_speaking / chitchat). Without this lock, the Phase bar
   *  would fall back to "Interview Ongoing" while the interviewer
   *  answers — losing the question context that produced the answer.
   *
   *  Distinct from `liveMomentState.candidateQuestion` which mirrors the
   *  classifier's latest output and flickers across rephrasings of the
   *  same logical question (the classifier re-emits varied wording every
   *  2-3s tick). The locked field only updates when a meaningfully new
   *  question commits, so the UI display stays stable. */
  liveLockedCandidateQuestion: string | null;
  setLiveLockedCandidateQuestion: (text: string | null) => void;

  /** Currently-locked Probe Question text. Set by the orchestrator when
   *  `addFollowUpAndStart` commits a probe (4-layer filter passed) and
   *  cleared when a NEW Lead locks (interviewer pivoted to a different
   *  topic) or when reverse-Q&A starts. Mirrors the Lead-Q lock pattern:
   *  the Phase bar's "Probe Question" sub-row should persist as long as
   *  the probe is the active sub-question, even if the moment-state
   *  machine briefly oscillates (interviewer_speaking ↔ question_finalized
   *  during a long answer flap). Without this lock, the existing
   *  `currentQuestionId`-based display would also work in steady state,
   *  but the lock survives the brief intermediate-frame flicker between
   *  setCurrentQuestionId(null) and addQuestion(newLead) calls. */
  liveLockedProbeQuestion: string | null;
  setLiveLockedProbeQuestion: (text: string | null) => void;

  /** Session-elapsed seconds at which the moment-state machine first
   *  transitioned into `candidate_questioning`. Marks the start of the
   *  reverse Q&A phase for diagnostic logging. Null until the first
   *  entry; never reset within a session even if state later moves
   *  out of candidate_questioning. */
  liveCandidateQuestioningSince: number | null;
  setLiveCandidateQuestioningSince: (sec: number | null) => void;

  /** Pending manual speaker-identification prompt for live mode. When a
   *  new dgSpeaker appears with no role assigned and no other role can
   *  be inferred, we set this so the UI renders a floating "Who is
   *  this: Candidate / Interviewer?" card. User picks, we commit, and
   *  the prompt clears. Null when no prompt is pending. */
  liveSpeakerPrompt: {
    dgSpeaker: number;
    sampleText: string;
  } | null;
  setLiveSpeakerPrompt: (prompt: StoreState["liveSpeakerPrompt"]) => void;
  /** Resolve the current speaker prompt by assigning the given role to
   *  the prompt's dgSpeaker. Clears the prompt as a side effect. */
  resolveSpeakerPrompt: (role: "interviewer" | "candidate") => void;

  startLive: (
    jd: string,
    resume: string,
    interviewerProfile?: string
  ) => void;
  addQuestion: (q: Question) => void;
  addCommentToQuestion: (questionId: string, c: Comment) => void;
  /** Append a chunk of candidate speech to the running `answerText` of
   *  a question. Called from the orchestrator on every candidate
   *  utterance that lands while a Lead/Probe is locked (state ===
   *  question_finalized). CRITICAL: this is the ONLY reliable way to
   *  accumulate per-question answer text — `liveUtterances` is a
   *  rolling 30-entry window for the captions UI and gets evicted long
   *  before endLive runs on a 20+ min session. Persisting onto the
   *  Question itself decouples the answer-text record from the UI
   *  buffer so scoring sees the full transcript. */
  appendCandidateAnswerText: (questionId: string, chunk: string) => void;
  addUtterance: (u: Utterance) => void;
  /** Replace the entire live utterance list. Used by upload mode to
   *  pre-load ALL transcribed utterances up front (no rolling-window
   *  trim) so captions can be time-indexed into any position of the
   *  recording without stale data. */
  /** Merge new identifications into the role map. Existing entries are NOT
   *  overwritten — once a speaker's role is decided, it sticks. */
  mergeSpeakerRoles: (roles: Record<number, "interviewer" | "candidate">) => void;
  /** User-driven override: force a specific dgSpeaker to a specific role,
   *  overwriting any prior assignment. Used by the "Re-tag speakers"
   *  modal so the user can correct a wrong manual tag mid-session
   *  (since the auto-assign + first-speaker-prompt path can't be
   *  retried otherwise). */
  forceSetSpeakerRole: (
    dgSpeaker: number,
    role: "interviewer" | "candidate"
  ) => void;
  setMomentState: (m: MomentState) => void;
  setDisplayedComment: (d: DisplayedComment | null) => void;
  setAnswerInProgress: (v: boolean) => void;
  /** Snapshot every store field that endLive needs into a plain
   *  object the page can hold across an `await`. Without this,
   *  handleEndConfirm's `await orchestrator.stop()` window (now
   *  several seconds because fix-webm-duration runs in there) can
   *  race with: (a) the closing-detection prompt firing and the user
   *  picking Save in IT, (b) auto-save 5min idle, (c) any path that
   *  ends up calling startLive/resetLive — all of which wipe the
   *  store before endLive has captured it, and the saved row ends up
   *  with title="Live Interview Session", duration=0, questions=[]. */
  snapshotForEnd: () => EndSnapshot;
  /** End the live session, snapshot it into past sessions with the given title.
   *  When `snapshot` is provided, uses those fields instead of reading
   *  from `get()` — exists so callers can capture state BEFORE an
   *  await and pass it through, dodging the race described above. */
  endLive: (
    title: string,
    audioUrl?: string,
    videoUrl?: string,
    snapshot?: EndSnapshot,
    /** Multi-segment recording artifacts. Each pause/resume cycle
     *  produced its own MP4 segment; the upload flow PUTs each as a
     *  separate S3 object then calls /api/uploads/concat for an
     *  ffmpeg `-c copy` stitch. Length 1 when the user never paused
     *  (fast path: no concat needed). Both fields undefined when
     *  the session was audio-only. */
    videoMeta?: {
      videoSegmentUrls?: string[];
      videoMime?: string;
    }
  ) => Session;
  /** Wipe live state (after End & Save, or a hard reset). */
  resetLive: () => void;
}

const emptyLive: LiveState = {
  status: "idle",
  elapsedSeconds: 0,
  currentQuestionId: null,
};

const emptyMoment: MomentState = { state: "idle", summary: "" };

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
  user: null,
  signIn: (user) =>
    set((state) => {
      // When signing in as a DIFFERENT account than the one cached in
      // localStorage, drop the cached pastSessionList — otherwise the
      // sidebar would briefly flash the previous user's sessions
      // before hydratePastSessions() lands. Same-email re-sign-in
      // keeps the cache so the list paints instantly.
      const sameUser =
        state.user?.email && state.user.email === user.email;
      return sameUser
        ? { user }
        : { user, pastSessionList: [], pastSessions: [] };
    }),
  signOut: () =>
    // Clear the cached list too. Persisted localStorage drops it
    // automatically via partialize on the next set, but explicit clear
    // keeps the in-memory state consistent for the rest of the tab's
    // lifetime (no flicker of stale entries before navigation).
    set({ user: null, pastSessionList: [], pastSessions: [] }),
  setUserId: (userId) =>
    set((state) => (state.user ? { user: { ...state.user, userId } } : {})),

  uploadsInFlight: 0,
  markUploadStart: () =>
    set((s) => ({ uploadsInFlight: s.uploadsInFlight + 1 })),
  markUploadDone: () =>
    set((s) => ({
      uploadsInFlight: Math.max(0, s.uploadsInFlight - 1),
    })),

  // Mobile sidebar drawer — closed by default. Toggles the off-canvas
  // drawer on <sm viewports; on desktop the sidebar is always visible
  // inside the page grid and this flag is unused.
  sidebarOpen: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),

  refreshingSessionIds: new Set<string>(),
  markRefreshStart: (sessionId) =>
    set((s) => {
      // Always return a new Set instance — Zustand uses reference
      // equality to decide whether subscribers should re-render. If
      // we mutate the existing set in place, components reading
      // `refreshingSessionIds.has(id)` won't get notified.
      const next = new Set(s.refreshingSessionIds);
      next.add(sessionId);
      return { refreshingSessionIds: next };
    }),
  markRefreshDone: (sessionId) =>
    set((s) => {
      if (!s.refreshingSessionIds.has(sessionId)) return {};
      const next = new Set(s.refreshingSessionIds);
      next.delete(sessionId);
      return { refreshingSessionIds: next };
    }),

  // Default to English. Existing users who already picked Chinese
  // are unaffected — Zustand persist takes precedence over this
  // default and rehydrates their saved preference. Only first-time
  // users (no localStorage entry yet) land on English.
  commentLang: "en",
  setCommentLang: (commentLang) => set({ commentLang }),

  selectedPastId: null,
  selectPast: (id) =>
    set((s) => ({
      selectedPastId: id,
      // Defensive: when navigating to a past session, clear any
      // pending speaker-identity prompt from a still-running live
      // session. Otherwise the modal would render on top of the past-
      // session view (the SpeakerIdentityPrompt component is mounted
      // at the app root). We also gate the modal itself on Live view
      // in app/page.tsx, so this is double-cover.
      liveSpeakerPrompt: id !== null ? null : s.liveSpeakerPrompt,
    })),

  pastSessions: [],
  pastSessionList: [],
  addPastSession: (s) =>
    set((state) => ({ pastSessions: [s, ...state.pastSessions] })),
  hydratePastSessions: async () => {
    // Light-weight list refresh. Doesn't merge into pastSessions —
    // the sidebar renders from pastSessionList until the user clicks
    // an entry, at which point loadPastSession fetches the full
    // detail and inserts it into pastSessions.
    const list = await fetchPastSessions();
    set({ pastSessionList: list });
  },
  loadPastSession: async (id) => {
    // Lazy-load the full Session detail. If we've already got it in
    // pastSessions, return that. Otherwise GET /api/sessions/:id and
    // merge. Returns null when the call failed or DB isn't wired
    // (caller falls back to whatever cached state exists).
    const cached = get().pastSessions.find((s) => s.id === id);
    if (cached) return cached;
    const partial = await fetchPastSession(id);
    if (!partial) return null;
    // partial.questions is present when the GET succeeded; coerce to
    // the full Session shape with safe defaults for missing fields.
    const full: Session = {
      id: partial.id ?? id,
      title: partial.title ?? "(untitled)",
      jd: partial.jd ?? "",
      resume: partial.resume ?? "",
      startedAt: partial.startedAt ?? new Date().toISOString(),
      durationSeconds: partial.durationSeconds ?? 0,
      questions: partial.questions ?? [],
      // Blob URLs are tab-scoped — never present on a server-loaded
      // session. PastView signs a fresh GET URL via /api/uploads/get
      // when audioS3Key / videoS3Key are set; that flow is what
      // makes recordings survive a refresh.
      audioUrl: undefined,
      videoUrl: undefined,
      audioS3Key: partial.audioS3Key,
      videoS3Key: partial.videoS3Key,
      videoMovS3Key: partial.videoMovS3Key,
      score: partial.score,
      scoreError: partial.scoreError,
      jdSummary: partial.jdSummary,
      resumeSummary: partial.resumeSummary,
      interviewerProfile: partial.interviewerProfile,
      interviewerProfileSummary: partial.interviewerProfileSummary,
    };
    set((state) => ({ pastSessions: [full, ...state.pastSessions] }));
    return full;
  },
  renamePastSession: (id, title) => {
    set((state) => ({
      pastSessions: state.pastSessions.map((s) =>
        s.id === id ? { ...s, title } : s
      ),
      pastSessionList: state.pastSessionList.map((s) =>
        s.id === id ? { ...s, title } : s
      ),
    }));
    void patchSession(id, { title });
  },
  deletePastSession: (id) => {
    set((state) => ({
      pastSessions: state.pastSessions.filter((s) => s.id !== id),
      pastSessionList: state.pastSessionList.filter((s) => s.id !== id),
      selectedPastId:
        state.selectedPastId === id ? null : state.selectedPastId,
    }));
    void deletePastSessionRemote(id);
  },
  setPastSessionScore: (id, score) => {
    set((state) => ({
      pastSessions: state.pastSessions.map((s) =>
        s.id === id ? { ...s, score, scoreError: undefined } : s
      ),
      pastSessionList: state.pastSessionList.map((s) =>
        s.id === id ? { ...s, hasScore: true, scoreError: undefined } : s
      ),
    }));
    void patchSession(id, { score });
  },
  setPastSessionScoreError: (id, error) => {
    set((state) => ({
      pastSessions: state.pastSessions.map((s) =>
        s.id === id ? { ...s, scoreError: error, score: undefined } : s
      ),
      pastSessionList: state.pastSessionList.map((s) =>
        s.id === id ? { ...s, hasScore: false, scoreError: error } : s
      ),
    }));
    void patchSession(id, { scoreError: error });
  },
  setPastSessionContext: (
    id,
    { jdSummary, resumeSummary, interviewerProfileSummary }
  ) => {
    set((state) => ({
      pastSessions: state.pastSessions.map((s) =>
        s.id === id
          ? { ...s, jdSummary, resumeSummary, interviewerProfileSummary }
          : s
      ),
    }));
    void patchSession(id, {
      jdSummary,
      resumeSummary,
      interviewerProfileSummary,
    });
  },
  setPastSessionExpandedSuggestions: (id, expansionsByCommentId) => {
    set((state) => ({
      pastSessions: state.pastSessions.map((s) => {
        if (s.id !== id) return s;
        // Walk every comment on every question; if its id has an
        // expansion in the map, merge it in. Comments without an
        // entry stay untouched — partial success is fine because
        // the model may have skipped untouchable items.
        return {
          ...s,
          questions: s.questions.map((q) => ({
            ...q,
            comments: q.comments.map((c) =>
              expansionsByCommentId[c.id]
                ? { ...c, expandedSuggestion: expansionsByCommentId[c.id] }
                : c
            ),
          })),
        };
      }),
    }));
    void patchSession(id, { expandedSuggestions: expansionsByCommentId });
  },

  live: emptyLive,
  setLiveStatus: (status) => set((s) => ({ live: { ...s.live, status } })),
  setElapsed: (elapsedSeconds) =>
    set((s) => ({ live: { ...s.live, elapsedSeconds } })),
  setCurrentQuestionId: (currentQuestionId) =>
    set((s) => ({ live: { ...s.live, currentQuestionId } })),

  liveQuestions: [],
  liveJd: "",
  liveResume: "",
  liveAllUtterances: [],
  liveInterviewerProfile: "",
  liveInterviewerProfileSummary: "",
  setLiveInterviewerProfileSummary: (liveInterviewerProfileSummary) =>
    set({ liveInterviewerProfileSummary }),
  liveTitle: "",
  setLiveTitle: (liveTitle) => set({ liveTitle }),
  liveUtterances: [],
  liveSpeakerRoles: {},
  liveMomentState: emptyMoment,
  liveDisplayedComment: null,
  liveAnswerInProgress: false,
  liveListeningHint: "",
  setLiveListeningHint: (liveListeningHint) => set({ liveListeningHint }),
  liveCandidateQuestionCommentary: "",
  setLiveCandidateQuestionCommentary: (liveCandidateQuestionCommentary) =>
    set({ liveCandidateQuestionCommentary }),
  liveLockedCandidateQuestion: null,
  setLiveLockedCandidateQuestion: (liveLockedCandidateQuestion) =>
    set({ liveLockedCandidateQuestion }),
  liveLockedProbeQuestion: null,
  setLiveLockedProbeQuestion: (liveLockedProbeQuestion) =>
    set({ liveLockedProbeQuestion }),
  liveCandidateQuestioningSince: null,
  setLiveCandidateQuestioningSince: (liveCandidateQuestioningSince) =>
    set({ liveCandidateQuestioningSince }),
  liveSpeakerPrompt: null,
  setLiveSpeakerPrompt: (liveSpeakerPrompt) => set({ liveSpeakerPrompt }),
  resolveSpeakerPrompt: (role) =>
    set((s) => {
      if (!s.liveSpeakerPrompt) return {};
      return {
        liveSpeakerRoles: {
          ...s.liveSpeakerRoles,
          [s.liveSpeakerPrompt.dgSpeaker]: role,
        },
        liveSpeakerPrompt: null,
      };
    }),

  startLive: (jd, resume, interviewerProfile) =>
    set({
      liveJd: jd,
      liveResume: resume,
      liveInterviewerProfile: interviewerProfile || "",
      liveInterviewerProfileSummary: "",
      liveTitle: "",
      liveQuestions: [],
      liveUtterances: [],
      liveAllUtterances: [],
      liveSpeakerRoles: {},
      liveMomentState: emptyMoment,
      liveDisplayedComment: null,
      liveAnswerInProgress: false,
      liveListeningHint: "",
      liveCandidateQuestionCommentary: "",
      liveLockedCandidateQuestion: null,
      liveLockedProbeQuestion: null,
      liveCandidateQuestioningSince: null,
      liveSpeakerPrompt: null,
      // Status is "starting" — NOT "recording" — until
      // handleBeginRecording flips it post-share-accepted. The
      // Topbar Dock + the elapsed-timer interval both gate on
      // "recording", so during the StartModal-confirm → ready-bar →
      // share-dialog window the user sees a clean topbar (no
      // Pause/End buttons, no ticking 00:00 timer).
      live: { status: "starting", elapsedSeconds: 0, currentQuestionId: null },
    }),

  addQuestion: (q) =>
    set((s) => ({
      liveQuestions: [...s.liveQuestions, q],
      live: { ...s.live, currentQuestionId: q.id },
    })),

  addCommentToQuestion: (questionId, c) =>
    set((s) => ({
      liveQuestions: s.liveQuestions.map((q) =>
        q.id === questionId ? { ...q, comments: [...q.comments, c] } : q
      ),
    })),

  addUtterance: (u) =>
    set((s) => {
      const next = [...s.liveUtterances, u];
      return {
        // UI window — capped to keep the captions ribbon snappy.
        liveUtterances:
          next.length > UTTERANCE_DISPLAY_CAP
            ? next.slice(next.length - UTTERANCE_DISPLAY_CAP)
            : next,
        // Full log — uncapped, persisted at endLive so PastView can
        // replay the complete transcript even after a 30-min session
        // where 99% of utterances would have been evicted from the UI
        // window.
        liveAllUtterances: [...s.liveAllUtterances, u],
      };
    }),

  appendCandidateAnswerText: (questionId, chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    set((s) => ({
      liveQuestions: s.liveQuestions.map((q) => {
        if (q.id !== questionId) return q;
        const prev = (q.answerText ?? "").trim();
        const joined = prev ? `${prev} ${trimmed}` : trimmed;
        return { ...q, answerText: joined };
      }),
    }));
  },

  mergeSpeakerRoles: (roles) =>
    set((s) => {
      const next = { ...s.liveSpeakerRoles };
      let changed = false;
      for (const [k, v] of Object.entries(roles)) {
        const n = Number(k);
        if (!Number.isFinite(n)) continue;
        if (next[n] === v) continue;
        next[n] = v;
        changed = true;
      }
      return changed ? { liveSpeakerRoles: next } : {};
    }),

  forceSetSpeakerRole: (dgSpeaker, role) =>
    set((s) => {
      if (s.liveSpeakerRoles[dgSpeaker] === role) return {};
      return {
        liveSpeakerRoles: {
          ...s.liveSpeakerRoles,
          [dgSpeaker]: role,
        },
      };
    }),

  setMomentState: (m) => set({ liveMomentState: m }),

  setDisplayedComment: (d) => set({ liveDisplayedComment: d }),

  setAnswerInProgress: (v) => set({ liveAnswerInProgress: v }),

  snapshotForEnd: () => {
    const s = get();
    return {
      jd: s.liveJd,
      resume: s.liveResume,
      questions: s.liveQuestions,
      allUtterances: s.liveAllUtterances,
      speakerRoles: s.liveSpeakerRoles,
      elapsedSeconds: s.live.elapsedSeconds,
      interviewerProfile: s.liveInterviewerProfile,
      interviewerProfileSummary: s.liveInterviewerProfileSummary,
    };
  },

  endLive: (title, audioUrl, videoUrl, snapshot, videoMeta) => {
    const s = get();
    // When the caller passed a pre-captured snapshot, use those fields
    // — that's the path that protects against the store being reset
    // during handleEndConfirm's `await orchestrator.stop()` window.
    // Otherwise fall through to the live-store reads (legacy callers).
    const captured: EndSnapshot = snapshot ?? {
      jd: s.liveJd,
      resume: s.liveResume,
      questions: s.liveQuestions,
      allUtterances: s.liveAllUtterances,
      speakerRoles: s.liveSpeakerRoles,
      elapsedSeconds: s.live.elapsedSeconds,
      interviewerProfile: s.liveInterviewerProfile,
      interviewerProfileSummary: s.liveInterviewerProfileSummary,
    };
    // Debug-event buffer is module-scope (lib/debug-buffer.ts), not
    // in zustand — it's never reset by startLive/resetLive, so we
    // can safely snapshot it here regardless of which path we took.
    const utterancesForServer = captured.allUtterances;
    const eventsForServer = snapshotDebugEvents();
    const speakerRolesForServer = captured.speakerRoles;
    // No more end-of-session bucketing: candidate answer text has been
    // accumulated onto each Question's `answerText` field LIVE (via the
    // orchestrator's `appendCandidateAnswerText` calls during
    // question_finalized + at each lock's pendingAnswerBuffer flush).
    // The previous design bucketed `liveUtterances` here, but
    // `liveUtterances` is a 30-entry rolling window for the captions
    // UI — on a 20+ minute session, all but the final ~30 utterances
    // had been evicted by endLive time, so only the LAST question got
    // any answer text. This caused legitimate 27-min interviews with
    // 3+ substantively-answered questions to score `insufficient_data`.
    // Just snapshot whatever's already on the Question objects.
    const finalQuestions = captured.questions;

    // CRITICAL: set `videoConcatPending: true` SYNCHRONOUSLY on the
    // initial session object — not inside the async upload IIFE
    // below. If we set it later, there's a render window between
    // "session added to pastSessions (with videoUrl set)" and "the
    // IIFE flips videoConcatPending=true" where PastView sees
    // session.videoUrl exists but no concat-pending flag → renders
    // the VideoSection with the first-segment blob URL → user sees
    // a brief preview of just the opening of the recording, then
    // it flips to the "Preparing recording…" placeholder. Setting
    // the flag here closes that race so the placeholder is the
    // FIRST thing PastView renders for this session.
    const willConcat = (videoMeta?.videoSegmentUrls?.length ?? 0) > 0;

    const session: Session = {
      id: `sess-${Date.now()}`,
      title,
      jd: captured.jd,
      resume: captured.resume,
      questions: finalQuestions,
      startedAt: new Date(
        Date.now() - captured.elapsedSeconds * 1000
      ).toISOString(),
      durationSeconds: captured.elapsedSeconds,
      audioUrl,
      videoUrl,
      videoConcatPending: willConcat,
      interviewerProfile: captured.interviewerProfile || undefined,
      // Snapshot the AI summary captured at session start so the
      // PastView Context block can render immediately without waiting
      // for the post-session summarize-context call (which only fills
      // it in if missing). Empty string = summarization didn't return
      // before End — post-session call will catch up.
      interviewerProfileSummary:
        captured.interviewerProfileSummary || undefined,
    };
    set((state) => ({
      pastSessions: [session, ...state.pastSessions],
      pastSessionList: [
        {
          id: session.id,
          title: session.title,
          startedAt: session.startedAt,
          durationSeconds: session.durationSeconds,
          hasScore: false,
          scoreError: undefined,
        },
        ...state.pastSessionList,
      ],
      liveQuestions: [],
      liveJd: "",
      liveResume: "",
      liveAllUtterances: [],
      liveInterviewerProfile: "",
      liveInterviewerProfileSummary: "",
      liveTitle: "",
      liveUtterances: [],
      liveSpeakerRoles: {},
      liveMomentState: emptyMoment,
      liveDisplayedComment: null,
      liveAnswerInProgress: false,
      liveListeningHint: "",
      liveCandidateQuestionCommentary: "",
      liveLockedCandidateQuestion: null,
      liveLockedProbeQuestion: null,
      liveCandidateQuestioningSince: null,
      liveSpeakerPrompt: null,
      live: emptyLive,
    }));
    // Fire-and-forget server save + Phase 3 upload chain. Errors
    // land in the console; the local store is the immediate source
    // of truth, so a failed POST/upload doesn't block the UI from
    // showing the past view.
    //
    // Order matters: postSession must INSERT the session row before
    // uploadRecording's /api/uploads/sign call runs (the sign route
    // ownership-checks against `sessions`). We await the POST inside
    // an async IIFE so the caller's synchronous return contract
    // doesn't change but the upload still waits.
    // Track this upload so the page-level beforeunload guard knows
    // to warn the user about leaving while bytes are still being
    // shipped to S3. Without this counter, a user closing the tab
    // immediately after clicking End loses the entire recording —
    // the blob URLs only live in browser memory and the in-flight
    // fetch PUTs to S3 are aborted by tab unload.
    get().markUploadStart();
    void (async () => {
      try {
      await postSession(
        session,
        speakerRolesForServer,
        utterancesForServer,
        eventsForServer
      );
      if (audioUrl) {
        const key = await uploadRecording({
          sessionId: session.id,
          kind: "audio",
          blobUrl: audioUrl,
        });
        // Merge the resulting key onto the local session so PastView
        // (in this same tab) can sign a GET URL for it after the
        // blob URL goes stale on a future load. Same-tab playback
        // keeps using audioUrl until then — both routes stay valid.
        if (key) {
          set((state) => ({
            pastSessions: state.pastSessions.map((s) =>
              s.id === session.id ? { ...s, audioS3Key: key } : s
            ),
          }));
        }
      }
      // === Video upload ===
      // Multi-segment path: each pause/resume cycle produced a
      // separate blob: URL, sent up by the orchestrator. We upload
      // each as its own S3 object and call /api/uploads/concat to
      // ffmpeg `-c copy` them into one MP4. Single-segment path
      // (length 1) skips concat — the segment IS the final.
      const segmentUrls = videoMeta?.videoSegmentUrls ?? [];
      const videoMime = videoMeta?.videoMime ?? "video/mp4";
      if (segmentUrls.length > 0) {
        // videoConcatPending was already set TRUE on the initial
        // session object above (synchronously, no race). Just
        // clear it after concat resolves below.
        const { uploadRecordingMultiSegment } = await import(
          "@/lib/client-api"
        );
        const key = await uploadRecordingMultiSegment({
          sessionId: session.id,
          segmentUrls,
          mime: videoMime,
        });
        set((state) => ({
          pastSessions: state.pastSessions.map((s) =>
            s.id === session.id
              ? {
                  ...s,
                  videoS3Key: key ?? undefined,
                  videoConcatPending: false,
                }
              : s
          ),
        }));
      } else if (videoUrl) {
        // Legacy fallback for callers that don't pass segments.
        const key = await uploadRecording({
          sessionId: session.id,
          kind: "video",
          blobUrl: videoUrl,
        });
        if (key) {
          set((state) => ({
            pastSessions: state.pastSessions.map((s) =>
              s.id === session.id ? { ...s, videoS3Key: key } : s
            ),
          }));
        }
      }
      } finally {
        // Always release the in-flight counter so beforeunload stops
        // warning, even if an upload throws. Otherwise a thrown
        // error would leave the user perma-warned every refresh.
        get().markUploadDone();
      }
    })();
    return session;
  },

  resetLive: () =>
    set({
      liveQuestions: [],
      liveJd: "",
      liveResume: "",
      liveAllUtterances: [],
      liveInterviewerProfile: "",
      liveInterviewerProfileSummary: "",
      liveTitle: "",
      liveUtterances: [],
      liveSpeakerRoles: {},
      liveMomentState: emptyMoment,
      liveDisplayedComment: null,
      liveAnswerInProgress: false,
      liveListeningHint: "",
      liveCandidateQuestionCommentary: "",
      liveLockedCandidateQuestion: null,
      liveLockedProbeQuestion: null,
      liveCandidateQuestioningSince: null,
      liveSpeakerPrompt: null,
      live: emptyLive,
    }),
    }),
    {
      name: "interview-coach-store",
      storage: createJSONStorage(() => localStorage),
      // Phase 2: user identity is persisted client-side (so a refresh
      // doesn't kick the user back to /sign-in). FULL pastSessions
      // (with questions/comments) are NOT persisted — they're fetched
      // lazily by loadPastSession() and would mask server-side schema
      // changes if cached.
      //
      // The lightweight pastSessionList IS persisted (id, title,
      // startedAt, durationSeconds, hasScore) — purely a UX cache so
      // the sidebar paints prior sessions IMMEDIATELY on reload
      // instead of showing "No past sessions yet" for the 5-15s
      // Aurora cold-start window. hydratePastSessions() runs on /app
      // mount and overwrites this cache with fresh server data; if
      // the user was deleted/renamed sessions in another tab, the
      // sidebar reconciles within seconds. signIn() flushes this
      // cache when switching accounts so we don't leak the previous
      // user's session list.
      partialize: (state) => ({
        user: state.user,
        pastSessionList: state.pastSessionList,
        // Persist commentary language so the user's CN/EN preference
        // survives page reloads + tab restores. Default-zh applies
        // ONLY on first load before the user picks anything; once
        // they've chosen explicitly we want that decision sticky.
        commentLang: state.commentLang,
      }),
    }
  )
);

// Dev-only: expose the store on `window` so we can poke at state from
// the browser console when diagnosing issues (e.g. "where did commentary
// go?"). Usage: `__ic_store.getState().liveQuestions`
if (typeof window !== "undefined") {
  (window as unknown as { __ic_store?: typeof useStore }).__ic_store =
    useStore;
}
