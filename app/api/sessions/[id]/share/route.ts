import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { generateShareToken, isAdminRequest, adminEmail } from "@/lib/auth-server";

export const runtime = "nodejs";

/**
 * /api/sessions/[id]/share — share-token lifecycle, available to
 * EITHER the session's owner OR the admin.
 *
 *   GET     → returns the existing live share for the session, or
 *             { share: null }.
 *   POST    → returns the existing live share, OR mints a new one if
 *             none exists. Idempotent: rapid double-clicks don't
 *             create two URLs.
 *   DELETE  → revokes the live share (sets revoked_at = now()).
 *             Subsequent public GET /api/share/[token] returns 410.
 *
 * Public counterpart: GET /api/share/[token] — see app/api/share/[token]/route.ts.
 *
 * Auth model: `gateRequest()` accepts (a) admin via isAdminRequest
 * (header token OR admin email) — admin can mint shares for ANY
 * session — or (b) the session's owner via the standard x-user-id
 * header. Non-owner regular users hit a 403; the URL itself is one
 * shape (no /api/admin/... vs /api/sessions/...) so the client
 * doesn't need to know whether it's currently signed in as an
 * admin or a regular owner.
 */

interface ShareRow {
  token: string;
  session_id: string;
  created_by: string;
  created_at: Date;
  revoked_at: Date | null;
}

/** Resolves the PUBLIC origin (e.g. https://www.puebulo.com) for a
 *  request that's reaching Node behind nginx + ELB. See the comment
 *  on the duplicate copy in this file's history for why this matters
 *  — req.url returns the INTERNAL host, useless to copy/paste. */
function getPublicOrigin(req: Request): string {
  const envBase = process.env.APP_BASE_URL?.trim();
  if (envBase) return envBase.replace(/\/$/, "");

  const fwdHost = req.headers.get("x-forwarded-host")?.trim();
  const fwdProto = req.headers.get("x-forwarded-proto")?.trim();
  if (fwdHost) {
    const host = fwdHost.split(",")[0].trim();
    const proto = (fwdProto?.split(",")[0].trim() || "https").replace(
      /[^a-z]/gi,
      ""
    );
    return `${proto}://${host}`;
  }

  const directHost = req.headers.get("host")?.trim();
  if (directHost) {
    const proto = new URL(req.url).protocol.replace(":", "") || "http";
    return `${proto}://${directHost}`;
  }

  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

function buildUrls(req: Request, token: string) {
  const origin = getPublicOrigin(req);
  return {
    viewerUrl: `${origin}/share/${token}`,
    jsonUrl: `${origin}/api/share/${token}`,
  };
}

function shapeShare(req: Request, row: ShareRow) {
  return {
    token: row.token,
    sessionId: row.session_id,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
    ...buildUrls(req, row.token),
  };
}

/**
 * Returns either an error response (403/503/etc.) OR a context object
 * with the resolved actor identity. Single function so each route
 * handler stays focused on the lifecycle logic.
 */
async function gateRequest(
  req: Request,
  sessionId: string
): Promise<
  | { error: NextResponse }
  | { actorUserId: string; isAdmin: boolean }
> {
  if (!isDbConfigured()) {
    return {
      error: NextResponse.json(
        { error: "Database not configured." },
        { status: 503 }
      ),
    };
  }

  const xUserId = req.headers.get("x-user-id")?.trim() || "";

  // Admin path: header token OR x-user-id maps to admin email.
  // Resolves before the owner-check so an admin viewing another
  // user's session passes without needing the session's owner_id.
  const isAdmin = await isAdminRequest(req);
  if (isAdmin) {
    // Resolve a sensible actorUserId for created_by FK. Prefer the
    // x-user-id if present (admin signed in via web UI), else look
    // up the admin's row by email (admin via x-admin-token header).
    let actorUserId = xUserId;
    if (!actorUserId) {
      try {
        const adminRow = await query<{ id: string }>(
          `SELECT id FROM users WHERE email = $1 LIMIT 1`,
          [adminEmail()]
        );
        if (adminRow.rowCount === 0) {
          return {
            error: NextResponse.json(
              { error: "Admin user row not found" },
              { status: 500 }
            ),
          };
        }
        actorUserId = adminRow.rows[0].id;
      } catch (e) {
        console.error("[share] admin lookup:", e);
        return {
          error: NextResponse.json(
            { error: "Internal error" },
            { status: 500 }
          ),
        };
      }
    }
    return { actorUserId, isAdmin: true };
  }

  // Owner path: x-user-id must match sessions.user_id.
  if (!xUserId) {
    return {
      error: NextResponse.json(
        { error: "x-user-id required" },
        { status: 401 }
      ),
    };
  }
  try {
    const r = await query<{ user_id: string }>(
      `SELECT user_id FROM sessions WHERE id = $1`,
      [sessionId]
    );
    if (r.rowCount === 0) {
      return {
        error: NextResponse.json({ error: "Session not found" }, { status: 404 }),
      };
    }
    if (r.rows[0].user_id !== xUserId) {
      return {
        error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    }
    return { actorUserId: xUserId, isAdmin: false };
  } catch (e) {
    console.error("[share] owner check:", e);
    return {
      error: NextResponse.json({ error: "Internal error" }, { status: 500 }),
    };
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const sessionId = id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const gate = await gateRequest(req, sessionId);
  if ("error" in gate) return gate.error;

  try {
    const r = await query<ShareRow>(
      `SELECT token, session_id, created_by, created_at, revoked_at
         FROM session_shares
        WHERE session_id = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [sessionId]
    );
    if (r.rowCount === 0) {
      return NextResponse.json({ share: null });
    }
    return NextResponse.json({ share: shapeShare(req, r.rows[0]) });
  } catch (e) {
    console.error("[/api/sessions/:id/share GET] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const sessionId = id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const gate = await gateRequest(req, sessionId);
  if ("error" in gate) return gate.error;
  const { actorUserId } = gate;

  try {
    // Verify session exists. (Admin path didn't validate this above —
    // gateRequest only checked ownership for the non-admin path. We
    // do it here unconditionally so an admin POST against a typo'd
    // session id returns 404 instead of crashing on the FK insert.)
    const sess = await query<{ id: string }>(
      `SELECT id FROM sessions WHERE id = $1`,
      [sessionId]
    );
    if (sess.rowCount === 0) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Idempotent: return existing live share if any.
    const existing = await query<ShareRow>(
      `SELECT token, session_id, created_by, created_at, revoked_at
         FROM session_shares
        WHERE session_id = $1 AND revoked_at IS NULL
        LIMIT 1`,
      [sessionId]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return NextResponse.json({ share: shapeShare(req, existing.rows[0]) });
    }

    // Mint a new token. Retry once on the (statistically impossible)
    // collision case so the caller gets a clean response instead of
    // a "duplicate key" 500.
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = generateShareToken();
      try {
        const ins = await query<ShareRow>(
          `INSERT INTO session_shares (token, session_id, created_by)
           VALUES ($1, $2, $3)
           RETURNING token, session_id, created_by, created_at, revoked_at`,
          [token, sessionId, actorUserId]
        );
        return NextResponse.json({ share: shapeShare(req, ins.rows[0]) });
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "23505" && attempt === 0) {
          const winner = await query<ShareRow>(
            `SELECT token, session_id, created_by, created_at, revoked_at
               FROM session_shares
              WHERE session_id = $1 AND revoked_at IS NULL
              LIMIT 1`,
            [sessionId]
          );
          if (winner.rowCount && winner.rowCount > 0) {
            return NextResponse.json({
              share: shapeShare(req, winner.rows[0]),
            });
          }
          continue;
        }
        throw e;
      }
    }
    return NextResponse.json(
      { error: "Couldn't mint a share token. Try again." },
      { status: 500 }
    );
  } catch (e) {
    console.error("[/api/sessions/:id/share POST] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const sessionId = id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }
  const gate = await gateRequest(req, sessionId);
  if ("error" in gate) return gate.error;

  try {
    await query(
      `UPDATE session_shares
          SET revoked_at = now()
        WHERE session_id = $1 AND revoked_at IS NULL`,
      [sessionId]
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[/api/sessions/:id/share DELETE] failed:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
