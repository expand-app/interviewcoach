import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { adminEmail, isAdminRequest } from "@/lib/auth-server";

export const runtime = "nodejs";

/**
 * GET /api/admin/analytics/users
 *
 * Returns a flat user list with usage aggregates joined in. Sorted by
 * most recent activity (last session) so the active people surface
 * at the top. Capped at 200 — for a private beta that's plenty;
 * pagination can come later if we ever need it.
 *
 * Per-row aggregates:
 *   - totalSessions:    COUNT(*) of sessions for the user
 *   - totalMinutes:     SUM(duration_seconds) / 60, rounded
 *   - lastSessionAt:    MAX(started_at) — null if user never recorded
 *   - inviteCodeUsed:   the invite code they redeemed (if any)
 *
 * Shape: { users: [...] }
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

  // `?includeAdmin=1` flips the email filter into a no-op (empty
  // string matches every row) so the admin's own user record shows
  // up in the list. See overview route for the same pattern.
  const url = new URL(req.url);
  const includeAdmin = url.searchParams.get("includeAdmin") === "1";

  try {
    // Admin row is filtered server-side so the dashboard reflects
    // real-user signal only — admin's own test signups would
    // otherwise float to the top of the "most recent activity" sort.
    const r = await query<{
      id: string;
      email: string;
      name: string;
      created_at: Date;
      total_sessions: string;
      total_seconds: string | null;
      last_session_at: Date | null;
      invite_code: string | null;
    }>(
      `SELECT
         u.id,
         u.email,
         u.name,
         u.created_at,
         COALESCE(s.total_sessions, 0)::TEXT AS total_sessions,
         s.total_seconds::TEXT               AS total_seconds,
         s.last_session_at,
         ic.code                             AS invite_code
       FROM users u
       LEFT JOIN (
         SELECT
           user_id,
           COUNT(*) AS total_sessions,
           SUM(duration_seconds) AS total_seconds,
           MAX(started_at) AS last_session_at
         FROM sessions
         GROUP BY user_id
       ) s ON s.user_id = u.id
       LEFT JOIN invitation_codes ic ON ic.used_by = u.id
       WHERE u.email != $1
       ORDER BY COALESCE(s.last_session_at, u.created_at) DESC
       LIMIT 200`,
      [includeAdmin ? "" : adminEmail()]
    );

    return NextResponse.json({
      users: r.rows.map((row) => ({
        id: row.id,
        email: row.email,
        name: row.name,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at,
        totalSessions: Number(row.total_sessions),
        totalMinutes: Math.round(Number(row.total_seconds || 0) / 60),
        lastSessionAt: row.last_session_at
          ? row.last_session_at instanceof Date
            ? row.last_session_at.toISOString()
            : row.last_session_at
          : null,
        inviteCode: row.invite_code,
      })),
    });
  } catch (e) {
    console.error("[/api/admin/analytics/users] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
