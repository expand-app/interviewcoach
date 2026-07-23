import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { generateInviteCode, isAdminRequest } from "@/lib/auth-server";

export const runtime = "nodejs";

/**
 * /api/admin/invitations — admin-only invite-code management.
 *
 * GET:   list all codes (used + unused) for the admin audit view.
 * POST:  create N new codes, returns them so the admin can copy and
 *        share. Body: { count?: number = 1, note?: string }.
 *
 * Auth: see lib/auth-server.ts isAdminRequest — accepts x-user-id
 * (admin user from the web UI) or x-admin-token (opaque bearer).
 * Auth failures return 403 (not 401) because the endpoint exists
 * but the caller isn't authorized; 401 would suggest "sign in to
 * try again" which doesn't apply for an admin tool.
 */

const MAX_CODES_PER_REQUEST = 50;

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
  try {
    // Newest first so the admin sees what they just generated at the
    // top. Limit to 200 — for a manual admin workflow that's plenty,
    // and we don't want a runaway page if the table grows.
    const r = await query<{
      code: string;
      note: string | null;
      created_at: Date;
      used_at: Date | null;
      used_by: string | null;
      used_by_email: string | null;
    }>(
      `SELECT ic.code, ic.note, ic.created_at, ic.used_at, ic.used_by,
              u.email AS used_by_email
         FROM invitation_codes ic
         LEFT JOIN users u ON u.id = ic.used_by
        ORDER BY ic.created_at DESC
        LIMIT 200`
    );
    return NextResponse.json({
      codes: r.rows.map((row) => ({
        code: row.code,
        note: row.note,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at,
        usedAt:
          row.used_at instanceof Date
            ? row.used_at.toISOString()
            : row.used_at,
        usedByEmail: row.used_by_email,
      })),
    });
  } catch (e) {
    console.error("[/api/admin/invitations] GET failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

interface CreateBody {
  count?: number;
  note?: string;
}

export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured." },
      { status: 503 }
    );
  }
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: CreateBody = {};
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    /* empty body OK — defaults to count=1 */
  }

  const requestedCount = Math.max(1, Math.floor(body.count ?? 1));
  const count = Math.min(requestedCount, MAX_CODES_PER_REQUEST);
  const note = body.note?.trim() || null;

  try {
    // Generate codes one at a time and INSERT each; ON CONFLICT DO
    // NOTHING in case of (theoretical) collision so we don't error
    // out the whole batch. We retry up to count + 5 generations to
    // hit the requested count even if we hit a collision mid-batch.
    const created: string[] = [];
    let attempts = 0;
    while (created.length < count && attempts < count + 5) {
      attempts++;
      const code = generateInviteCode();
      const r = await query<{ code: string }>(
        `INSERT INTO invitation_codes (code, note)
         VALUES ($1, $2)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [code, note]
      );
      if (r.rowCount && r.rowCount > 0) {
        created.push(r.rows[0].code);
      }
    }

    return NextResponse.json({ codes: created });
  } catch (e) {
    console.error("[/api/admin/invitations] POST failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
