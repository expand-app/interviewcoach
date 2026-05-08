import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import {
  adminBootstrapPassword,
  adminEmail,
  hashPassword,
  verifyPassword,
} from "@/lib/auth-server";

export const runtime = "nodejs";

/**
 * POST /api/auth/sign-in
 *
 * Body: { email, password }
 *
 * Standard bcrypt verify. One special case: if the user is the admin
 * AND has no password_hash on file (legacy row from before bcrypt
 * landed), the endpoint compares the supplied password against the
 * env-configured ADMIN_PASSWORD and lazy-bootstraps the hash on
 * success. After this one-time path, the admin signs in via the
 * standard bcrypt path like everyone else.
 *
 * Returns: { userId, email, name }
 *
 * Always returns 401 with the same message on auth failure — we
 * don't distinguish "no such user" from "wrong password" so an
 * attacker can't enumerate emails. The "ask admin for access" hint
 * still applies here because registration is invite-only.
 */
interface Body {
  email?: string;
  password?: string;
}

const GENERIC_AUTH_ERROR =
  "Invalid email or password. If you don't have an account yet, ask the admin for an invitation code.";

export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured. Sign-in is unavailable." },
      { status: 503 }
    );
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  if (!email.includes("@") || password.length === 0) {
    return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
  }

  try {
    const r = await query<{
      id: string;
      email: string;
      name: string;
      password_hash: string | null;
    }>(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [email]
    );

    // === Admin lazy-bootstrap path ===
    // Two sub-cases land here:
    //   (1) The admin email exists (legacy row, no password_hash) and
    //       the typed password matches ADMIN_PASSWORD env. We hash and
    //       persist on the existing row, then proceed.
    //   (2) The admin email DOES NOT exist yet (fresh DB), and the
    //       typed password matches ADMIN_PASSWORD. We INSERT a new
    //       admin row with the hashed password. This makes the
    //       sign-in flow self-bootstrapping on a clean install — no
    //       manual SQL needed.
    if (email === adminEmail() && password === adminBootstrapPassword()) {
      const existing = r.rowCount && r.rowCount > 0 ? r.rows[0] : null;
      if (existing && existing.password_hash === null) {
        const hash = await hashPassword(password);
        await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
          hash,
          existing.id,
        ]);
        return NextResponse.json({
          userId: existing.id,
          email: existing.email,
          name: existing.name,
        });
      }
      if (!existing) {
        const hash = await hashPassword(password);
        const ins = await query<{ id: string; email: string; name: string }>(
          `INSERT INTO users (email, name, password_hash)
             VALUES ($1, $2, $3)
             RETURNING id, email, name`,
          [email, "Admin", hash]
        );
        const row = ins.rows[0];
        return NextResponse.json({
          userId: row.id,
          email: row.email,
          name: row.name,
        });
      }
      // existing user with a real hash — fall through to standard
      // verify (admin is using their real password, not env bootstrap).
    }

    if (r.rowCount === 0) {
      return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
    }
    const user = r.rows[0];
    if (!user.password_hash) {
      // No hash on file and not the admin bootstrap path — user
      // exists but can't sign in until they (or an admin) reset.
      return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
    }

    return NextResponse.json({
      userId: user.id,
      email: user.email,
      name: user.name,
    });
  } catch (e) {
    console.error("[/api/auth/sign-in] failed:", e);
    return NextResponse.json(
      { error: "Sign-in failed. Please try again." },
      { status: 500 }
    );
  }
}
