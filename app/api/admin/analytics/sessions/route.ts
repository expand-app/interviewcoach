import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { adminEmail, isAdminRequest } from "@/lib/auth-server";

export const runtime = "nodejs";

/**
 * GET /api/admin/analytics/sessions[?userId=...&limit=N]
 *
 * Returns the most recent sessions across ALL users (sorted by
 * started_at DESC) for the analytics dashboard's session table. Each
 * row carries the basics needed to identify, filter, and triage:
 *   - sessionId, title, startedAt, durationSeconds
 *   - user (id + email + name)
 *   - hasAudio / hasVideo: did the recording reach S3?
 *   - questionCount: how many lead/probe questions were captured
 *   - scoreState: "scored" | "failed" | "unscored"
 *
 * Click-through to /admin/analytics/sessions/[id] for full debug
 * detail (transcript, events, recording playback).
 *
 * Optional filter:
 *   userId — only sessions belonging to this user. Useful when an
 *            admin clicks into a user from the users table.
 *   limit  — capped at 500. Default 100.
 */
export async function GET(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured." },
      { status: 503 }
    );
  }
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const userIdFilter = url.searchParams.get("userId")?.trim() || null;
  const rawLimit = Number(url.searchParams.get("limit") || 100);
  const limit = Math.min(500, Math.max(1, Math.floor(rawLimit)));
  // `?includeAdmin=1` flips the email filter into a no-op so the
  // admin's own sessions appear in the list. Same pattern as the
  // overview / users endpoints.
  const includeAdmin = url.searchParams.get("includeAdmin") === "1";

  try {
    // Always exclude admin sessions from the dashboard. If a userId
    // filter is set, that filter takes precedence (an explicit drill
    // into a specific user, even admin if you ever pass admin's id —
    // but the admin id isn't surfaced in the UI so this is moot).
    const params: unknown[] = [];
    let where = "";
    if (userIdFilter) {
      params.push(userIdFilter);
      where = `WHERE s.user_id = $1`;
    } else {
      // Empty string when includeAdmin is true matches every row
      // (no real user has empty email) so the existing
      // `email != $1` predicate becomes a no-op without query
      // restructuring.
      params.push(includeAdmin ? "" : adminEmail());
      where = `WHERE u.email != $1`;
    }
    params.push(limit);
    const limitParam = `$${params.length}`;

    const r = await query<{
      id: string;
      title: string;
      started_at: Date;
      duration_seconds: number;
      audio_s3_key: string | null;
      video_s3_key: string | null;
      score: unknown;
      score_error: string | null;
      user_id: string;
      user_email: string;
      user_name: string;
      question_count: string;
    }>(
      `SELECT
         s.id, s.title, s.started_at, s.duration_seconds,
         s.audio_s3_key, s.video_s3_key, s.score, s.score_error,
         u.id    AS user_id,
         u.email AS user_email,
         u.name  AS user_name,
         COALESCE((
           SELECT COUNT(*) FROM questions q WHERE q.session_id = s.id
         ), 0)::TEXT AS question_count
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       ${where}
       ORDER BY s.started_at DESC
       LIMIT ${limitParam}`,
      params
    );

    return NextResponse.json({
      sessions: r.rows.map((row) => ({
        id: row.id,
        title: row.title,
        startedAt:
          row.started_at instanceof Date
            ? row.started_at.toISOString()
            : row.started_at,
        durationSeconds: row.duration_seconds,
        hasAudio: row.audio_s3_key !== null,
        hasVideo: row.video_s3_key !== null,
        scoreState: row.score
          ? "scored"
          : row.score_error
          ? "failed"
          : "unscored",
        scoreError: row.score_error,
        questionCount: Number(row.question_count),
        user: {
          id: row.user_id,
          email: row.user_email,
          name: row.user_name,
        },
      })),
    });
  } catch (e) {
    console.error("[/api/admin/analytics/sessions] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
