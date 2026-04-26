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
  RecordingTimeline,
  User,
} from "@/types/session";

/** How many recent utterances to keep in the live transcript ribbon. */
const UTTERANCE_DISPLAY_CAP = 30;

interface StoreState {
  // === Auth (local-only; no backend) ===
  user: User | null;
  signIn: (user: User) => void;
  signOut: () => void;

  // === Language for AI commentary (questions stay in original language) ===
  commentLang: CommentLanguage;
  setCommentLang: (lang: CommentLanguage) => void;

  // === Sidebar navigation ===
  /** Null = live session is selected. Otherwise it's the id of a past session. */
  selectedPastId: string | null;
  selectPast: (id: string | null) => void;

  // === Past sessions (in-memory only; lost on refresh) ===
  pastSessions: Session[];
  addPastSession: (s: Session) => void;
  renamePastSession: (id: string, title: string) => void;
  deletePastSession: (id: string) => void;
  /** Attach a computed overall score to a past session. Clears any
   *  scoreError on the session as a side effect (success replaces a
   *  prior failure). */
  setPastSessionScore: (id: string, score: SessionScore) => void;
  /** Mark a past session's scoring as permanently failed. Mutually
   *  exclusive with `score` — setting one clears the other. The UI
   *  uses this to distinguish "still loading" (both undefined) from
   *  "failed, retry-able" (scoreError set). */
  setPastSessionScoreError: (id: string, error: string) => void;

  // === Live session in progress ===
  live: LiveState;
  setLiveStatus: (status: LiveState["status"]) => void;
  setElapsed: (s: number) => void;
  setCurrentQuestionId: (id: string | null) => void;

  liveQuestions: Question[];
  liveJd: string;
  liveResume: string;
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
  /** Pre-computed coaching timeline — populated by /api/preanalyze-recording
   *  for upload-mode sessions. null for live sessions and while the
   *  pre-analysis is still in flight. When set, the live view reads
   *  phase / current question / commentary / listening hint from this
   *  timeline indexed by the playback's current time. */
  liveTimeline: RecordingTimeline | null;
  setLiveTimeline: (t: RecordingTimeline | null) => void;
  /** Current playback time in seconds, for upload mode. Updated by the
   *  LivePlayerStrip as the HTMLAudioElement's currentTime advances.
   *  Reset to 0 on new session. Live mic mode doesn't use this. */
  livePlaybackTime: number;
  setLivePlaybackTime: (t: number) => void;
  /** True when the current session is an uploaded recording being
   *  played back. Used by the UI to decide whether to mount the
   *  scrubber / Review Panel / time-indexed captions etc. */
  liveIsUploadMode: boolean;
  setLiveIsUploadMode: (v: boolean) => void;
  /** Upload-mode processing status. Drives the full-screen loading
   *  overlay so the user isn't staring at a blank Live view while the
   *  recording is being transcribed + pre-analyzed (which can take
   *  30+s on long recordings). Live mic mode stays "idle" throughout. */
  liveProcessingStage:
    | "idle"
    | "transcribing"
    | "identifying"
    | "analyzing"
    | "ready"
    | "failed";
  /** Free-text error message when liveProcessingStage === "failed". */
  liveProcessingError: string;
  setLiveProcessingStage: (
    stage: StoreState["liveProcessingStage"],
    error?: string
  ) => void;

  startLive: (jd: string, resume: string) => void;
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
  replaceLiveUtterances: (utterances: Utterance[]) => void;
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
  /** End the live session, snapshot it into past sessions with the given title. */
  endLive: (
    title: string,
    audioUrl?: string,
    videoUrl?: string
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
  signIn: (user) => set({ user }),
  signOut: () => set({ user: null }),

  commentLang: "zh",
  setCommentLang: (commentLang) => set({ commentLang }),

  selectedPastId: null,
  selectPast: (id) => set({ selectedPastId: id }),

  pastSessions: [],
  addPastSession: (s) =>
    set((state) => ({ pastSessions: [s, ...state.pastSessions] })),
  renamePastSession: (id, title) =>
    set((state) => ({
      pastSessions: state.pastSessions.map((s) =>
        s.id === id ? { ...s, title } : s
      ),
    })),
  deletePastSession: (id) =>
    set((state) => ({
      pastSessions: state.pastSessions.filter((s) => s.id !== id),
      selectedPastId:
        state.selectedPastId === id ? null : state.selectedPastId,
    })),
  setPastSessionScore: (id, score) =>
    set((state) => ({
      pastSessions: state.pastSessions.map((s) =>
        s.id === id ? { ...s, score, scoreError: undefined } : s
      ),
    })),
  setPastSessionScoreError: (id, error) =>
    set((state) => ({
      pastSessions: state.pastSessions.map((s) =>
        s.id === id ? { ...s, scoreError: error, score: undefined } : s
      ),
    })),

  live: emptyLive,
  setLiveStatus: (status) => set((s) => ({ live: { ...s.live, status } })),
  setElapsed: (elapsedSeconds) =>
    set((s) => ({ live: { ...s.live, elapsedSeconds } })),
  setCurrentQuestionId: (currentQuestionId) =>
    set((s) => ({ live: { ...s.live, currentQuestionId } })),

  liveQuestions: [],
  liveJd: "",
  liveResume: "",
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
  liveTimeline: null,
  setLiveTimeline: (liveTimeline) => set({ liveTimeline }),
  livePlaybackTime: 0,
  setLivePlaybackTime: (livePlaybackTime) => set({ livePlaybackTime }),
  liveIsUploadMode: false,
  setLiveIsUploadMode: (liveIsUploadMode) => set({ liveIsUploadMode }),
  liveProcessingStage: "idle",
  liveProcessingError: "",
  setLiveProcessingStage: (stage, error = "") =>
    set({ liveProcessingStage: stage, liveProcessingError: error }),

  startLive: (jd, resume) =>
    set({
      liveJd: jd,
      liveResume: resume,
      liveTitle: "",
      liveQuestions: [],
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
      liveTimeline: null,
      livePlaybackTime: 0,
      liveIsUploadMode: false,
      liveProcessingStage: "idle",
      liveProcessingError: "",
      live: { status: "recording", elapsedSeconds: 0, currentQuestionId: null },
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
        liveUtterances:
          next.length > UTTERANCE_DISPLAY_CAP
            ? next.slice(next.length - UTTERANCE_DISPLAY_CAP)
            : next,
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

  replaceLiveUtterances: (utterances) => set({ liveUtterances: utterances }),

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

  endLive: (title, audioUrl, videoUrl) => {
    const s = get();
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
    const finalQuestions = s.liveQuestions;

    const session: Session = {
      id: `sess-${Date.now()}`,
      title,
      jd: s.liveJd,
      resume: s.liveResume,
      questions: finalQuestions,
      startedAt: new Date(
        Date.now() - s.live.elapsedSeconds * 1000
      ).toISOString(),
      durationSeconds: s.live.elapsedSeconds,
      audioUrl,
      videoUrl,
    };
    set((state) => ({
      pastSessions: [session, ...state.pastSessions],
      liveQuestions: [],
      liveJd: "",
      liveResume: "",
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
      liveTimeline: null,
      livePlaybackTime: 0,
      liveIsUploadMode: false,
      liveProcessingStage: "idle",
      liveProcessingError: "",
      live: emptyLive,
    }));
    return session;
  },

  resetLive: () =>
    set({
      liveQuestions: [],
      liveJd: "",
      liveResume: "",
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
      liveTimeline: null,
      livePlaybackTime: 0,
      liveIsUploadMode: false,
      liveProcessingStage: "idle",
      liveProcessingError: "",
      live: emptyLive,
    }),
    }),
    {
      name: "interview-coach-store",
      storage: createJSONStorage(() => localStorage),
      // Persist the user identity and historical-sessions surface. Live-
      // session state, the displayed commentary pointer, and the audio URL
      // (object URL — invalid across reloads) stay in-memory only.
      partialize: (state) => ({
        user: state.user,
        pastSessions: state.pastSessions.map((s) => ({
          ...s,
          audioUrl: undefined,
        })),
      }),
    }
  )
);

// Dev-only: expose the store on `window` so we can poke at state from
// the browser console when diagnosing issues (e.g. "where did commentary
// go?"). Usage: `__ic_store.getState().liveTimeline`
if (typeof window !== "undefined") {
  (window as unknown as { __ic_store?: typeof useStore }).__ic_store =
    useStore;
}
