"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingHeader } from "./MarketingHeader";
import { MarketingFooter } from "./MarketingFooter";

/**
 * Shared chrome for legal pages (/privacy, /terms).
 *
 * Wraps the marketing header/footer around a constrained 680px
 * prose column. Children are the actual policy content as JSX.
 *
 * Renders:
 *   - Marketing header (brand + nav + Sign in)
 *   - Centered title block (eyebrow + h1 + last-updated)
 *   - Optional table of contents
 *   - Long prose with section headings
 *   - "See also" cross-link row at the bottom
 *   - Marketing footer
 *
 * The prose styles (link underline, bold, list spacing) are
 * inherited via the `legal-prose` class defined in globals.css.
 */
interface TocEntry {
  href: string;
  label: string;
}

interface LegalLayoutProps {
  /** Eyebrow above the title — typically just "Legal". */
  eyebrow?: string;
  title: string;
  /** Date string shown under the title, like "April 29, 2026". */
  updated: string;
  toc?: TocEntry[];
  /** Body content (h2s + ps + uls). Lives inside .legal-prose so
   *  link/list/strong styles cascade automatically. */
  children: ReactNode;
  /** Cross-link row at the very bottom of the body. Displayed as
   *  "See also: <link>." */
  alsoSee?: ReactNode;
}

export function LegalLayout({
  eyebrow = "Legal",
  title,
  updated,
  toc,
  children,
  alsoSee,
}: LegalLayoutProps) {
  return (
    <>
      <MarketingHeader />
      <main style={{ padding: "var(--space-16) 0 var(--space-24)" }}>
        <div className="container-prose mx-auto px-6" style={{ maxWidth: "680px" }}>
          {/* Title block — centered, hairline-divided from the body */}
          <div
            className="text-center"
            style={{
              marginBottom: "var(--space-12)",
              paddingBottom: "var(--space-8)",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <span className="block eyebrow" style={{ marginBottom: "var(--space-3)" }}>
              {eyebrow}
            </span>
            <h1
              style={{
                marginBottom: "var(--space-3)",
                fontSize: "clamp(1.75rem, 3.5vw, 2.5rem)",
              }}
            >
              {title}
            </h1>
            <p style={{ fontSize: "0.8125rem", color: "var(--color-text-subtle)" }}>
              Last updated {updated}
            </p>
          </div>

          {toc && toc.length > 0 && (
            <div
              className="border border-border"
              style={{
                background: "var(--color-surface)",
                borderRadius: "var(--radius-lg)",
                padding: "var(--space-6)",
                marginBottom: "var(--space-12)",
              }}
            >
              <div
                className="eyebrow"
                style={{
                  fontWeight: 600,
                  color: "var(--color-text-subtle)",
                  marginBottom: "var(--space-3)",
                }}
              >
                On this page
              </div>
              <ol
                style={{
                  margin: 0,
                  paddingLeft: "var(--space-6)",
                  fontSize: "0.875rem",
                  lineHeight: 1.8,
                }}
              >
                {toc.map((entry) => (
                  <li key={entry.href}>
                    <a
                      href={entry.href}
                      className="legal-toc-link"
                      style={{ color: "var(--color-text-muted)", textDecoration: "none" }}
                    >
                      {entry.label}
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div
            className="legal-prose"
            style={{
              fontSize: "0.9375rem",
              lineHeight: 1.7,
              color: "var(--color-text-muted)",
            }}
          >
            {children}

            {alsoSee && (
              <p
                style={{
                  marginTop: "var(--space-12)",
                  paddingTop: "var(--space-6)",
                  borderTop: "1px solid var(--color-border)",
                  fontSize: "0.875rem",
                }}
              >
                See also: {alsoSee}
              </p>
            )}
          </div>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

/**
 * Highlight box used inside legal content for "the short version"
 * pull-out callouts. Matches the marketing-source `.highlight-box`
 * pattern: surface bg, hairline border, radius-lg, eyebrow label
 * on top.
 */
export function HighlightBox({
  label = "In plain English",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div
      className="border border-border"
      style={{
        background: "var(--color-surface)",
        borderRadius: "var(--radius-lg)",
        padding: "var(--space-6)",
        margin: "var(--space-6) 0",
      }}
    >
      <span
        className="block"
        style={{
          fontSize: "0.6875rem",
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: "var(--color-text)",
          textTransform: "uppercase",
          marginBottom: "var(--space-2)",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * Internal cross-link styled like a legal-prose link (underline
 * with subtle color animation). Used in the "See also" row at the
 * bottom of each legal page.
 */
export function LegalLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      style={{
        color: "var(--color-text)",
        textDecoration: "underline",
        textDecorationColor: "var(--color-border-strong)",
        textUnderlineOffset: "3px",
      }}
    >
      {children}
    </Link>
  );
}
