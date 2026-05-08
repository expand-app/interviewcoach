/**
 * Lightweight auth helper for the alpha.
 *
 * The frontend calls /api/users/upsert after the LoginView's
 * client-side credential check passes, gets back a userId, and stores
 * it. Every subsequent API call sends `x-user-id: <uuid>`.
 *
 * The server here does NOT verify that the caller actually owns that
 * user_id — anyone who can reach the API can forge the header. That
 * matches the existing alpha posture: the gating mechanism is "the
 * admin password isn't public", not real auth. When invitation codes
 * land we'll switch to a signed cookie or JWT.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getUserIdFromHeaders(req: Request): string | null {
  const raw = req.headers.get("x-user-id");
  if (!raw) return null;
  if (!UUID_RE.test(raw)) return null;
  return raw;
}
