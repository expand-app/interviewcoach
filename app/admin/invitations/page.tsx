"use client";

/**
 * /admin/invitations — minimal admin tool for issuing invite codes.
 *
 * Server-side authorization is the real boundary (the API endpoint
 * checks `x-user-id` matches the admin email). This page is just the
 * UI; an unsigned-in or non-admin viewer who lands here will see the
 * forbidden state because the GET call returns 403.
 *
 * Workflow:
 *   1. Admin signs in normally at /sign-in
 *   2. Visits /admin/invitations
 *   3. Clicks "Generate code" — POSTs to /api/admin/invitations
 *   4. New code appears in the list with a Copy button
 *   5. Admin shares the code with whoever they're inviting
 *   6. When that person registers, the code's "Used by" column fills
 *      in so the admin sees the redemption history
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { Button, BrandLockup } from "@/components/ui";

interface InviteCode {
  code: string;
  note: string | null;
  createdAt: string;
  usedAt: string | null;
  usedByEmail: string | null;
}

export default function AdminInvitationsPage() {
  const router = useRouter();
  const user = useStore((s) => s.user);
  const userId = user?.userId;
  const [codes, setCodes] = useState<InviteCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [count, setCount] = useState(1);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  // Zustand-persist hydration gate. Same pattern as app/app/page.tsx:
  // on first client render, the persisted user state from localStorage
  // hasn't loaded yet — `user` is null even for signed-in users. If we
  // run the auth-gate effect immediately, every signed-in admin gets
  // bounced to /sign-in. Wait for hasHydrated() before doing anything
  // that depends on `user`.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (useStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = useStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);

  // Bounce signed-out viewers straight to /sign-in. The API would
  // 403 anyway, but a redirect is friendlier than an error page.
  useEffect(() => {
    if (!hydrated) return;
    if (!user) router.replace("/sign-in");
  }, [hydrated, user, router]);

  // Initial fetch + refetch after each successful create. The user
  // dependency forces a re-run if the user signs out and back in
  // mid-session (rare, but matches the rest of the app).
  useEffect(() => {
    if (!hydrated) return;
    if (!userId) return;
    void refresh(userId);
  }, [hydrated, userId]);

  async function refresh(uid: string) {
    setError(null);
    try {
      const r = await fetch("/api/admin/invitations", {
        headers: { "x-user-id": uid },
        cache: "no-store",
      });
      if (r.status === 403) {
        setError(
          "This page is admin-only. Sign in with the admin account to manage invitation codes."
        );
        setCodes([]);
        return;
      }
      if (!r.ok) {
        setError("Couldn't load invitations.");
        setCodes([]);
        return;
      }
      const data = (await r.json()) as { codes: InviteCode[] };
      setCodes(data.codes);
    } catch {
      setError("Network error loading invitations.");
      setCodes([]);
    }
  }

  async function generate() {
    if (!userId) return;
    setGenerating(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({
          count: Math.max(1, Math.min(50, count)),
          note: note.trim() || undefined,
        }),
      });
      if (!r.ok) {
        if (r.status === 403) {
          setError("Only the admin account can generate invitation codes.");
        } else {
          setError("Couldn't generate codes. Please try again.");
        }
        return;
      }
      // Refresh from the server so the list shows the canonical
      // ordering (newest first by created_at) — keeps things tidy
      // even if multiple admins ever generate concurrently.
      setNote("");
      await refresh(userId);
    } catch {
      setError("Network error.");
    } finally {
      setGenerating(false);
    }
  }

  async function copyToClipboard(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied((c) => (c === code ? null : c)), 1500);
    } catch {
      /* clipboard blocked — fall back to nothing visible */
    }
  }

  // Render nothing until hydration completes — same as /app's gate.
  // Without this, the page flashes the empty card for a frame before
  // the redirect-to-/sign-in effect fires for unsigned-in viewers,
  // OR re-mounts and fires the API call twice for signed-in users.
  if (!hydrated) return null;
  if (!user) return null; // will redirect via the effect above

  return (
    <>
      {/* Signed-in app header. Distinct from the public-side
          MarketingHeader: the brand lockup links to /app (not /), and
          the right side carries no "Sign in" CTA / no Features / no
          How-it-works marketing nav — none of those make sense once a
          user is in the protected admin area. The visual style still
          matches MarketingHeader (sticky, 60px, frosted) so the
          chrome doesn't visually shift between routes. */}
      <header
        className="sticky top-0 z-50 border-b border-border"
        style={{
          height: "60px",
          background: "rgba(255, 255, 255, 0.8)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div className="container mx-auto h-full flex items-center justify-between gap-6 px-6 max-w-[1120px]">
          <Link href="/app" aria-label="Back to app">
            <BrandLockup size={26} />
          </Link>
          <Link
            href="/app"
            className="text-sm text-text-muted hover:text-text"
          >
            ← Back to app
          </Link>
        </div>
      </header>
      <div
        style={{
          minHeight: "calc(100vh - 60px)",
          padding: "var(--space-12) var(--space-6) var(--space-16)",
          background: "var(--color-surface)",
        }}
      >
        <div style={{ maxWidth: 880, margin: "0 auto" }}>
          {/* Page heading. The header above already carries the brand
              mark and a Back-to-app link, so this row has no nav — just
              the title + subtitle. */}
          <div className="mb-8">
            <h1
              style={{
                fontSize: "1.75rem",
                fontWeight: 600,
                letterSpacing: "-0.02em",
                lineHeight: 1.2,
                marginBottom: 6,
              }}
            >
              Invitation codes
            </h1>
            <p
              className="text-text-muted"
              style={{ fontSize: "0.9375rem", lineHeight: 1.5 }}
            >
              Generate single-use codes to onboard new beta users.
            </p>
          </div>

          {/* Generate panel — its own white card so it reads as the
              primary action zone, separated from the historical-list
              card below by a small gap. */}
          <div
            className="bg-bg border border-border"
            style={{
              borderRadius: "var(--radius-lg)",
              padding: "var(--space-6)",
              marginBottom: "var(--space-6)",
            }}
          >
            <h2
              style={{
                fontSize: "0.9375rem",
                fontWeight: 600,
                marginBottom: 14,
              }}
            >
              Generate new codes
            </h2>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col" style={{ gap: 6 }}>
                <span
                  className="text-text-muted"
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  How many
                </span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value) || 1)}
                  className="border border-border bg-bg"
                  style={{
                    width: 80,
                    padding: "9px 11px",
                    borderRadius: "var(--radius-md)",
                    fontSize: "0.9375rem",
                    fontFamily: "inherit",
                  }}
                />
              </label>
              <label className="flex flex-col flex-1" style={{ gap: 6, minWidth: 220 }}>
                <span
                  className="text-text-muted"
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  Note (optional)
                </span>
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Alex from Augury"
                  className="border border-border bg-bg"
                  style={{
                    padding: "9px 11px",
                    borderRadius: "var(--radius-md)",
                    fontSize: "0.9375rem",
                    fontFamily: "inherit",
                  }}
                />
              </label>
              <Button
                variant="primary"
                onClick={generate}
                disabled={generating}
              >
                {generating ? "Generating…" : "Generate"}
              </Button>
            </div>
          </div>

          {error && (
            <div
              className="mb-6 text-xs rounded-md px-3 py-2"
              style={{
                color: "var(--color-error)",
                background: "rgba(178, 58, 58, 0.06)",
                border: "1px solid rgba(178, 58, 58, 0.2)",
              }}
            >
              {error}
            </div>
          )}

          {/* "All codes" section heading sits OUTSIDE the card —
              same pattern as the page heading at the top. Putting it
              inside the card with a border-bottom looked wrong because
              the inner border didn't visually align with the card's
              outer rounded edge. Now the title is just normal section
              text above the card, and the card itself holds only the
              table (or empty/loading state) flush with its own border. */}
          <div className="flex items-baseline gap-2 mb-3">
            <h2
              style={{
                fontSize: "1.0625rem",
                fontWeight: 600,
                letterSpacing: "-0.01em",
              }}
            >
              All codes
            </h2>
            {codes && codes.length > 0 && (
              <span
                className="text-text-subtle"
                style={{
                  fontSize: "0.875rem",
                  fontWeight: 400,
                }}
              >
                {codes.length}
              </span>
            )}
          </div>

          <div
            className="bg-bg border border-border"
            style={{
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
            }}
          >
            {codes === null ? (
              <p
                className="text-sm text-text-muted"
                style={{ padding: "var(--space-6) var(--space-6)" }}
              >
                Loading…
              </p>
            ) : codes.length === 0 ? (
              <p
                className="text-sm text-text-muted"
                style={{ padding: "var(--space-6) var(--space-6)" }}
              >
                No codes yet. Generate one above to invite a new user.
              </p>
            ) : (
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "0.875rem",
                }}
              >
                <thead>
                  <tr style={{ background: "var(--color-surface)" }}>
                    <Th>Code</Th>
                    <Th>Note</Th>
                    <Th>Status</Th>
                    <Th>Used by</Th>
                    <Th>Created</Th>
                  </tr>
                </thead>
                <tbody>
                  {codes.map((c) => {
                    const used = c.usedAt !== null;
                    return (
                      <tr
                        key={c.code}
                        style={{
                          borderTop: "1px solid var(--color-border)",
                        }}
                      >
                        <Td>
                          <div className="flex items-center gap-2">
                            <code
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: "0.8125rem",
                                color: used
                                  ? "var(--color-text-subtle)"
                                  : "var(--color-text)",
                                textDecoration: used ? "line-through" : "none",
                              }}
                            >
                              {c.code}
                            </code>
                            {!used && (
                              <button
                                type="button"
                                onClick={() => copyToClipboard(c.code)}
                                className="text-xs text-text-muted hover:text-text underline underline-offset-2"
                                style={{
                                  border: "none",
                                  background: "transparent",
                                  cursor: "pointer",
                                  padding: 0,
                                }}
                              >
                                {copied === c.code ? "copied" : "copy"}
                              </button>
                            )}
                          </div>
                        </Td>
                        <Td>{c.note || <span className="text-text-subtle">—</span>}</Td>
                        <Td>
                          <span
                            style={{
                              fontSize: "0.6875rem",
                              fontWeight: 500,
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: used
                                ? "var(--color-surface-2)"
                                : "rgba(46, 125, 50, 0.1)",
                              color: used
                                ? "var(--color-text-subtle)"
                                : "rgb(46, 125, 50)",
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                            }}
                          >
                            {used ? "used" : "available"}
                          </span>
                        </Td>
                        <Td>
                          {c.usedByEmail || <span className="text-text-subtle">—</span>}
                        </Td>
                        <Td>
                          <span className="text-text-muted">
                            {fmtDate(c.createdAt)}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "11px 16px",
        fontWeight: 600,
        fontSize: "0.6875rem",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        color: "var(--color-text-subtle)",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: "13px 16px",
        verticalAlign: "middle",
      }}
    >
      {children}
    </td>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
