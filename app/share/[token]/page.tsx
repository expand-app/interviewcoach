"use client";

/**
 * /share/[token] — public read-only viewer for a shared session.
 *
 * No auth, no sidebar, no topbar. Anyone with the token can read.
 * Pulls data via the public /api/share/[token] endpoint and renders
 * a stripped-down Past Session experience: title + score card +
 * recording player + Q&A timeline. Reuses ScoreCard and VideoSection
 * exported from PastView so the look matches the owner's review
 * surface exactly.
 *
 * Failure states:
 *   - 404 → "this share doesn't exist" friendly card
 *   - 410 → "this share has been revoked" friendly card
 *   - network error → "couldn't load — try refreshing" card
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ScoreCard,
  VideoSection,
  InterviewTranscript,
} from "@/components/PastView";
import { BrandLockup } from "@/components/ui";
import type { Question, SessionScore, Utterance } from "@/types/session";

interface SharePayload {
  session: {
    id: string;
    title: string;
    jd: string;
    resume: string;
    startedAt: string;
    createdAt: string;
    durationSeconds: number;
    audioS3Key: string | null;
    videoS3Key: string | null;
    videoMovS3Key: string | null;
    score: SessionScore | null;
    scoreError: string | null;
    speakerRoles: unknown;
    owner: { email: string; name: string };
  };
  recordings: { audioUrl: string | null; videoUrl: string | null };
  questions: Array<{
    id: string;
    parentQuestionId: string | null;
    text: string;
    askedAtSeconds: number;
    answerText: string;
    position: number;
    // "interviewer" (default) | "candidate". Candidate-kind entries
    // are reverse-Q&A questions from the candidate; their comments
    // (kind="cand-q-cmt") are AI feedback on the question itself
    // rather than on an answer.
    kind?: "interviewer" | "candidate";
  }>;
  comments: Array<{
    id: string;
    questionId: string;
    text: string;
    expandedSuggestion: string | null;
    atSeconds: number;
    kind: string;
    contextText: string | null;
  }>;
  utterances: Array<{
    id: string;
    dgSpeaker: number | null;
    text: string;
    atSeconds: number;
    duration: number | null;
    position: number;
  }>;
}

export default function SharedSessionPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [errState, setErrState] = useState<
    | null
    | { kind: "not-found" }
    | { kind: "revoked"; message: string }
    | { kind: "network"; message: string }
  >(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/share/${encodeURIComponent(token)}`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (r.status === 404) {
          setErrState({ kind: "not-found" });
          return;
        }
        if (r.status === 410) {
          const data = (await r.json().catch(() => ({}))) as {
            error?: string;
          };
          setErrState({
            kind: "revoked",
            message: data.error || "This share has been revoked.",
          });
          return;
        }
        if (!r.ok) {
          setErrState({
            kind: "network",
            message: "Couldn't load this session. Try refreshing.",
          });
          return;
        }
        const data = (await r.json()) as SharePayload;
        if (!cancelled) setPayload(data);
      } catch {
        if (!cancelled)
          setErrState({
            kind: "network",
            message: "Network error loading this session.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const s = payload?.session;
  const rec = payload?.recordings;

  // Build a Question[] shape compatible with VideoSection.questions
  // (which expects nested comments). Map each question's comments
  // from the flat top-level comments array. Required so the phase
  // rail and any comment-counting logic inside VideoSection has the
  // expected shape — public payload keeps comments flat by design.
  const enrichedQuestions: Question[] = (payload?.questions || []).map(
    (q) => ({
      id: q.id,
      text: q.text,
      askedAtSeconds: q.askedAtSeconds,
      answerText: q.answerText,
      parentQuestionId: q.parentQuestionId ?? undefined,
      kind: q.kind === "candidate" ? "candidate" : "interviewer",
      comments: (payload?.comments || [])
        .filter((c) => c.questionId === q.id)
        .map((c) => ({
          id: c.id,
          text: c.text,
          expandedSuggestion: c.expandedSuggestion ?? undefined,
          atSeconds: c.atSeconds,
          kind:
            c.kind === "answer" ||
            c.kind === "listening" ||
            c.kind === "cand-q-cmt"
              ? c.kind
              : "answer",
          contextText: c.contextText ?? undefined,
        })),
    })
  );

  // Map the share payload's utterances to the typed Utterance[] shape
  // InterviewTranscript expects. Just a field-rename — `dgSpeaker`
  // and `duration` come back as nullable from the API but the shape
  // requires undefined-or-number, so coerce nulls.
  const enrichedUtterances: Utterance[] = (payload?.utterances || []).map(
    (u) => ({
      id: u.id,
      dgSpeaker: u.dgSpeaker ?? undefined,
      text: u.text,
      atSeconds: u.atSeconds,
      duration: u.duration ?? undefined,
    })
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--color-surface)",
      }}
    >
      {/* Minimal header — brand lockup left, no nav, no sign-in CTA.
          Looks intentionally light so the page reads as a guest /
          embedded view rather than a full app surface. Mobile-aware
          padding (px-4 → px-6 at sm) so 360px-wide phones don't have
          the lockup hugging the edge. The "Shared interview session"
          label hides on very narrow screens (xs); on tablet+ it
          returns. */}
      <header
        className="border-b border-border"
        style={{
          height: 60,
          background: "var(--color-bg)",
        }}
      >
        <div className="container mx-auto h-full flex items-center justify-between gap-3 px-4 sm:px-6 max-w-[1120px]">
          <Link href="/" aria-label="Puebulo">
            <BrandLockup size={26} />
          </Link>
          <div
            className="hidden sm:block text-text-subtle"
            style={{ fontSize: "0.8125rem" }}
          >
            Shared interview session
          </div>
        </div>
      </header>

      <main className="px-4 sm:px-6 pt-8 sm:pt-12 pb-12 sm:pb-16">
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          {errState ? (
            <ErrorCard state={errState} />
          ) : !payload || !s ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : (
            <>
              {/* Title + meta. Mobile shrinks the headline (1.75rem
                  on desktop overflows on a 360px phone for long
                  titles); leading-tight keeps multi-line titles
                  compact. */}
              <div className="flex items-baseline gap-3 mb-4 sm:mb-6">
                <h1
                  className="text-[1.375rem] sm:text-[1.75rem]"
                  style={{
                    fontWeight: 600,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.2,
                    wordBreak: "break-word",
                  }}
                >
                  {s.title || "Interview session"}
                </h1>
              </div>
              <div
                className="text-text-subtle mb-6 sm:mb-8"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.8125rem",
                }}
              >
                {fmtDateTime(s.startedAt)} · {fmtDuration(s.durationSeconds)}
              </div>

              {/* Score */}
              {(s.score || s.scoreError) && (
                <div className="mb-8">
                  <ScoreCard
                    score={s.score || undefined}
                    scoreError={s.scoreError || undefined}
                  />
                </div>
              )}

              {/* Recording — video player with phase rail (audio
                  fallback below). The shareToken prop wires the
                  Download button to the public token-authenticated
                  /api/share/:token/download endpoint instead of the
                  authenticated /api/uploads/get path, so anonymous
                  visitors can save the recording without signing in. */}
              {rec?.videoUrl && token && (
                <div className="mb-8">
                  <SectionTitle>Recording</SectionTitle>
                  <VideoSection
                    videoUrl={rec.videoUrl}
                    sessionId={s.id}
                    sessionTitle={s.title}
                    questions={enrichedQuestions}
                    durationSec={s.durationSeconds}
                    currentTime={currentTime}
                    videoRef={videoRef}
                    onTimeUpdate={setCurrentTime}
                    shareToken={token}
                  />
                </div>
              )}
              {rec?.audioUrl && !rec?.videoUrl && (
                <div className="mb-8">
                  <SectionTitle>Audio</SectionTitle>
                  <audio
                    controls
                    src={rec.audioUrl}
                    style={{ width: "100%" }}
                  />
                </div>
              )}

              {/* Interview Transcript — same rich per-question layout
                  the owner sees in their Past Session view (Lead /
                  Probe chip, candidate-answer snippet, listening
                  hints, Full Answer callout). The shared
                  InterviewTranscript component handles all rendering
                  including click-to-seek on each row via the
                  videoRef passed from above. The simpler flat Q&A
                  list previously rendered here didn't match the
                  signed-in review experience and skipped the rich
                  Full Answer / Listening Hint blocks; using the
                  same component keeps both surfaces in lockstep. */}
              {enrichedQuestions.length > 0 && (
                <div className="mb-6 sm:mb-8">
                  <h2
                    style={{
                      fontSize: "1.5rem",
                      fontWeight: 600,
                      letterSpacing: "-0.01em",
                      marginBottom: 12,
                    }}
                  >
                    Interview Transcript
                  </h2>
                  <InterviewTranscript
                    questions={enrichedQuestions}
                    utterances={enrichedUtterances}
                    speakerRoles={s.speakerRoles}
                    videoRef={videoRef}
                    currentTime={currentTime}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <footer
        style={{
          padding: "var(--space-8) 0 var(--space-12)",
          textAlign: "center",
        }}
      >
        <Link
          href="/"
          className="text-text-subtle hover:text-text"
          style={{ fontSize: "0.75rem" }}
        >
          Powered by Puebulo
        </Link>
      </footer>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: "1.0625rem",
        fontWeight: 600,
        letterSpacing: "-0.01em",
        marginBottom: 12,
      }}
    >
      {children}
    </h2>
  );
}

function ErrorCard({
  state,
}: {
  state:
    | { kind: "not-found" }
    | { kind: "revoked"; message: string }
    | { kind: "network"; message: string };
}) {
  const heading =
    state.kind === "not-found"
      ? "This share doesn't exist"
      : state.kind === "revoked"
      ? "This share has been revoked"
      : "Couldn't load this session";
  const body =
    state.kind === "not-found"
      ? "The link may have been mistyped, or the share was deleted by its owner."
      : state.kind === "revoked"
      ? state.message
      : state.message;
  return (
    <div
      className="bg-bg border border-border px-4 sm:px-6 py-6 sm:py-8"
      style={{
        borderRadius: "var(--radius-lg)",
        textAlign: "center",
      }}
    >
      <h1
        className="text-[1.125rem] sm:text-[1.25rem]"
        style={{
          fontWeight: 600,
          letterSpacing: "-0.02em",
          marginBottom: 8,
        }}
      >
        {heading}
      </h1>
      <p
        className="text-text-muted text-sm sm:text-[0.9375rem]"
        style={{ lineHeight: 1.55 }}
      >
        {body}
      </p>
    </div>
  );
}

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
function fmtDuration(sec: number): string {
  if (!sec) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  if (mins < 60) return `${mins}m ${remSec}s`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hrs}h ${remMin}m`;
}
function fmtTimeOffset(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
