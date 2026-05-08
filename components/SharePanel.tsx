"use client";

/**
 * SharePanel — inline panel that surfaces a session's live share token
 * as two URLs (a viewer page + a JSON API endpoint) plus Copy and
 * Revoke affordances.
 *
 * Used by both the admin debug page (admin-minted shares for any
 * user's session) and the regular Past Session view (owner-minted
 * shares for the user's own session). The lifecycle endpoint at
 * /api/sessions/[id]/share authenticates either case via
 * "owner OR admin" — see app/api/sessions/[id]/share/route.ts.
 */

import { useState } from "react";
import type { SessionShare } from "@/lib/client-api";

export function SharePanel({
  share,
  busy,
  error,
  onClose,
  onRevoke,
}: {
  share: SessionShare;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRevoke: () => void;
}) {
  return (
    <div
      className="bg-surface border border-border"
      style={{
        marginTop: "var(--space-4)",
        borderRadius: "var(--radius-md)",
        // Padding uses var(--space-4) + var(--space-6) — `--space-5`
        // does NOT exist in the design system (the scale jumps 4 →
        // 6), so an earlier `var(--space-5)` would render as an
        // invalid declaration → 0 horizontal padding.
        padding: "var(--space-4) var(--space-6)",
      }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <div
          className="text-text-subtle"
          style={{
            fontSize: "0.6875rem",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          Share link
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRevoke}
            disabled={busy}
            className="text-xs hover:text-text"
            style={{
              color: "var(--color-error)",
              background: "transparent",
              border: "none",
              cursor: busy ? "default" : "pointer",
              padding: 0,
            }}
          >
            {busy ? "Revoking…" : "Revoke"}
          </button>
          <span className="text-text-subtle">·</span>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-text-muted hover:text-text"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Close
          </button>
        </div>
      </div>

      <SharePanelRow
        label="Viewer URL (open in browser)"
        url={share.viewerUrl}
      />
      <SharePanelRow
        label="JSON API (for programmatic import)"
        url={share.jsonUrl}
      />

      <p
        className="text-text-subtle"
        style={{
          fontSize: "0.75rem",
          lineHeight: 1.5,
          marginTop: 12,
        }}
      >
        Anyone with this link can read the session contents. Recording
        URLs in the JSON re-sign on each fetch with a 1-hour TTL. Click
        Revoke to invalidate the link permanently.
      </p>

      {error && (
        <div
          className="mt-3 text-xs rounded-md px-3 py-2"
          style={{
            color: "var(--color-error)",
            background: "rgba(178, 58, 58, 0.06)",
            border: "1px solid rgba(178, 58, 58, 0.2)",
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function SharePanelRow({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        className="text-text-muted"
        style={{
          fontSize: "0.6875rem",
          fontWeight: 500,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          className="border border-border bg-bg flex-1"
          style={{
            padding: "7px 10px",
            borderRadius: "var(--radius-sm)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.75rem",
            minWidth: 0,
          }}
        />
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked */
            }
          }}
          className="shrink-0 btn btn-secondary btn-sm"
          style={{ minWidth: 70 }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
