import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { isAdminRequest } from "@/lib/auth-server";
import { signGetUrl } from "@/lib/s3";

export const runtime = "nodejs";

/**
 * GET /api/admin/analytics/sessions/[id]
 *
 * Full session debug payload — joins everything an admin needs to
 * triage a single session in one shot. Distinct from the user-facing
 * /api/sessions/[id] in that it:
 *   - Bypasses the "session.user_id must equal x-user-id" check
 *     (admin can inspect any user's session).
 *   - Returns SIGNED S3 URLs inline so the playback works without
 *     an extra round-trip via /api/uploads/get.
 *   - Includes utterances, events, AND comments — the user-facing
 *     endpoint splits these across separate routes for laziness.
 *
 * Shape:
 * {
 *   session: { id, title, jd, resume, ..., user: { id, email, name } },
 *   recordings: { audioUrl?, videoUrl? },     // signed, 1h TTL
 *   questions: [...],
 *   comments: [...],
 *   utterances: [...],
 *   events: [...],
 * }
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured." },
      { status: 503 }
    );
  }
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const sessionId = id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  try {
    // === Session row + user join ===
    const sessRes = await query<{
      id: string;
      user_id: string;
      title: string;
      jd: string;
      resume: string;
      started_at: Date;
      duration_seconds: number;
      audio_s3_key: string | null;
      video_s3_key: string | null;
      video_mov_s3_key: string | null;
      jd_summary: string | null;
      resume_summary: string | null;
      interviewer_profile: string | null;
      interviewer_profile_summary: string | null;
      speaker_roles: unknown;
      score: unknown;
      score_error: string | null;
      created_at: Date;
      user_email: string;
      user_name: string;
    }>(
      `SELECT
         s.*,
         u.email AS user_email,
         u.name  AS user_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1`,
      [sessionId]
    );
    if (sessRes.rowCount === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const s = sessRes.rows[0];

    // === Sign recording URLs (in parallel) ===
    // The video MOV (transcoded) is the preferred playback source —
    // non-fragmented MP4 plays in WeChat/iOS. Fall back to the raw
    // video_s3_key (fragmented MP4 from MediaRecorder) if MOV missing.
    const videoKey = s.video_mov_s3_key || s.video_s3_key;
    const [audioUrl, videoUrl] = await Promise.all([
      s.audio_s3_key
        ? signGetUrl(s.audio_s3_key).catch((e) => {
            console.warn("[analytics-detail] sign audio failed:", e);
            return null;
          })
        : Promise.resolve(null),
      videoKey
        ? signGetUrl(videoKey).catch((e) => {
            console.warn("[analytics-detail] sign video failed:", e);
            return null;
          })
        : Promise.resolve(null),
    ]);

    // === Child rows ===
    const [questionsRes, commentsRes, utterancesRes, eventsRes] =
      await Promise.all([
        query<{
          id: string;
          parent_question_id: string | null;
          text: string;
          asked_at_seconds: number;
          answer_text: string;
          position: number;
        }>(
          `SELECT id, parent_question_id, text, asked_at_seconds, answer_text, position
             FROM questions
            WHERE session_id = $1
            ORDER BY position ASC`,
          [sessionId]
        ),
        query<{
          id: string;
          question_id: string;
          text: string;
          expanded_suggestion: string | null;
          at_seconds: number;
          kind: string;
        }>(
          `SELECT c.id, c.question_id, c.text, c.expanded_suggestion, c.at_seconds, c.kind
             FROM comments c
             JOIN questions q ON q.id = c.question_id
            WHERE q.session_id = $1
            ORDER BY c.at_seconds ASC`,
          [sessionId]
        ),
        query<{
          id: string;
          dg_speaker: number | null;
          text: string;
          at_seconds: number;
          duration: number | null;
          position: number;
        }>(
          `SELECT id, dg_speaker, text, at_seconds, duration, position
             FROM utterances
            WHERE session_id = $1
            ORDER BY position ASC`,
          [sessionId]
        ),
        query<{
          id: string;
          at_ms: number;
          source: string;
          event: string;
          data: unknown;
        }>(
          `SELECT id, at_ms, source, event, data
             FROM session_events
            WHERE session_id = $1
            ORDER BY at_ms ASC
            LIMIT 5000`,
          [sessionId]
        ),
      ]);

    return NextResponse.json({
      session: {
        id: s.id,
        title: s.title,
        jd: s.jd,
        resume: s.resume,
        startedAt:
          s.started_at instanceof Date
            ? s.started_at.toISOString()
            : s.started_at,
        createdAt:
          s.created_at instanceof Date
            ? s.created_at.toISOString()
            : s.created_at,
        durationSeconds: s.duration_seconds,
        audioS3Key: s.audio_s3_key,
        videoS3Key: s.video_s3_key,
        videoMovS3Key: s.video_mov_s3_key,
        jdSummary: s.jd_summary,
        resumeSummary: s.resume_summary,
        interviewerProfile: s.interviewer_profile,
        interviewerProfileSummary: s.interviewer_profile_summary,
        speakerRoles: s.speaker_roles,
        score: s.score,
        scoreError: s.score_error,
        user: {
          id: s.user_id,
          email: s.user_email,
          name: s.user_name,
        },
      },
      recordings: {
        audioUrl,
        videoUrl,
      },
      questions: questionsRes.rows.map((q) => ({
        id: q.id,
        parentQuestionId: q.parent_question_id,
        text: q.text,
        askedAtSeconds: q.asked_at_seconds,
        answerText: q.answer_text,
        position: q.position,
      })),
      comments: commentsRes.rows.map((c) => ({
        id: c.id,
        questionId: c.question_id,
        text: c.text,
        expandedSuggestion: c.expanded_suggestion,
        atSeconds: c.at_seconds,
        kind: c.kind,
      })),
      utterances: utterancesRes.rows.map((u) => ({
        id: u.id,
        dgSpeaker: u.dg_speaker,
        text: u.text,
        atSeconds: u.at_seconds,
        duration: u.duration,
        position: u.position,
      })),
      events: eventsRes.rows.map((e) => ({
        id: String(e.id),
        atMs: e.at_ms,
        source: e.source,
        event: e.event,
        data: e.data,
      })),
    });
  } catch (e) {
    console.error("[/api/admin/analytics/sessions/:id] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
