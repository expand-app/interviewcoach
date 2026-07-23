import { NextResponse } from "next/server";
import { isDbConfigured, withTx } from "@/lib/db";
import { hashPassword } from "@/lib/auth-server";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

/**
 * POST /api/auth/reset-password
 *
 * Step 2 of 2 in the forgot-password flow.
 *
 * Body: { email, code, newPassword }
 *
 * Atomic flow inside a single Postgres transaction:
 *   1. SELECT FOR UPDATE the password_resets row.
 *   2. Check expires_at — past TTL → DELETE row, return "expired".
 *   3. Check attempts — already at 5 → DELETE row, return "too many".
 *   4. bcrypt.compare(code, code_hash). Wrong → UPDATE attempts++.
 *      If this push hits 5, also DELETE so the next request must
 *      start over with a fresh code.
 *   5. UPDATE users SET password_hash = bcrypt(newPassword) WHERE email.
 *      Returns the user row so the client can sign in immediately.
 *   6. DELETE the password_resets row (single-use, done).
 *
 * Returns: { userId, email, name } — same shape as /api/auth/sign-in
 * so the client can drop straight into the signed-in state without
 * an extra round trip.
 */
interface Body {
  email?: string;
  code?: string;
  newPassword?: string;
}

const MAX_ATTEMPTS = 5;
const MIN_PASSWORD_LEN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured." },
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
  const rawCode = body.code?.trim() ?? "";
  const normalizedCode = rawCode.replace(/\D/g, "");
  const newPassword = body.newPassword ?? "";

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Invalid email." }, { status: 400 });
  }
  if (normalizedCode.length !== 6) {
    return NextResponse.json(
      { error: "Enter the 6-digit code from your email." },
      { status: 400 }
    );
  }
  if (newPassword.length < MIN_PASSWORD_LEN) {
    return NextResponse.json(
      {
        error: `New password must be at least ${MIN_PASSWORD_LEN} characters.`,
      },
      { status: 400 }
    );
  }

  // Hash the new password OUTSIDE the transaction — bcrypt is CPU-bound
  // and we don't want a 50-100ms hash holding a Postgres connection
  // open.
  const newPasswordHash = await hashPassword(newPassword);

  try {
    const result = await withTx(async (q) => {
      // Step 1: lock the pending reset row.
      const pendingRes = await q<{
        code_hash: string;
        attempts: number;
        expires_at: Date;
      }>(
        `SELECT code_hash, attempts, expires_at
           FROM password_resets
          WHERE email = $1
          FOR UPDATE`,
        [email]
      );
      if (pendingRes.rowCount === 0) {
        return {
          error:
            "No pending password reset for this email. Request a new code.",
          status: 400,
        } as const;
      }
      const pending = pendingRes.rows[0];

      // Step 2: TTL check.
      if (pending.expires_at.getTime() < Date.now()) {
        await q(`DELETE FROM password_resets WHERE email = $1`, [email]);
        return {
          error:
            "This code has expired. Request a new one to continue.",
          status: 400,
        } as const;
      }

      // Step 3: attempts check.
      if (pending.attempts >= MAX_ATTEMPTS) {
        await q(`DELETE FROM password_resets WHERE email = $1`, [email]);
        return {
          error:
            "Too many incorrect attempts. Request a new code to continue.",
          status: 400,
        } as const;
      }

      // Step 4: code compare.
      const ok = await bcrypt.compare(normalizedCode, pending.code_hash);
      if (!ok) {
        const newAttempts = pending.attempts + 1;
        if (newAttempts >= MAX_ATTEMPTS) {
          await q(`DELETE FROM password_resets WHERE email = $1`, [email]);
          return {
            error:
              "Too many incorrect attempts. Request a new code to continue.",
            status: 400,
          } as const;
        }
        await q(
          `UPDATE password_resets SET attempts = $1 WHERE email = $2`,
          [newAttempts, email]
        );
        const remaining = MAX_ATTEMPTS - newAttempts;
        return {
          error: `Incorrect code. ${remaining} ${
            remaining === 1 ? "attempt" : "attempts"
          } remaining.`,
          status: 400,
        } as const;
      }

      // Step 5: update users.password_hash. Return the user row for
      // the auto-sign-in path.
      const upd = await q<{ id: string; email: string; name: string }>(
        `UPDATE users
            SET password_hash = $1
          WHERE email = $2
          RETURNING id, email, name`,
        [newPasswordHash, email]
      );
      if (upd.rowCount === 0) {
        // The user row was deleted between step 1 and step 5. Clean
        // up the orphan reset row and ask them to start over.
        await q(`DELETE FROM password_resets WHERE email = $1`, [email]);
        return {
          error:
            "Account no longer exists. Please register again.",
          status: 400,
        } as const;
      }
      const user = upd.rows[0];

      // Step 6: clean up.
      await q(`DELETE FROM password_resets WHERE email = $1`, [email]);

      return { ok: true, user } as const;
    });

    if ("error" in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      userId: result.user.id,
      email: result.user.email,
      name: result.user.name,
    });
  } catch (e) {
    console.error("[/api/auth/reset-password] failed:", e);
    return NextResponse.json(
      { error: "Password reset failed. Please try again." },
      { status: 500 }
    );
  }
}
