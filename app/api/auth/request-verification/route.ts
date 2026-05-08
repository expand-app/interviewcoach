import { NextResponse } from "next/server";
import { isDbConfigured, query } from "@/lib/db";
import { hashPassword } from "@/lib/auth-server";
import { generateVerificationCode, sendVerificationEmail } from "@/lib/email";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";

/**
 * POST /api/auth/request-verification
 *
 * Step 1 of 2 in the email-verified registration flow.
 *
 * Body: { email, password, inviteCode, name? }
 *
 * Flow:
 *   1. Validate inputs (email shape, password length, code presence)
 *   2. Check email isn't already registered (hard fail; we don't even
 *      send a code to existing accounts to avoid leaking presence —
 *      but UX clarity wins over the marginal enumeration concern, so
 *      we DO surface "account exists, sign in instead")
 *   3. Check the invite code exists and is unused (DON'T consume yet
 *      — consumption happens in step 2 when verify-email succeeds)
 *   4. Rate-limit: same email can't re-request within 60 seconds, so
 *      a refresh-spammer can't drain the SES budget
 *   5. bcrypt-hash the password (so the email_verifications row never
 *      stores plaintext, even for abandoned registrations)
 *   6. Generate a 6-digit code, bcrypt-hash that too
 *   7. UPSERT into email_verifications (one row per email — fresh
 *      requests overwrite stale ones with reset attempts)
 *   8. SES-send the code; on send failure, delete the row so a retry
 *      isn't gated by the 60s rate limit
 *
 * Returns: { ok: true, email } on success.
 * The verification code is NEVER returned in the response — only the
 * recipient should know it (via the email itself).
 */
interface Body {
  email?: string;
  password?: string;
  inviteCode?: string;
  /** Required during registration. Used in the email greeting and
   *  stored on the eventual users.name row so the sidebar's bottom
   *  identity card and avatar initial show the real first name
   *  rather than a derived-from-email fallback. */
  firstName?: string;
  /** Optional. Concatenated as `${firstName} ${lastName}`.trim() into
   *  users.name. Useful for a future profile / billing screen but not
   *  required for the alpha. */
  lastName?: string;
  /** Legacy combined-name field — accepted for backward compat with
   *  any callers that haven't migrated to firstName/lastName. */
  name?: string;
}

const MIN_PASSWORD_LEN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_SECONDS = 60;

export async function POST(req: Request) {
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "Database not configured. Sign-up is unavailable." },
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
  const inviteCode = body.inviteCode?.trim() ?? "";
  // Resolve the display name. Priority:
  //   1. Explicit firstName/lastName (the new register UI sends these)
  //   2. Legacy `name` field (older callers / curl)
  //   3. Derived from the email local-part (last-resort fallback)
  // Final shape is "First Last", trimmed; if lastName is empty we just
  // store "First". Length capped at 60 chars to keep the avatar
  // initial logic + sidebar truncation sane.
  const firstName = body.firstName?.trim() ?? "";
  const lastName = body.lastName?.trim() ?? "";
  const combinedExplicit = `${firstName} ${lastName}`.trim();
  const legacyName = body.name?.trim() ?? "";
  const name = (combinedExplicit || legacyName || deriveName(email)).slice(
    0,
    60
  );

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 }
    );
  }
  if (firstName.length === 0 && legacyName.length === 0) {
    return NextResponse.json(
      { error: "Please enter your first name." },
      { status: 400 }
    );
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` },
      { status: 400 }
    );
  }
  if (inviteCode.length === 0) {
    return NextResponse.json(
      { error: "Invitation code is required." },
      { status: 400 }
    );
  }

  try {
    // === Step 2: email-already-registered check ===
    const existingUser = await query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [email]
    );
    if (existingUser.rowCount && existingUser.rowCount > 0) {
      return NextResponse.json(
        {
          error:
            "An account with this email already exists. Sign in instead.",
        },
        { status: 400 }
      );
    }

    // === Step 3: invite code validation (peek, don't consume) ===
    const codeRow = await query<{ used_at: Date | null }>(
      `SELECT used_at FROM invitation_codes WHERE code = $1`,
      [inviteCode]
    );
    if (codeRow.rowCount === 0) {
      return NextResponse.json(
        { error: "Invalid invitation code." },
        { status: 400 }
      );
    }
    if (codeRow.rows[0].used_at !== null) {
      return NextResponse.json(
        { error: "This invitation code has already been used." },
        { status: 400 }
      );
    }

    // === Step 4: rate-limit ===
    // If a fresh row exists for this email created < 60s ago, reject.
    // This is a soft floor — admin-issued codes shouldn't be in
    // anyone's hands often enough to need stricter quotas, and SES
    // itself caps daily volume.
    const recent = await query<{ created_at: Date }>(
      `SELECT created_at FROM email_verifications
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

    // === Step 5-6: hash password + code ===
    // Both bcrypt because we already have the dependency and the
    // round-trip is once-per-registration. ~150ms total — invisible
    // to the user, but eliminates plaintext storage.
    const verificationCode = generateVerificationCode();
    const [passwordHash, codeHash] = await Promise.all([
      hashPassword(password),
      bcrypt.hash(verificationCode, 10),
    ]);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    // === Step 7: UPSERT pending verification ===
    // ON CONFLICT DO UPDATE so a user can re-request after the rate
    // limit lapses without piling up rows. The UPDATE branch resets
    // attempts to 0 and pushes expires_at fresh — same effect as a
    // brand-new request.
    await query(
      `INSERT INTO email_verifications
         (email, code_hash, invite_code, password_hash, name, attempts, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, now())
       ON CONFLICT (email) DO UPDATE SET
         code_hash     = EXCLUDED.code_hash,
         invite_code   = EXCLUDED.invite_code,
         password_hash = EXCLUDED.password_hash,
         name          = EXCLUDED.name,
         attempts      = 0,
         expires_at    = EXCLUDED.expires_at,
         created_at    = now()`,
      [email, codeHash, inviteCode, passwordHash, name, expiresAt]
    );

    // === Step 8: SES send ===
    // Done AFTER the DB write so the persisted code_hash matches the
    // one that just went out via email. If SES fails, we delete the
    // row so a retry doesn't trip the 60s rate limit.
    // Email greeting uses ONLY the first name — "Hi Wilson," reads
    // friendlier than "Hi Wilson Lee," and matches modern transactional
    // email norms (Stripe / Notion / Linear all do first-name-only).
    // Fall back to the full stored `name` if for some reason the first
    // word is empty (legacy `name`-only callers).
    const firstNameOnly = (firstName || name).split(/\s+/)[0] || name;
    const sent = await sendVerificationEmail({
      to: email,
      code: verificationCode,
      name: firstNameOnly,
    });
    if (!sent) {
      await query(`DELETE FROM email_verifications WHERE email = $1`, [
        email,
      ]);
      return NextResponse.json(
        {
          error:
            "Couldn't send the verification email. Please try again in a moment.",
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, email });
  } catch (e) {
    console.error("[/api/auth/request-verification] failed:", e);
    return NextResponse.json(
      { error: "Couldn't send the verification code. Please try again." },
      { status: 500 }
    );
  }
}

function deriveName(email: string): string {
  const local = email.split("@")[0]?.trim() ?? "";
  if (!local) return "User";
  return local.charAt(0).toUpperCase() + local.slice(1);
}
