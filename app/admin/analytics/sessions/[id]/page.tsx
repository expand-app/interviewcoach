"use client";

/**
 * /admin/analytics/sessions/[id] — full debug detail for one session.
 *
 * Sections:
 *   1. Session metadata header — title, user, started/duration/score
 *   2. Recordings — inline audio + video players, signed S3 URLs
 *   3. Score block — bullet score JSON if present, error if failed
 *   4. Questions + comments timeline — what was asked, what AI said
 *   5. Utterances — full transcript with speaker labels
 *   6. Events — debug-log events (truncated to 500 most recent for
 *      perf; full count shown in the heading)
 *   7. Raw JSON dump — collapsible <details> block for the full
 *      payload, useful for copy-pasting into a bug report
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { BrandLockup } from "@/components/ui";
import {
  VideoSection,
  ScoreCard,
  InterviewTranscript,
} from "@/components/PastView";
import {
  createSessionShare,
  getSessionShare,
  type SessionShare,
} from "@/lib/client-api";
import type {
  Question,
  Utterance,
  SessionScore,
} from "@/types/session";

interface DetailPayload {
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
    jdSummary: string | null;
    resumeSummary: string | null;
    interviewerProfile: string | null;
    interviewerProfileSummary: string | null;
    speakerRoles: unknown;
    score: unknown;
    scoreError: string | null;
    user: { id: string; email: string; name: string };
  };
  recordings: { audioUrl: string | null; videoUrl: string | null };
  questions: Array<{
    id: string;
    parentQuestionId: string | null;
    text: string;
    askedAtSeconds: number;
    answerText: string;
    position: number;
  }>;
  comments: Array<{
    id: string;
    questionId: string;
    text: string;
    expandedSuggestion: string | null;
    atSeconds: number;
    kind: string;
  }>;
  utterances: Array<{
    id: string;
    dgSpeaker: number | null;
    text: string;
    atSeconds: number;
    duration: number | null;
    position: number;
  }>;
  events: Array<{
    id: string;
    atMs: number;
    source: string;
    event: string;
    data: unknown;
  }>;
}

export default function AdminSessionDebugPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sessionId = params?.id;
  const user = useStore((s) => s.user);
  const userId = user?.userId;

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (useStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (!user) router.replace("/sign-in");
  }, [hydrated, user, router]);

  const [payload, setPayload] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Video player ref + currentTime — wired through to VideoSection so
  // the phase-rail click-to-seek and "currently-playing" highlight
  // work the same way they do in PastView.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);

  // Share-link state. Existing share is fetched on mount alongside
  // the main session payload so the "Share" button knows whether to
  // mint a new token or reveal the live one. Panel is open/close
  // toggled separately so admin can dismiss without losing the URLs.
  const [share, setShare] = useState<SessionShare | null>(null);
  // shareBusy stays for the "Copy Link" mint-in-flight tracking
  // (suppressing rapid double-click duplicate work). The old shareOpen
  // / shareError state was tied to the inline SharePanel reveal that
  // got replaced by the toast-based Copy Link flow — removed.
  const [shareBusy, setShareBusy] = useState(false);
  // Kebab menu (Copy Link / Export PDF) and the "Link Copied" toast.
  // Mirrors the same affordance on PastView — admin gets the same
  // single-click copy-and-go behavior end users have.
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const [linkCopied, setLinkCopied] = useState<
    | null
    | { kind: "ok" }
    | { kind: "err"; message: string }
  >(null);
  const copyToastTimerRef = useRef<number | null>(null);

  // Outside-click closes the kebab menu.
  useEffect(() => {
    if (!actionsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!actionsRef.current?.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [actionsOpen]);

  // Cleanup the toast timer on unmount.
  useEffect(() => {
    return () => {
      if (copyToastTimerRef.current !== null) {
        window.clearTimeout(copyToastTimerRef.current);
        copyToastTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !userId || !sessionId) return;
    void load(userId, sessionId);
    // Fire-and-forget: poll for an existing share. The button below
    // works either way (mint-or-reveal); pre-fetching just lets the
    // label be accurate ("Share" vs "Manage share") on first paint.
    void (async () => {
      const existing = await getSessionShare(sessionId);
      setShare(existing);
    })();
  }, [hydrated, userId, sessionId]);

  async function load(uid: string, sid: string) {
    setError(null);
    try {
      const r = await fetch(`/api/admin/analytics/sessions/${sid}`, {
        headers: { "x-user-id": uid },
        cache: "no-store",
      });
      if (r.status === 403) {
        setError("Forbidden — admin only.");
        return;
      }
      if (r.status === 404) {
        setError("Session not found.");
        return;
      }
      if (!r.ok) {
        setError("Couldn't load session detail.");
        return;
      }
      const data = (await r.json()) as DetailPayload;
      setPayload(data);
    } catch {
      setError("Network error loading session.");
    }
  }

  /** Copy a session-share URL to the clipboard with a "Link Copied"
   *  toast at the top of the page. Mirrors the PastView Copy Link
   *  flow exactly — admin can mint + copy in one click. Idempotent
   *  server-side: clicking twice returns the same token. */
  async function handleCopyLink() {
    if (!sessionId) return;
    setActionsOpen(false);
    let live = share;
    if (!live) {
      setShareBusy(true);
      const result = await createSessionShare(sessionId);
      setShareBusy(false);
      if ("error" in result) {
        flashCopyToast({ kind: "err", message: result.error });
        return;
      }
      live = result;
      setShare(result);
    }
    try {
      await navigator.clipboard.writeText(live.viewerUrl);
      flashCopyToast({ kind: "ok" });
    } catch {
      flashCopyToast({
        kind: "err",
        message: "Clipboard blocked — try again or copy manually.",
      });
    }
  }

  /** Export-PDF handler — same window.print() trick PastView uses.
   *  Sets document.title temporarily so Chrome's "Save as PDF"
   *  dialog defaults to "{Session Title} — YYYY-MM-DD.pdf" instead
   *  of the bare browser title. Restores on afterprint. */
  function handleExportPdf() {
    setActionsOpen(false);
    if (!s) return;
    const original = document.title;
    const safe = (s.title || "Interview Session")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    const stamp = new Date(s.startedAt).toISOString().slice(0, 10);
    document.title = `${safe || "Interview Session"} — ${stamp}`;
    const restore = () => {
      document.title = original;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  function flashCopyToast(
    state: { kind: "ok" } | { kind: "err"; message: string }
  ) {
    if (copyToastTimerRef.current !== null) {
      window.clearTimeout(copyToastTimerRef.current);
      copyToastTimerRef.current = null;
    }
    setLinkCopied(state);
    copyToastTimerRef.current = window.setTimeout(() => {
      setLinkCopied(null);
      copyToastTimerRef.current = null;
    }, 2200);
  }

  if (!hydrated) return null;
  if (!user) return null;

  const s = payload?.session;
  const rec = payload?.recordings;

  return (
    <>
      {/* "Link Copied" toast — fixed at top, fade-in via .toast-flash
          animation, auto-clears after ~2s. Same pattern as PastView. */}
      {linkCopied && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] print:hidden toast-flash"
          role="status"
          aria-live="polite"
        >
          <div
            className="px-4 py-2 rounded-md text-sm border flex items-center gap-2"
            style={{
              background:
                linkCopied.kind === "ok"
                  ? "var(--color-bg)"
                  : "rgba(178, 58, 58, 0.06)",
              borderColor:
                linkCopied.kind === "ok"
                  ? "var(--color-border-strong)"
                  : "rgba(178, 58, 58, 0.3)",
              color:
                linkCopied.kind === "ok"
                  ? "var(--color-text)"
                  : "var(--color-error)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            {linkCopied.kind === "ok" ? (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3 8.5 6.5 12 13 4.5" />
                </svg>
                <span>Link Copied</span>
              </>
            ) : (
              <span>{linkCopied.message}</span>
            )}
          </div>
        </div>
      )}
      <header
        className="sticky top-0 z-50 border-b border-border print:hidden"
        style={{
          height: "60px",
          background: "rgba(255, 255, 255, 0.8)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div className="container mx-auto h-full flex items-center justify-between gap-6 px-6 max-w-[1280px]">
          <Link href="/app" aria-label="Back to app">
            <BrandLockup size={26} />
          </Link>
          <Link
            href="/admin/analytics"
            className="text-sm text-text-muted hover:text-text"
          >
            ← Admin Portal
          </Link>
        </div>
      </header>
      <div
        style={{
          minHeight: "calc(100vh - 60px)",
          padding: "var(--space-12) var(--space-6) var(--space-16)",
          background: "var(--color-surface)",
        }}
      >
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          {error && (
            <div
              className="mb-6 text-xs rounded-md px-3 py-2"
              style={{
                color: "var(--color-error)",
                background: "rgba(178, 58, 58, 0.06)",
                border: "1px solid rgba(178, 58, 58, 0.2)",
              }}
            >
              {error}
            </div>
          )}

          {!payload ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : (
            <>
              {/* === Header card ===
                  print:hidden so Export PDF doesn't include the
                  admin chrome (eyebrow + meta grid + kebab). The
                  printed document then mirrors what the session
                  owner sees on PDF export — title + ScoreCard +
                  recording + transcript only. The h1 inside this
                  card is duplicated as a print-only h1 below so
                  the title still shows up on the first page. */}
              <div
                className="bg-bg border border-border print:hidden"
                style={{
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-6)",
                  marginBottom: "var(--space-6)",
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div
                      className="text-text-subtle"
                      style={{
                        fontSize: "0.6875rem",
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        marginBottom: 6,
                      }}
                    >
                      Session debug
                    </div>
                    <h1
                      style={{
                        fontSize: "1.5rem",
                        fontWeight: 600,
                        letterSpacing: "-0.02em",
                        lineHeight: 1.2,
                        marginBottom: 10,
                      }}
                    >
                      {s?.title || "(untitled)"}
                    </h1>
                  </div>
                  {/* Kebab menu — top-right of the header card.
                      Click reveals a dropdown with "Copy Link"
                      (mints + copies share URL with a top-of-page
                      toast) and "Export PDF" (window.print() with a
                      session-titled filename). The old inline
                      SharePanel + Revoke affordance was removed —
                      admin's "view this session" surface is now
                      strictly read-only (no Re-score either). */}
                  <div className="relative shrink-0 print:hidden" ref={actionsRef}>
                    <button
                      type="button"
                      onClick={() => setActionsOpen((v) => !v)}
                      className={`w-8 h-8 grid place-items-center rounded-md transition-colors ${
                        actionsOpen
                          ? "bg-surface text-text"
                          : "text-text-muted hover:bg-surface hover:text-text"
                      }`}
                      aria-label="Session actions"
                      aria-expanded={actionsOpen}
                      title="Copy link, export PDF…"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        aria-hidden="true"
                      >
                        <circle cx="3.5" cy="8" r="1.4" />
                        <circle cx="8" cy="8" r="1.4" />
                        <circle cx="12.5" cy="8" r="1.4" />
                      </svg>
                    </button>
                    {actionsOpen && (
                      <div
                        className="absolute right-0 mt-1 bg-bg border border-border-strong rounded-md p-1 z-[60]"
                        style={{
                          minWidth: 180,
                          boxShadow: "var(--shadow-lg)",
                        }}
                      >
                        <button
                          type="button"
                          onClick={handleCopyLink}
                          disabled={shareBusy}
                          className="w-full text-left text-sm px-2.5 py-1.5 rounded hover:bg-surface disabled:opacity-60"
                        >
                          {shareBusy ? "Copying…" : "Copy Link"}
                        </button>
                        <button
                          type="button"
                          onClick={handleExportPdf}
                          className="w-full text-left text-sm px-2.5 py-1.5 rounded hover:bg-surface"
                        >
                          Export PDF
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 16,
                    marginTop: 10,
                  }}
                >
                  <Meta label="User">
                    <div>{s?.user.name}</div>
                    <div
                      className="text-text-muted"
                      style={{ fontSize: "0.8125rem" }}
                    >
                      {s?.user.email}
                    </div>
                  </Meta>
                  <Meta label="Started">{fmtDateTime(s?.startedAt)}</Meta>
                  <Meta label="Duration">
                    {formatDuration(s?.durationSeconds || 0)}
                  </Meta>
                  <Meta label="Session id">
                    <code
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "0.75rem",
                      }}
                    >
                      {s?.id}
                    </code>
                  </Meta>
                </div>
              </div>

              {/* === Session Details ===
                  Read-only mirror of what the session OWNER sees in
                  Past Session: ScoreCard + VideoSection (with
                  admin-bypass download) + Interview Transcript.
                  No Re-score affordance (admin should never modify
                  the user's grade). The bespoke admin-only sections
                  (Recordings / Score / Questions & commentary) that
                  used to live here were removed — this view is now
                  the single source of truth, identical to the user's
                  own review. Engineer-debug surfaces (Utterances,
                  Events, Raw JSON) follow below for triage. */}
              <div className="print:hidden">
                <SectionHeading title="Session Details" />
              </div>
              {/* Print-only header. Browsers normally hide this block
                  on screen — only the Export PDF flow surfaces it.
                  Mirrors PastView's PDF: bare title + date stamp at
                  the top, then ScoreCard / VideoSection / Transcript
                  follow with the same chrome users see when they
                  print their own session. */}
              <div className="hidden print:block" style={{ marginBottom: 16 }}>
                <h1
                  style={{
                    fontSize: "1.75rem",
                    fontWeight: 600,
                    letterSpacing: "-0.02em",
                    lineHeight: 1.2,
                    marginBottom: 6,
                  }}
                >
                  {s?.title || "Interview session"}
                </h1>
                {s?.startedAt && (
                  <div
                    className="text-text-subtle"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.8125rem",
                    }}
                  >
                    {fmtDateTime(s.startedAt)}
                  </div>
                )}
              </div>
              {(() => {
                const enriched = enrichedQuestions(payload);
                const enrichedU: Utterance[] = (payload?.utterances || []).map(
                  (u) => ({
                    id: u.id,
                    dgSpeaker: u.dgSpeaker ?? undefined,
                    text: u.text,
                    atSeconds: u.atSeconds,
                    duration: u.duration ?? undefined,
                  })
                );
                return (
                  <div className="mb-8">
                    {(s?.score || s?.scoreError) && (
                      <ScoreCard
                        score={(s?.score as SessionScore | null) || undefined}
                        scoreError={s?.scoreError || undefined}
                      />
                    )}
                    {rec?.videoUrl && (
                      <VideoSection
                        videoUrl={rec.videoUrl}
                        sessionId={s?.id || ""}
                        sessionTitle={s?.title || ""}
                        questions={enriched}
                        durationSec={s?.durationSeconds || 0}
                        currentTime={currentTime}
                        videoRef={videoRef}
                        onTimeUpdate={setCurrentTime}
                        downloadOverrideUserId={s?.user.id}
                      />
                    )}
                    {!rec?.videoUrl && rec?.audioUrl && (
                      <div className="mb-8 print:hidden">
                        <audio
                          controls
                          src={rec.audioUrl}
                          style={{ width: "100%" }}
                        />
                      </div>
                    )}
                    {enriched.length > 0 && (
                      <>
                        <h3
                          style={{
                            fontSize: "1.5rem",
                            fontWeight: 600,
                            letterSpacing: "-0.01em",
                            marginTop: "var(--space-12)",
                            marginBottom: 12,
                          }}
                        >
                          Interview Transcript
                        </h3>
                        <InterviewTranscript
                          questions={enriched}
                          utterances={enrichedU}
                          speakerRoles={s?.speakerRoles}
                          videoRef={videoRef}
                          currentTime={currentTime}
                        />
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Engineer-debug surfaces (Utterances / Events / Raw
                  JSON dump) — admin-only triage tools. The whole
                  block is print:hidden so Export PDF mirrors the
                  user's session view exactly (no engineer noise in
                  the printed handout). On screen they live below
                  Session Details for in-place admin debugging. */}
              <div className="print:hidden">
              {/* === Utterances === */}
              <SectionHeading
                title="Transcript (utterances)"
                count={payload.utterances.length}
                copyText={
                  payload.utterances.length > 0
                    ? () =>
                        formatUtterancesForCopy(
                          payload.utterances,
                          s?.speakerRoles
                        )
                    : undefined
                }
              />
              <div
                className="bg-bg border border-border"
                style={{
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-6) var(--space-6)",
                  marginBottom: "var(--space-6)",
                  maxHeight: 480,
                  overflowY: "auto",
                }}
              >
                {payload.utterances.length === 0 ? (
                  <p className="text-sm text-text-muted">
                    No utterances captured.
                  </p>
                ) : (
                  <div
                    style={{
                      fontSize: "0.8125rem",
                      lineHeight: 1.55,
                    }}
                  >
                    {payload.utterances.map((u) => {
                      const role = resolveSpeakerRole(
                        u.dgSpeaker,
                        s?.speakerRoles
                      );
                      return (
                        <div key={u.id} style={{ marginBottom: 8 }}>
                          <span
                            className="text-text-subtle"
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "0.6875rem",
                              marginRight: 6,
                            }}
                          >
                            {fmtTimeOffset(u.atSeconds)}
                          </span>
                          <span
                            className="text-text-subtle"
                            style={{
                              fontSize: "0.6875rem",
                              fontWeight: 600,
                              textTransform: "uppercase",
                              marginRight: 6,
                              letterSpacing: "0.05em",
                            }}
                          >
                            {role || `spk-${u.dgSpeaker ?? "?"}`}
                          </span>
                          <span>{u.text}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* === Events === */}
              <SectionHeading
                title="Events log"
                count={payload.events.length}
                copyText={
                  payload.events.length > 0
                    ? () => formatEventsForCopy(payload.events)
                    : undefined
                }
              />
              <div
                className="bg-bg border border-border"
                style={{
                  borderRadius: "var(--radius-lg)",
                  padding: "var(--space-6) var(--space-6)",
                  marginBottom: "var(--space-6)",
                  maxHeight: 480,
                  overflowY: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.75rem",
                  lineHeight: 1.55,
                }}
              >
                {payload.events.length === 0 ? (
                  <p
                    className="text-sm text-text-muted"
                    style={{ fontFamily: "inherit" }}
                  >
                    No events recorded.
                  </p>
                ) : (
                  payload.events.slice(-500).map((ev) => (
                    <div key={ev.id} style={{ marginBottom: 4 }}>
                      <span className="text-text-subtle">{fmtMs(ev.atMs)}</span>
                      {"  "}
                      <span style={{ fontWeight: 600 }}>{ev.source}</span>
                      {":"}
                      <span style={{ marginLeft: 6 }}>{ev.event}</span>
                      {ev.data !== null && ev.data !== undefined && (
                        <span
                          className="text-text-muted"
                          style={{ marginLeft: 8 }}
                        >
                          {JSON.stringify(ev.data)}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* === Raw JSON dump === */}
              {/* Heading row sits OUTSIDE the <details> so the Copy
                  button is always visible (clicking Copy shouldn't
                  also toggle the dump open/closed). The <details>
                  below holds only the toggle + the pre. */}
              <SectionHeading
                title="Raw JSON dump"
                copyText={() => JSON.stringify(payload, null, 2)}
              />
              <details
                style={{
                  marginBottom: "var(--space-6)",
                }}
              >
                <summary
                  style={{
                    cursor: "pointer",
                    fontSize: "0.8125rem",
                    fontWeight: 500,
                    color: "var(--color-text-muted)",
                    padding: "var(--space-3) 0",
                  }}
                >
                  Show full payload
                </summary>
                <pre
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6875rem",
                    background: "var(--color-bg)",
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-md)",
                    padding: 16,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 480,
                    overflowY: "auto",
                    margin: "8px 0 0 0",
                    lineHeight: 1.55,
                  }}
                >
                  {JSON.stringify(payload, null, 2)}
                </pre>
              </details>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Maps the admin payload's flat questions + comments into the
 *  Session["questions"] shape (each question carries a comments[]
 *  array). VideoSection's phase rail only reads the question fields,
 *  but the type expects comments — attaching them satisfies TS and
 *  unlocks future use cases (e.g. "comments per band" tooltips). */
function enrichedQuestions(payload: DetailPayload | null): Question[] {
  if (!payload) return [];
  // Admin payload uses string|null for nullable fields; the canonical
  // Question type uses string|undefined. Coerce here so TS is happy
  // without a structural cast.
  return payload.questions.map((q) => ({
    id: q.id,
    text: q.text,
    askedAtSeconds: q.askedAtSeconds,
    answerText: q.answerText,
    parentQuestionId: q.parentQuestionId ?? undefined,
    comments: payload.comments
      .filter((c) => c.questionId === q.id)
      .map((c) => ({
        id: c.id,
        text: c.text,
        expandedSuggestion: c.expandedSuggestion ?? undefined,
        atSeconds: c.atSeconds,
        // Comment.kind is "answer" | "listening" | undefined (see
        // types/session.ts:109). The admin payload widens it to
        // string; narrow here, defaulting unknown values to "answer".
        kind:
          c.kind === "answer" || c.kind === "listening" ? c.kind : "answer",
      })),
  }));
}

/* ============================================================
   Small subcomponents
   ============================================================ */
function Meta({
  label,
  children,
}: {
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div
        className="text-text-subtle"
        style={{
          fontSize: "0.6875rem",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: "0.9375rem" }}>{children}</div>
    </div>
  );
}

function S3KeyLine({ label, k }: { label: string; k?: string | null }) {
  if (!k) return null;
  return (
    <div
      className="text-text-subtle"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6875rem",
        marginTop: 6,
        wordBreak: "break-all",
      }}
    >
      {label}: {k}
    </div>
  );
}

function SectionHeading({
  title,
  count,
  copyText,
}: {
  title: string;
  count?: number;
  /** Lazy text producer for the right-aligned Copy button. The
   *  function is called only when the user clicks Copy, so heavy
   *  payload formatting (JSON.stringify of 1000-row events arrays,
   *  for example) is paid only on demand — rendering the heading
   *  costs nothing. Pass undefined to omit the copy button. */
  copyText?: () => string;
}) {
  return (
    <div className="flex items-baseline gap-2 mb-3">
      <h2
        style={{
          fontSize: "1.0625rem",
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        {title}
      </h2>
      {typeof count === "number" && (
        <span
          className="text-text-subtle"
          style={{ fontSize: "0.875rem", fontWeight: 400 }}
        >
          {count}
        </span>
      )}
      {copyText && <CopyButton getText={copyText} />}
    </div>
  );
}

/** Right-aligned copy-to-clipboard button. Shows "Copy" → "Copied"
 *  for 1.5s on success. Failures (clipboard-blocked, e.g. http://)
 *  silently no-op since the button just doesn't visibly change. */
function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(getText());
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="ml-auto font-medium hover:text-text"
      style={{
        fontSize: "0.75rem",
        color: "var(--color-text-muted)",
        background: "transparent",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        padding: "4px 10px",
        fontFamily: "inherit",
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/* ============================================================
   Helpers
   ============================================================ */
function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
function fmtTimeOffset(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  const milli = (Math.max(0, ms) % 1000).toString().padStart(3, "0");
  return `${m}:${s}.${milli}`;
}
function formatDuration(sec: number): string {
  if (!sec) return "0s";
  if (sec < 60) return `${Math.round(sec)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  if (mins < 60) return `${mins}m ${remSec}s`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return `${hrs}h ${remMin}m`;
}
function resolveSpeakerRole(
  dgSpeaker: number | null,
  speakerRoles: unknown
): string | null {
  if (dgSpeaker === null || dgSpeaker === undefined) return null;
  if (!speakerRoles || typeof speakerRoles !== "object") return null;
  const m = speakerRoles as Record<string, string>;
  return m[String(dgSpeaker)] || null;
}

/* ============================================================
   Copy-to-clipboard formatters

   Each one converts a section's structured data into a flat plaintext
   block — suitable for pasting into a Slack message, a bug report, or
   a Google Doc without HTML/JSON noise. JSON copy is reserved for
   structured-data sections (Score, Raw dump) where the structure
   itself matters.
   ============================================================ */

/** Questions + commentary as a flat outline. Each Lead/Probe gets a
 *  `[mm:ss] LEAD: text` line, its answer below indented, and any AI
 *  commentary listed as `  → [time] [kind] text` underneath. */
function formatQuestionsForCopy(
  questions: DetailPayload["questions"],
  comments: DetailPayload["comments"]
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const kind = q.parentQuestionId === null ? "LEAD" : "PROBE";
    lines.push(`[${fmtTimeOffset(q.askedAtSeconds)}] ${kind}: ${q.text}`);
    if (q.answerText) {
      lines.push(`  Answer: ${q.answerText}`);
    }
    const qComments = comments.filter((c) => c.questionId === q.id);
    for (const c of qComments) {
      lines.push(
        `  → [${fmtTimeOffset(c.atSeconds)}] [${c.kind}] ${stripHtml(c.text)}`
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Strip the inline HTML the LLM emits in comment text (just
 *  <strong>...</strong> in practice) so clipboard-pasted output is
 *  plain text — Slack / docs don't render the markup. The regex is
 *  intentionally minimal: it removes any tag matching `<...>`,
 *  treating the comment as our own trusted output. We do NOT need a
 *  full HTML parser here. */
function stripHtml(s: string): string {
  return s.replace(/<\/?[a-z][^>]*>/gi, "");
}

/** Transcript as `[mm:ss] ROLE: text` lines. Falls back to
 *  `spk-N` when the role wasn't resolved at session-end. */
function formatUtterancesForCopy(
  utterances: DetailPayload["utterances"],
  speakerRoles: unknown
): string {
  return utterances
    .map((u) => {
      const role =
        resolveSpeakerRole(u.dgSpeaker, speakerRoles)?.toUpperCase() ||
        `SPK-${u.dgSpeaker ?? "?"}`;
      return `[${fmtTimeOffset(u.atSeconds)}] ${role}: ${u.text}`;
    })
    .join("\n");
}

/** Events log as one line per event: `mm:ss.mmm  source:event  data?`.
 *  Caps at the most recent 500 events to mirror the on-screen
 *  rendering — copying 10000+ events is rarely useful. */
function formatEventsForCopy(events: DetailPayload["events"]): string {
  return events
    .slice(-500)
    .map((ev) => {
      const dataPart =
        ev.data === null || ev.data === undefined
          ? ""
          : "  " + JSON.stringify(ev.data);
      return `${fmtMs(ev.atMs)}  ${ev.source}:${ev.event}${dataPart}`;
    })
    .join("\n");
}
