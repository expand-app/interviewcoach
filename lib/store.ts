import { create } from "zustand";
import type {
  CommentLanguage,
  Comment,
  Question,
  Session,
  LiveState,
  Utterance,
  MomentState,
  DisplayedComment,
} from "@/types/session";

/** How many recent utterances to keep in the live transcript ribbon. */
const UTTERANCE_DISPLAY_CAP = 30;

interface StoreState {
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

  // === Live session in progress ===
  live: LiveState;
  setLiveStatus: (status: LiveState["status"]) => void;
  setElapsed: (s: number) => void;
  setCurrentQuestionId: (id: string | null) => void;

  liveQuestions: Question[];
  liveJd: string;
  liveResume: string;
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

  startLive: (jd: string, resume: string) => void;
  addQuestion: (q: Question) => void;
  addCommentToQuestion: (questionId: string, c: Comment) => void;
  addUtterance: (u: Utterance) => void;
  /** Merge new identifications into the role map. Existing entries are NOT
   *  overwritten — once a speaker's role is decided, it sticks. */
  mergeSpeakerRoles: (roles: Record<number, "interviewer" | "candidate">) => void;
  setMomentState: (m: MomentState) => void;
  setDisplayedComment: (d: DisplayedComment | null) => void;
  setAnswerInProgress: (v: boolean) => void;
  /** End the live session, snapshot it into past sessions with the given title. */
  endLive: (title: string, audioUrl?: string) => Session;
  /** Wipe live state (after End & Save, or a hard reset). */
  resetLive: () => void;
}

const emptyLive: LiveState = {
  status: "idle",
  elapsedSeconds: 0,
  currentQuestionId: null,
};

const emptyMoment: MomentState = { state: "idle", summary: "" };

export const useStore = create<StoreState>((set, get) => ({
  commentLang: "en",
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

  live: emptyLive,
  setLiveStatus: (status) => set((s) => ({ live: { ...s.live, status } })),
  setElapsed: (elapsedSeconds) =>
    set((s) => ({ live: { ...s.live, elapsedSeconds } })),
  setCurrentQuestionId: (currentQuestionId) =>
    set((s) => ({ live: { ...s.live, currentQuestionId } })),

  liveQuestions: [],
  liveJd: "",
  liveResume: "",
  liveUtterances: [],
  liveSpeakerRoles: {},
  liveMomentState: emptyMoment,
  liveDisplayedComment: null,
  liveAnswerInProgress: false,

  startLive: (jd, resume) =>
    set({
      liveJd: jd,
      liveResume: resume,
      liveQuestions: [],
      liveUtterances: [],
      liveSpeakerRoles: {},
      liveMomentState: emptyMoment,
      liveDisplayedComment: null,
      liveAnswerInProgress: false,
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

  mergeSpeakerRoles: (roles) =>
    set((s) => {
      const next = { ...s.liveSpeakerRoles };
      let changed = false;
      for (const [k, v] of Object.entries(roles)) {
        const n = Number(k);
        if (!Number.isFinite(n)) continue;
        if (next[n]) continue; // never overwrite an existing assignment
        next[n] = v;
        changed = true;
      }
      return changed ? { liveSpeakerRoles: next } : {};
    }),

  setMomentState: (m) => set({ liveMomentState: m }),

  setDisplayedComment: (d) => set({ liveDisplayedComment: d }),

  setAnswerInProgress: (v) => set({ liveAnswerInProgress: v }),

  endLive: (title, audioUrl) => {
    const s = get();
    const session: Session = {
      id: `sess-${Date.now()}`,
      title,
      jd: s.liveJd,
      resume: s.liveResume,
      questions: s.liveQuestions,
      startedAt: new Date(
        Date.now() - s.live.elapsedSeconds * 1000
      ).toISOString(),
      durationSeconds: s.live.elapsedSeconds,
      audioUrl,
    };
    set((state) => ({
      pastSessions: [session, ...state.pastSessions],
      liveQuestions: [],
      liveJd: "",
      liveResume: "",
      liveUtterances: [],
      liveSpeakerRoles: {},
      liveMomentState: emptyMoment,
      liveDisplayedComment: null,
      liveAnswerInProgress: false,
      live: emptyLive,
    }));
    return session;
  },

  resetLive: () =>
    set({
      liveQuestions: [],
      liveJd: "",
      liveResume: "",
      liveUtterances: [],
      liveSpeakerRoles: {},
      liveMomentState: emptyMoment,
      liveDisplayedComment: null,
      liveAnswerInProgress: false,
      live: emptyLive,
    }),
}));
