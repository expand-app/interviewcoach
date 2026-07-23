import type { HTMLAttributes, ReactNode } from "react";

/**
 * Eyebrow — small UPPERCASE label used for column titles (LIVE
 * COMMENTARY, LIVE CAPTIONS), section kickers (FEATURES, HOW IT
 * WORKS), and table headers. Matches the marketing site's
 * `.eyebrow` and `.col-label` classes.
 *
 * Replaces the ad-hoc `text-[11px] font-medium uppercase
 * tracking-wider text-ink-lighter` strings that are scattered
 * across the existing JSX. Phase 3 will swap call-sites to use
 * this component; new code should use it directly.
 */
interface EyebrowProps extends HTMLAttributes<HTMLSpanElement> {
  as?: "span" | "div";
  children: ReactNode;
}

export function Eyebrow({
  as = "span",
  className,
  children,
  ...rest
}: EyebrowProps) {
  const Tag = as as "span";
  return (
    <Tag
      className={"eyebrow" + (className ? " " + className : "")}
      {...rest}
    >
      {children}
    </Tag>
  );
}
