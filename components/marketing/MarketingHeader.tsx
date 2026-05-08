"use client";

import Link from "next/link";
import { BrandLockup } from "@/components/ui";

/**
 * Shared marketing-site header. Sticky at the top of the viewport
 * with a 60px height + frosted-glass backdrop, matching the
 * marketing-source `.header` rule:
 *
 *   - Brand lockup left
 *   - Nav links centered (hidden under 760px)
 *   - "Sign in" primary CTA right
 *
 * Used by the landing page and the two legal pages so chrome stays
 * consistent across all public-facing surfaces.
 *
 * Anchor links point to in-page sections on the landing route (`#features`,
 * `#how`). When clicked from /privacy or /terms, they prefix `/`
 * automatically — Next.js Link resolves them against the current path
 * unless we use the absolute href, so we explicitly use `/#features`
 * etc. to ensure the link bounces back to the landing first.
 */
export function MarketingHeader() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-border"
      style={{
        height: "60px",
        background: "rgba(255, 255, 255, 0.8)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <div className="container mx-auto h-full flex items-center justify-between gap-3 sm:gap-6 px-4 sm:px-6 max-w-[1120px]">
        <Link href="/" aria-label="Puebulo">
          <BrandLockup size={26} />
        </Link>

        <nav className="hidden min-[760px]:flex gap-8" aria-label="Primary">
          <Link
            href="/#features"
            className="text-[14px] font-medium text-text-muted hover:text-text transition-colors"
          >
            Features
          </Link>
          <Link
            href="/#how"
            className="text-[14px] font-medium text-text-muted hover:text-text transition-colors"
          >
            How it works
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/sign-in" className="btn btn-primary">
            Sign in
          </Link>
        </div>
      </div>
    </header>
  );
}
