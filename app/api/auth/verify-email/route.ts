import { NextResponse } from "next/server";
import { isDbConfigured, withTx } from "@/lib/db";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

/**
 * POST /api/auth/verify-email
 *
 * Step 2 of 2 in the email-verified registration flow.
 *
 * Body: { email, code }
 *
 * Atomic flow inside a single Postgres transaction:
 *   1. SELECT FOR UPDATE the email_verifications row → serializes
 *      against concurrent verify attempts on the same email.
 *   2. Check expires_at — past TTL → DELETE row, return "expired".
 *   3. Check attempts — already at 5 → DELETE row, return "too many".
 *   4. bcrypt.compare(code, code_hash). Wrong → UPDATE attempts++.
 *      If this push hits 5, also DELETE so the next request must
 *      start over with a fresh code.
 *   5. SELECT FOR UPDATE the invitation_codes row → re-validate it's
 *      still unused. (Edge case: someone else redeemed the same code
 *      between request-verification and verify-email. We treat this
 *      as a hard fail and tell the user to request a new code.)
 *   6. INSERT users with the stashed password_hash + name.
 *   7. UPDATE invitation_codes SET used_at, used_by.
 *   8. DELETE the email_verifications row (single-use, done).
 *   9. COMMIT.
 *
 * Returns: { userId, email, name } — same shape as /api/auth/sign-in
 * so the client can drop straight into the signed-in state.
 */
interface Body {
  email?: string;
  code?: string;
}

const MAX_ATTEMPTS = 5;
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
  // Strip whitespace and any non-digit chars from the code — the
  // user might paste it from the email with a trailing space, or
  // accidentally include a separator. Anything that's not 6 digits
  // after normalization fails.
  const rawCode = body.code?.trim() ?? "";
  const normalizedCode = rawCode.replace(/\D/g, "");

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Invalid email." },
      { status: 400 }
    );
  }
  if (normalizedCode.length !== 6) {
    return NextResponse.json(
      { error: "Enter the 6-digit code from your email." },
      { status: 400 }
    );
  }

  try {
    const result = await withTx(async (q) => {
      // Step 1: lock the pending verification row.
      const pendingRes = await q<{
        id: string;
        code_hash: string;
        invite_code: string;
        password_hash: string;
        name: string;
        attempts: number;
        expires_at: Date;
      }>(
        `SELECT id, code_hash, invite_code, password_hash, name, attempts, expires_at
           FROM email_verifications
          WHERE email = $1
          FOR UPDATE`,
        [email]
      );
      if (pendingRes.rowCount === 0) {
        return {
          error:
            "No pending verification for this email. Request a new code.",
          status: 400,
        } as const;
      }
      const pending = pendingRes.rows[0];

      // Step 2: TTL check.
      const now = new Date();
      if (pending.expires_at.getTime() < now.getTime()) {
        await q(`DELETE FROM email_verifications WHERE id = $1`, [
          pending.id,
        ]);
        return {
          error:
            "This code has expired. Request a new one to continue.",
          status: 400,
        } as const;
      }

      // Step 3: attempts check (cap is exclusive — once attempts
      // reaches MAX_ATTEMPTS the row is dead).
      if (pending.attempts >= MAX_ATTEMPTS) {
        await q(`DELETE FROM email_verifications WHERE id = $1`, [
          pending.id,
        ]);
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
          // This was the last allowed attempt — burn the row.
          await q(`DELETE FROM email_verifications WHERE id = $1`, [
            pending.id,
          ]);
          return {
            error:
              "Too many incorrect attempts. Request a new code to continue.",
            status: 400,
          } as const;
        }
        await q(
          `UPDATE email_verifications SET attempts = $1 WHERE id = $2`,
          [newAttempts, pending.id]
        );
        const remaining = MAX_ATTEMPTS - newAttempts;
        return {
          error: `Incorrect code. ${remaining} ${
            remaining === 1 ? "attempt" : "attempts"
          } remaining.`,
          status: 400,
        } as const;
      }

      // Step 5: re-validate invite code under FOR UPDATE.
      const codeRes = await q<{ used_at: Date | null }>(
        `SELECT used_at FROM invitation_codes WHERE code = $1 FOR UPDATE`,
        [pending.invite_code]
      );
      if (codeRes.rowCount === 0) {
        // Code was deleted server-side after request-verification.
        // Burn the pending row; the user has to start over.
        await q(`DELETE FROM email_verifications WHERE id = $1`, [
          pending.id,
        ]);
        return {
          error:
            "Your invitation code is no longer valid. Ask the admin for a new one.",
          status: 400,
        } as const;
      }
      if (codeRes.rows[0].used_at !== null) {
        await q(`DELETE FROM email_verifications WHERE id = $1`, [
          pending.id,
        ]);
        return {
          error:
            "Your invitation code was used by someone else. Ask the admin for a new one.",
          status: 400,
        } as const;
      }

      // Step 6: race check on the email — another verify-email could
      // theoretically have created the user between the SELECT in step
      // 1 and now. UNIQUE on users.email would catch it as a 23505 at
      // INSERT, but a friendlier explicit check matches the rest of
      // the auth code style.
      const dupe = await q<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [email]
      );
      if (dupe.rowCount && dupe.rowCount > 0) {
        await q(`DELETE FROM email_verifications WHERE id = $1`, [
          pending.id,
        ]);
        return {
          error:
            "This email is already registered. Sign in instead.",
          status: 400,
        } as const;
      }

      // Step 7: create the user.
      const ins = await q<{ id: string; email: string; name: string }>(
        `INSERT INTO users (email, name, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email, name`,
        [email, pending.name, pending.password_hash]
      );
      const user = ins.rows[0];

      // Step 8: redeem the invite code.
      await q(
        `UPDATE invitation_codes
            SET used_at = now(), used_by = $1
          WHERE code = $2`,
        [user.id, pending.invite_code]
      );

      // Step 9: clean up pending row.
      await q(`DELETE FROM email_verifications WHERE id = $1`, [pending.id]);

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
    console.error("[/api/auth/verify-email] failed:", e);
    return NextResponse.json(
      { error: "Verification failed. Please try again." },
      { status: 500 }
    );
  }
}
