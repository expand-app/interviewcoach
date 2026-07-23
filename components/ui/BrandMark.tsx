/**
 * Puebulo brand mark — black rounded square with overlapping "p" (white)
 * and "b" (mid-gray) characters. Visually identical to the SVG version
 * used in the marketing source, but rendered as HTML so the "p" / "b"
 * glyphs pick up the page's @font-face Inter directly.
 *
 * Why HTML and not SVG: SVG `<text>` elements have a separate font
 * resolution path that doesn't always pick up next/font's loaded
 * Inter — on some Chinese Windows fallback stacks the "p" / "b"
 * glyphs were rendering as `;`, leaking a stray semicolon into the
 * top-left of every page that displays the brand mark. HTML avoids
 * the issue: a plain <span> with `var(--font-sans)` always resolves
 * to whatever Inter the page has loaded.
 *
 * The favicon at `app/icon.svg` keeps SVG <text> because favicons
 * load outside the page CSS scope and there's no HTML alternative.
 *
 * Color comes from CSS variables (--color-mark-bg / --color-mark-p /
 * --color-mark-b) so dark-mode work later doesn't require touching
 * this file.
 */
interface BrandMarkProps {
  size?: number;
  className?: string;
}

export function BrandMark({ size = 26, className }: BrandMarkProps) {
  // Letter font-size and overlap offsets are tuned so the "p" + "b"
  // pair fills the rounded square the same way the SVG version did.
  // Math is proportional to `size` so it scales cleanly from the
  // 22px sidebar brand to the 44px login auth-card brand.
  const letterFontSize = Math.round(size * 0.78);
  const overlap = Math.round(size * 0.14);
  const radius = Math.round(size * 0.18);

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
        background: "var(--color-mark-bg)",
        borderRadius: radius,
        overflow: "hidden",
        // Force letters into a stacking context so explicit z-index
        // ordering (white "p" in front, gray "b" behind) is reliable.
        isolation: "isolate",
      }}
    >
      {/* "b" — sits behind, mid-gray. Right-shifted by half the
          overlap so "p" + "b" share a visual center. */}
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: `translate(calc(-50% + ${overlap / 2}px), -50%)`,
          fontFamily: "var(--font-sans)",
          fontWeight: 700,
          fontSize: `${letterFontSize}px`,
          lineHeight: 1,
          color: "var(--color-mark-b)",
          // Pull glyphs visually inside the box — "b" / "p" descenders
          // and ascenders push past the cap-line. A small downward
          // nudge re-centers them in the rounded square.
          marginTop: `${Math.round(size * 0.03)}px`,
          zIndex: 1,
          userSelect: "none",
        }}
      >
        b
      </span>
      {/* "p" — sits in front, white. Left-shifted by half the
          overlap to mirror "b" symmetrically. */}
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: `translate(calc(-50% - ${overlap / 2}px), -50%)`,
          fontFamily: "var(--font-sans)",
          fontWeight: 700,
          fontSize: `${letterFontSize}px`,
          lineHeight: 1,
          color: "var(--color-mark-p)",
          marginTop: `${Math.round(size * 0.03)}px`,
          zIndex: 2,
          userSelect: "none",
        }}
      >
        p
      </span>
    </div>
  );
}

/**
 * Brand mark + wordmark side-by-side. Same composition the marketing
 * site uses in the header and footer. Wordmark uses Inter weight 600
 * — never bold per the design rule (Inter goes too dense at 700 for
 * headlines).
 */
export function BrandLockup({
  size = 26,
  wordmarkClassName,
  className,
}: BrandMarkProps & { wordmarkClassName?: string }) {
  return (
    <div className={"inline-flex items-center gap-2.5 " + (className ?? "")}>
      <BrandMark size={size} />
      <span
        className={
          "font-semibold tracking-tight text-text " + (wordmarkClassName ?? "")
        }
        style={{ fontSize: "1rem", letterSpacing: "-0.02em" }}
      >
        puebulo
      </span>
    </div>
  );
}
