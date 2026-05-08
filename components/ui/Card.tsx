import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

/**
 * Card — matches the marketing site's `.feature-card` and the
 * generic card chrome used across legal/auth pages.
 *
 * Variants:
 *  - default     : 1px border, --radius-lg, padding --space-6,
 *                  background bg. Used for content blocks.
 *  - clickable   : same as default + border darkens on hover and
 *                  the card lifts by 2px. Use when the entire card
 *                  is a click target (Past Sessions list rows in
 *                  card layout, feature cards on marketing).
 *  - inset       : background --color-surface, no border. Use for
 *                  nested cards (a card inside a card) so the inner
 *                  surface reads as recessed.
 *  - hero        : adds the marketing-site hero shadow + thicker
 *                  padding. Reserved for the prominent "main visual"
 *                  card on a page.
 *
 * Padding is controlled centrally via the variant; `paddingless`
 * lets callers place full-bleed sub-sections (like header strips
 * with their own internal padding) without fighting the card.
 */
export type CardVariant = "default" | "clickable" | "inset" | "hero";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  paddingless?: boolean;
  asChild?: never; // reserved for future Slot pattern
  children?: ReactNode;
}

const baseByVariant: Record<CardVariant, string> = {
  default:
    "bg-bg border border-border rounded-lg",
  clickable:
    "bg-bg border border-border rounded-lg transition-[border-color,transform] duration-200 hover:border-border-strong hover:-translate-y-0.5 cursor-pointer",
  inset:
    "bg-surface rounded-lg",
  hero:
    "bg-surface border border-border rounded-xl shadow-[0_12px_32px_rgba(10,10,10,0.08),0_4px_8px_rgba(10,10,10,0.04)]",
};

const paddingByVariant: Record<CardVariant, string> = {
  default: "p-6",
  clickable: "p-6",
  inset: "p-4",
  hero: "p-3",
};

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { variant = "default", paddingless = false, className, children, ...rest },
  ref
) {
  const composed = [
    baseByVariant[variant],
    paddingless ? "" : paddingByVariant[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div ref={ref} className={composed} {...rest}>
      {children}
    </div>
  );
});
