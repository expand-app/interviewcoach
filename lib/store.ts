import { create } from "zustand";
import type {
  CommentLanguage,
  Comment,
  Question,
  Session,
  LiveState,
} from "@/types/session";

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

  startLive: (jd: string, resume: string) => void;
  addQuestion: (q: Question) => void;
  addCommentToQuestion: (questionId: string, c: Comment) => void;
  /** End the live session, snapshot it into past sessions with the given title. */
  endLive: (title: string, audioUrl?: string) => Session | null;
  /** Wipe live state (after End & Save, or a hard reset). */
  resetLive: () => void;
}

const emptyLive: LiveState = {
  status: "idle",
  elapsedSeconds: 0,
  currentQuestionId: null,
};

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

  startLive: (jd, resume) =>
    set({
      liveJd: jd,
      liveResume: resume,
      liveQuestions: [],
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

  endLive: (title, audioUrl) => {
    const s = get();
    if (s.liveQuestions.length === 0) return null;
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
      live: emptyLive,
    }));
    return session;
  },

  resetLive: () =>
    set({
      liveQuestions: [],
      liveJd: "",
      liveResume: "",
      live: emptyLive,
    }),
}));
