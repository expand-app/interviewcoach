import { NextResponse } from "next/server";
import { isDbConfigured, query, withTx } from "@/lib/db";
import { getUserIdFromHeaders } from "@/lib/api-auth";

export const runtime = "nodejs";

// ===== GET /api/sessions =====
// Lists the caller's saved sessions, newest first. Metadata only (no
// questions/comments/utterances/events) — the sidebar / past list
// only needs id / title / startedAt / duration / has-score-or-not.
export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json({ sessions: [] });
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }
  const r = await query<{
    id: string;
    title: string;
    started_at: Date;
    duration_seconds: number;
    has_score: boolean;
    score_error: string | null;
    session_mode: string | null;
    parent_session_id: string | null;
  }>(
    `SELECT id, title, started_at, duration_seconds,
            (score IS NOT NULL) AS has_score, score_error,
            session_mode, parent_session_id
     FROM sessions
     WHERE user_id = $1
     ORDER BY started_at DESC, created_at DESC`,
    [userId]
  );
  return NextResponse.json({
    sessions: r.rows.map((row) => ({
      id: row.id,
      title: row.title,
      startedAt: row.started_at.toISOString(),
      durationSeconds: row.duration_seconds,
      hasScore: row.has_score,
      scoreError: row.score_error ?? undefined,
      sessionMode: row.session_mode === "retake" ? "retake" : "live",
      parentSessionId: row.parent_session_id ?? undefined,
    })),
  });
}

// ===== POST /api/sessions =====
// Saves a full session at endLive time: session row + all
// questions/comments/utterances/events in one transaction.
//
// Body matches what the client serializes from the live store. See
// types/session.ts for the in-memory shapes; we pluck fields and
// flatten the nested arrays here.

interface SavedComment {
  id: string;
  text: string;
  atSeconds: number;
  expandedSuggestion?: string;
  // "cand-q-cmt" added 2026-05 for reverse-Q&A commentary on candidate
  // questions. See types/session.ts Comment for the full kind taxonomy.
  kind?: "answer" | "listening" | "cand-q-cmt";
  // Snapshot of the interviewer monologue the AI saw when generating
  // this hint; only set for kind="listening". Persisted to
  // comments.context_text so PastView can render "Interviewer
  // mentioned …" using the actual content the model reacted to.
  contextText?: string;
}
interface SavedQuestion {
  id: string;
  parentQuestionId?: string;
  text: string;
  askedAtSeconds: number;
  answerText?: string;
  comments: SavedComment[];
  // "candidate" added 2026-05 — reverse-Q&A questions where the
  // CANDIDATE asked the interviewer. Default ("interviewer") is the
  // standard case and preserved for legacy clients that don't send
  // this field.
  kind?: "interviewer" | "candidate";
}
interface SavedUtterance {
  id: string;
  dgSpeaker?: number;
  text: string;
  atSeconds: number;
  duration?: number;
}
interface SavedEvent {
  atMs: number;
  source: string;
  event: string;
  data?: unknown;
}
interface SaveBody {
  session: {
    id: string;
    title: string;
    jd: string;
    resume?: string;
    startedAt: string;
    durationSeconds: number;
    audioS3Key?: string;
    videoS3Key?: string;
    jdSummary?: string;
    resumeSummary?: string;
    interviewerProfile?: string;
    interviewerProfileSummary?: string;
    speakerRoles?: Record<number | string, "interviewer" | "candidate">;
    score?: unknown;
    scoreError?: string;
    // Retake support (2026-07). Absent on legacy clients → defaults
    // ('live', no parent) keep old payloads working unchanged.
    parentSessionId?: string;
    sessionMode?: "live" | "retake";
  };
  questions: SavedQuestion[];
  utterances?: SavedUtterance[];
  events?: SavedEvent[];
}

export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_URL not configured" },
      { status: 503 }
    );
  }
  const userId = getUserIdFromHeaders(req);
  if (!userId) {
    return NextResponse.json({ error: "x-user-id required" }, { status: 401 });
  }

  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const s = body.session;
  if (!s?.id || !s.title || !s.startedAt) {
    return NextResponse.json({ error: "session.{id,title,startedAt} required" }, { status: 400 });
  }

  await withTx(async (q) => {
    // session row first — children FK to it.
    await q(
      `INSERT INTO sessions (
         id, user_id, title, jd, resume, started_at, duration_seconds,
         audio_s3_key, video_s3_key, jd_summary, resume_summary,
         interviewer_profile, interviewer_profile_summary,
         speaker_roles, score, score_error,
         parent_session_id, session_mode
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18
       )
       ON CONFLICT (id) DO NOTHING`,
      [
        s.id,
        userId,
        s.title,
        s.jd,
        s.resume ?? "",
        s.startedAt,
        s.durationSeconds,
        s.audioS3Key ?? null,
        s.videoS3Key ?? null,
        s.jdSummary ?? null,
        s.resumeSummary ?? null,
        s.interviewerProfile ?? null,
        s.interviewerProfileSummary ?? null,
        JSON.stringify(s.speakerRoles ?? {}),
        s.score === undefined ? null : JSON.stringify(s.score),
        s.scoreError ?? null,
        s.parentSessionId ?? null,
        s.sessionMode === "retake" ? "retake" : "live",
      ]
    );

    // Insert Lead questions before Probes (Probes FK to Lead via
    // parent_question_id). Candidate-kind questions (reverse Q&A) have
    // no FK target so they can land in any order — bucket them with
    // the Leads (parentless). The client's array order is already
    // chronological; sort so all parentless rows come first.
    const leads = body.questions.filter((qq) => !qq.parentQuestionId);
    const probes = body.questions.filter((qq) => Boolean(qq.parentQuestionId));
    const ordered = [...leads, ...probes];
    let position = 0;
    for (const qq of ordered) {
      await q(
        `INSERT INTO questions (
           id, session_id, parent_question_id, text,
           asked_at_seconds, answer_text, position, kind
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          qq.id,
          s.id,
          qq.parentQuestionId ?? null,
          qq.text,
          qq.askedAtSeconds,
          qq.answerText ?? "",
          position++,
          qq.kind ?? "interviewer",
        ]
      );
      for (const c of qq.comments ?? []) {
        await q(
          `INSERT INTO comments (
             id, question_id, text, expanded_suggestion, at_seconds, kind,
             context_text
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            c.id,
            qq.id,
            c.text,
            c.expandedSuggestion ?? null,
            c.atSeconds,
            c.kind ?? "answer",
            c.contextText ?? null,
          ]
        );
      }
    }

    // Bulk insert utterances. Build a multi-row VALUES tuple to keep
    // the round-trip count down on long sessions (1000+ utterances
    // per session is realistic).
    if (body.utterances?.length) {
      const us = body.utterances;
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (let i = 0; i < us.length; i++) {
        const u = us[i];
        valuesSql.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
        );
        params.push(
          u.id,
          s.id,
          u.dgSpeaker ?? null,
          u.text,
          u.atSeconds,
          u.duration ?? null,
          i
        );
      }
      await q(
        `INSERT INTO utterances (id, session_id, dg_speaker, text, at_seconds, duration, position)
         VALUES ${valuesSql.join(",")}
         ON CONFLICT (id) DO NOTHING`,
        params
      );
    }

    // Bulk insert events similarly.
    if (body.events?.length) {
      const evs = body.events;
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of evs) {
        valuesSql.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`
        );
        params.push(
          s.id,
          e.atMs,
          e.source,
          e.event,
          e.data === undefined ? null : JSON.stringify(e.data)
        );
      }
      await q(
        `INSERT INTO session_events (session_id, at_ms, source, event, data)
         VALUES ${valuesSql.join(",")}`,
        params
      );
    }
  });

  return NextResponse.json({ ok: true, id: s.id });
}
