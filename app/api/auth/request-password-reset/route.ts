import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import {
  generateVerificationCode,
  sendPasswordResetEmail,
} from "@/lib/email";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

/**
 * POST /api/auth/request-password-reset
 *
 * Step 1 of 2 in the forgot-password flow.
 *
 * Body: { email }
 *
 * Flow:
 *   1. Look up users.email. If no user → return 404 with a clear
 *      "no account with this email" message. We DO leak account
 *      existence here — for an invite-only beta the UX clarity wins
 *      over the marginal email-enumeration concern, and registration
 *      already leaks the same signal ("account exists, sign in
 *      instead"). Symmetric across both flows.
 *   2. Rate-limit: same email can't re-request within 60s.
 *   3. Generate 6-digit code, bcrypt-hash, UPSERT into password_resets
 *      keyed by email (resets attempts to 0 on re-request).
 *   4. SES-send via sendPasswordResetEmail (uses the password-reset
 *      template, distinct subject so the user knows what they're
 *      confirming).
 *
 * Returns: { ok: true, email } on success.
 */
interface Body {
  email?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_SECONDS = 60;

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
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 }
    );
  }

  try {
    // === Step 1: confirm user exists ===
    const userRes = await query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE email = $1`,
      [email]
    );
    if (userRes.rowCount === 0) {
      return NextResponse.json(
        {
          error:
            "No account found with this email. Please register first.",
        },
        { status: 404 }
      );
    }
    const user = userRes.rows[0];

    // === Step 2: rate-limit ===
    const recent = await query<{ created_at: Date }>(
      `SELECT created_at FROM password_resets
        WHERE email = $1
          AND created_at > now() - INTERVAL '${RATE_LIMIT_SECONDS} seconds'`,
      [email]
    );
    if (recent.rowCount && recent.rowCount > 0) {
      return NextResponse.json(
        {
          error: `Please wait a moment before requesting another code.`,
        },
        { status: 429 }
      );
    }

    // === Step 3: generate + hash + upsert ===
    const code = generateVerificationCode();
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await query(
      `INSERT INTO password_resets
         (email, code_hash, attempts, expires_at, created_at)
       VALUES ($1, $2, 0, $3, now())
       ON CONFLICT (email) DO UPDATE SET
         code_hash  = EXCLUDED.code_hash,
         attempts   = 0,
         expires_at = EXCLUDED.expires_at,
         created_at = now()`,
      [email, codeHash, expiresAt]
    );

    // === Step 4: SES send ===
    // Use first name only for the greeting (matches the registration
    // email norm). Fall back to the full stored name if no whitespace
    // (single-word names just use the whole thing).
    const firstName = (user.name || "").split(/\s+/)[0] || undefined;
    const sent = await sendPasswordResetEmail({
      to: email,
      code,
      name: firstName,
    });
    if (!sent) {
      // Roll back the DB row so a retry isn't gated by the rate limit.
      await query(`DELETE FROM password_resets WHERE email = $1`, [email]);
      return NextResponse.json(
        {
          error:
            "Couldn't send the password reset email. Please try again in a moment.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, email });
  } catch (e) {
    console.error("[/api/auth/request-password-reset] failed:", e);
    return NextResponse.json(
      { error: "Couldn't send the reset code. Please try again." },
      { status: 500 }
    );
  }
}
