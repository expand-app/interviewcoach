/**
 * Client-side admin detection. Mirrors the server-side `adminEmail()`
 * in lib/auth-server.ts so the same email string drives both the API
 * authorization (server) and conditional-UI gates (client).
 *
 * The admin email defaults to "admin@puebulo.com". Set
 * NEXT_PUBLIC_ADMIN_EMAIL on EB if you ever want to change it — the
 * NEXT_PUBLIC_ prefix is required because this module runs in the
 * browser bundle.
 *
 * Security note: this is a UX gate, NOT a security boundary. A user
 * who edits localStorage to set their email to admin@puebulo.com will
 * see the admin UI elements, but every server endpoint re-checks the
 * caller's email server-side via x-user-id → users.email lookup.
 * Faking the localStorage email doesn't grant any actual privilege.
 */

import type { User } from "@/types/session";

export function adminEmail(): string {
  return (
    process.env.NEXT_PUBLIC_ADMIN_EMAIL?.trim() || "admin@puebulo.com"
  ).toLowerCase();
}

export function isAdminUser(user: User | null | undefined): boolean {
  if (!user?.email) return false;
  return user.email.trim().toLowerCase() === adminEmail();
}
