import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { adminEmail, isAdminRequest } from "@/lib/auth-server";

export const runtime = "nodejs";

/**
 * GET /api/admin/analytics/overview
 *
 * Returns the headline KPIs for the admin Analytics dashboard plus a
 * 30-day daily activity series (one row per day, most recent first).
 *
 * EXCLUDES the admin account from every metric. Admin's own test
 * sessions / signups would otherwise pollute the real-user signal.
 * The exclusion is implemented at the SQL level via a join filter
 * (users.email != adminEmail) so the totals truly reflect non-admin
 * activity — not just hidden client-side.
 *
 * Shape:
 * {
 *   kpis: { totalUsers, sessions7d, ... }
 *   dailyActivity: [
 *     { date: "2026-05-05", sessions: 4, newUsers: 1 },
 *     ...   // most-recent-first, exactly 30 rows
 *   ]
 * }
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

  // Optional `?includeAdmin=1` query param. When set, the admin's
  // own data is INCLUDED in all aggregates / lists; default behavior
  // remains "exclude admin". The page surfaces this as a checkbox so
  // the admin can verify their own seeded sessions without spinning
  // up a second account.
  //
  // Trick: instead of restructuring every WHERE clause, pass an
  // empty string as `adminEmailLower` when includeAdmin is true.
  // No real user has an empty email, so `WHERE email != ''` matches
  // every row → the filter becomes a no-op without code changes.
  const url = new URL(req.url);
  const includeAdmin = url.searchParams.get("includeAdmin") === "1";

  const adminEmailLower = includeAdmin ? "" : adminEmail();

  try {
    const [
      usersRes,
      sessionsRes,
      recordingsRes,
      scoreRes,
      invitesRes,
      activityRes,
    ] = await Promise.all([
      // === Users (non-admin only) ===
      query<{
        total: string;
        new_7d: string;
        new_30d: string;
      }>(
        `SELECT
           COUNT(*)::TEXT AS total,
           COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '7 days')::TEXT  AS new_7d,
           COUNT(*) FILTER (WHERE created_at >= now() - INTERVAL '30 days')::TEXT AS new_30d
         FROM users
         WHERE email != $1`,
        [adminEmailLower]
      ),
      // === Sessions (non-admin only) ===
      query<{
        total: string;
        seven_d: string;
        thirty_d: string;
        total_seconds: string | null;
        avg_seconds: string | null;
      }>(
        `SELECT
           COUNT(*)::TEXT                                                              AS total,
           COUNT(*) FILTER (WHERE s.started_at >= now() - INTERVAL '7 days')::TEXT     AS seven_d,
           COUNT(*) FILTER (WHERE s.started_at >= now() - INTERVAL '30 days')::TEXT    AS thirty_d,
           COALESCE(SUM(s.duration_seconds), 0)::TEXT                                  AS total_seconds,
           CASE WHEN COUNT(*) > 0 THEN AVG(s.duration_seconds)::TEXT ELSE NULL END     AS avg_seconds
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE u.email != $1`,
        [adminEmailLower]
      ),
      query<{
        with_audio: string;
        with_video: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE s.audio_s3_key IS NOT NULL)::TEXT AS with_audio,
           COUNT(*) FILTER (WHERE s.video_s3_key IS NOT NULL)::TEXT AS with_video
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE u.email != $1`,
        [adminEmailLower]
      ),
      query<{
        scored: string;
        failed: string;
        unscored: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE s.score IS NOT NULL)::TEXT                            AS scored,
           COUNT(*) FILTER (WHERE s.score IS NULL AND s.score_error IS NOT NULL)::TEXT  AS failed,
           COUNT(*) FILTER (WHERE s.score IS NULL AND s.score_error IS NULL)::TEXT      AS unscored
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE u.email != $1`,
        [adminEmailLower]
      ),
      // Invitations are intrinsically non-admin (admin doesn't redeem
      // codes). No filter needed.
      query<{
        pending: string;
        redeemed: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE used_at IS NULL)::TEXT     AS pending,
           COUNT(*) FILTER (WHERE used_at IS NOT NULL)::TEXT AS redeemed
         FROM invitation_codes`
      ),
      // === Daily activity series (last 30 days, non-admin only) ===
      // generate_series gives us a row per day so the response is
      // dense even on 0-activity days. Both sub-queries filter out
      // admin-owned data via the same email check.
      query<{
        day: Date;
        sessions: string;
        new_users: string;
      }>(
        `WITH days AS (
           SELECT generate_series(
             date_trunc('day', now()) - INTERVAL '29 days',
             date_trunc('day', now()),
             INTERVAL '1 day'
           ) AS day
         )
         SELECT
           d.day,
           COALESCE(s.cnt, 0)::TEXT  AS sessions,
           COALESCE(u.cnt, 0)::TEXT  AS new_users
         FROM days d
         LEFT JOIN (
           SELECT date_trunc('day', s.started_at) AS day, COUNT(*) AS cnt
             FROM sessions s
             JOIN users uu ON uu.id = s.user_id
            WHERE s.started_at >= date_trunc('day', now()) - INTERVAL '29 days'
              AND uu.email != $1
            GROUP BY 1
         ) s ON s.day = d.day
         LEFT JOIN (
           SELECT date_trunc('day', created_at) AS day, COUNT(*) AS cnt
             FROM users
            WHERE created_at >= date_trunc('day', now()) - INTERVAL '29 days'
              AND email != $1
            GROUP BY 1
         ) u ON u.day = d.day
         ORDER BY d.day DESC`,
        [adminEmailLower]
      ),
    ]);

    const u = usersRes.rows[0];
    const s = sessionsRes.rows[0];
    const r = recordingsRes.rows[0];
    const sc = scoreRes.rows[0];
    const i = invitesRes.rows[0];

    return NextResponse.json({
      kpis: {
        totalUsers: Number(u.total),
        newUsers7d: Number(u.new_7d),
        newUsers30d: Number(u.new_30d),
        totalSessions: Number(s.total),
        sessions7d: Number(s.seven_d),
        sessions30d: Number(s.thirty_d),
        totalRecordingMinutes: Math.round(Number(s.total_seconds || 0) / 60),
        avgSessionDurationSec: s.avg_seconds
          ? Math.round(Number(s.avg_seconds))
          : 0,
        scoredSessions: Number(sc.scored),
        failedScoreSessions: Number(sc.failed),
        unscoredSessions: Number(sc.unscored),
        sessionsWithAudio: Number(r.with_audio),
        sessionsWithVideo: Number(r.with_video),
        pendingInvites: Number(i.pending),
        redeemedInvites: Number(i.redeemed),
      },
      dailyActivity: activityRes.rows.map((row) => ({
        date:
          row.day instanceof Date
            ? row.day.toISOString().slice(0, 10)
            : String(row.day).slice(0, 10),
        sessions: Number(row.sessions),
        newUsers: Number(row.new_users),
      })),
    });
  } catch (e) {
    console.error("[/api/admin/analytics/overview] failed:", e);
    return NextResponse.json(
      { error: "Internal error" },
      { status: 500 }
    );
  }
}
