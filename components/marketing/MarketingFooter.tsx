"use client";

import Link from "next/link";
import { BrandLockup } from "@/components/ui";

/**
 * Shared marketing-site footer. Two rows:
 *
 *   - Top: brand lockup left, Privacy/Terms links right.
 *   - Bottom: copyright + tagline, separated by a hairline divider.
 *
 * Mirrors the marketing-source `<footer>` and `.footer-simple` /
 * `.footer-bottom` markup. Used everywhere a MarketingHeader is —
 * landing, /privacy, /terms.
 */
export function MarketingFooter() {
  return (
    <footer className="border-t border-border" style={{ paddingTop: "var(--space-12)", paddingBottom: "var(--space-6)" }}>
      <div className="container mx-auto px-4 sm:px-6 max-w-[1120px]">
        <div
          className="flex justify-between items-center flex-wrap gap-4"
          style={{ marginBottom: "var(--space-8)" }}
        >
          <Link href="/" aria-label="Puebulo">
            <BrandLockup size={26} />
          </Link>
          <div className="flex gap-6">
            <Link
              href="/privacy"
              className="text-[14px] text-text-muted hover:text-text transition-colors"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="text-[14px] text-text-muted hover:text-text transition-colors"
            >
              Terms
            </Link>
          </div>
        </div>
        <div
          className="border-t border-border flex justify-between items-center flex-wrap gap-3 text-[12px] text-text-subtle"
          style={{ paddingTop: "var(--space-4)" }}
        >
          <span>© 2026 Puebulo. All rights reserved.</span>
          <span>Made for candidates, by candidates.</span>
        </div>
      </div>
    </footer>
  );
}
