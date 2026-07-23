/**
 * Server-side auth helpers — bcrypt hash + verify, invite-code
 * generation, admin-bootstrap detection.
 *
 * Used by:
 *   - /api/auth/register   — hashPassword on new account creation
 *   - /api/auth/sign-in    — verifyPassword + lazy-bootstrap admin
 *   - /api/admin/invitations — generateInviteCode, isAdminRequest
 *
 * NOT used on the client. bcryptjs is a CPU-only pure-JS impl with no
 * native bindings; it works on Elastic Beanstalk's Amazon Linux Node
 * runtime out of the box (no apt-get / no rebuild).
 *
 * Env vars (server-side only — NOT NEXT_PUBLIC_):
 *   ADMIN_EMAIL       — the email that the admin endpoints accept.
 *                       Defaults to "admin@puebulo.com".
 *   ADMIN_PASSWORD    — used for one-time admin password bootstrap on
 *                       first sign-in after the bcrypt migration.
 *                       Defaults to NEXT_PUBLIC_ADMIN_PASSWORD if set
 *                       (so existing EB env vars keep working) and
 *                       falls back to the same hardcoded string the
 *                       legacy lib/auth-config.ts used.
 *   ADMIN_API_TOKEN   — opaque bearer for /api/admin/* endpoints,
 *                       letting the admin curl the API without
 *                       needing to be signed in. Optional; if unset,
 *                       the admin endpoints fall back to "x-user-id
 *                       must match the admin user's row".
 */

import bcrypt from "bcryptjs";
import { isDbConfigured, query } from "@/lib/db";

/** bcrypt cost factor. 10 is the modern default — ~50-100ms per hash
 *  on a modest VM. Higher slows registration / sign-in noticeably. */
const BCRYPT_ROUNDS = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Resolves the admin email. Falls back through env vars in priority
 *  order so legacy NEXT_PUBLIC_ deploys keep working without a config
 *  change. */
export function adminEmail(): string {
  return (
    process.env.ADMIN_EMAIL?.trim() ||
    process.env.NEXT_PUBLIC_ADMIN_EMAIL?.trim() ||
    "admin@puebulo.com"
  );
}

/** Resolves the admin bootstrap password. Same fallback chain as
 *  adminEmail. The sign-in endpoint compares against this when the
 *  admin row has no password_hash yet (lazy-bootstrap on first
 *  sign-in after deploying bcrypt auth). */
export function adminBootstrapPassword(): string {
  return (
    process.env.ADMIN_PASSWORD?.trim() ||
    process.env.NEXT_PUBLIC_ADMIN_PASSWORD?.trim() ||
    "puebulo-admin-2026"
  );
}

/**
 * Server-side admin gate. Used by every /api/admin/* endpoint to
 * decide whether to serve the response.
 *
 * Two accepted credentials, in priority order:
 *   (a) `x-admin-token` matching env ADMIN_API_TOKEN — opaque bearer
 *       for terminal / curl. Optional; when env var is unset, this
 *       path is disabled.
 *   (b) `x-user-id` resolves to a users.email equal to ADMIN_EMAIL.
 *       Used by the in-app admin UI (web client passes the signed-in
 *       user's id automatically).
 *
 * Failures return false so the route can decide between 401/403
 * shape — typically 403 ("you exist but aren't allowed").
 */
export async function isAdminRequest(req: Request): Promise<boolean> {
  // (a) bearer-token path. Constant-time-ish; for a small admin tool
  // direct === is fine.
  const token = req.headers.get("x-admin-token")?.trim();
  const envToken = process.env.ADMIN_API_TOKEN?.trim();
  if (envToken && token && token === envToken) return true;

  // (b) signed-in-user path.
  const userId = req.headers.get("x-user-id")?.trim();
  if (!userId) return false;
  if (!isDbConfigured()) return false;
  try {
    const r = await query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );
    if (r.rowCount === 0) return false;
    return r.rows[0].email.toLowerCase() === adminEmail().toLowerCase();
  } catch {
    return false;
  }
}

/** Generates a fresh invite code shaped like `puebulo-XXXXXXXX` where
 *  the suffix is 8 lowercase alphanumeric chars. Crockford-style
 *  alphabet (no 0/O/1/I/l) so codes copy/paste / read-aloud cleanly.
 *  ~36^8 = 2.8 trillion possibilities — collision risk negligible at
 *  any realistic admin volume. */
export function generateInviteCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // 31 chars
  let suffix = "";
  // Use crypto.getRandomValues if available (Node 19+), fall back to
  // Math.random for ancient runtimes. Both are non-blocking.
  const buf = new Uint32Array(8);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < 8; i++) {
    suffix += alphabet[buf[i] % alphabet.length];
  }
  return `puebulo-${suffix}`;
}

/**
 * Generates a public share token for a session, e.g.
 *   "share-7vR9aQK3X1bDfH2NLpZQwj4Yk0e_T8s8"
 *
 * 24 bytes of crypto-strong randomness → 32 chars base64url. ~192 bits
 * of entropy: even with the entire set of session IDs known, brute-
 * force enumeration is computationally infeasible. This is critical
 * because the session_shares.token IS the auth — there's no other
 * credential on the public /api/share/[token] endpoint.
 *
 * Why base64url (not Crockford alphabet like invite codes): URL-safety
 * matters here (the token sits in a path segment), and base64url is
 * native in Node's crypto/Buffer. Readability matters less because the
 * token is meant to be copied/pasted, not typed.
 */
export function generateShareToken(): string {
  // Lazy require so this file stays loadable in edge / browser-bundled
  // contexts that don't ship node:crypto. Server routes that import
  // this helper run on the Node runtime so the require resolves.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const bytes = crypto.randomBytes(24);
  return "share-" + bytes.toString("base64url");
}
