"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

/**
 * Button — matches the marketing site's .btn pattern exactly.
 *
 * Variants:
 *  - primary   : black bg, white text. The ONLY high-emphasis action
 *                in any given view. Use sparingly per design rule
 *                (1 primary CTA max per section).
 *  - secondary : transparent bg, 1px border, text-color text.
 *                Default for most actions.
 *  - ghost     : transparent bg, no border. For low-emphasis
 *                navigation links / icon buttons inside cards.
 *
 * Sizes:
 *  - default   : padding 0.5rem 1rem, font-size 0.875rem.
 *  - lg        : padding 0.75rem 1.25rem, font-size 0.9375rem.
 *                Use for hero CTAs and submit-style actions.
 *  - sm        : padding 0.375rem 0.75rem, font-size 0.8125rem.
 *                Use inside dense rows / table actions.
 *
 * Implementation note: the actual visual rules live in globals.css
 * under .btn / .btn-primary etc., so legacy code that uses those
 * class names directly (without going through this component) gets
 * the same look. The component just provides typed props + variant
 * plumbing for new code.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "default" | "lg" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Optional leading icon (Lucide or any 16-18px SVG). Sits left of label with 0.5rem gap. */
  leadingIcon?: ReactNode;
  /** Optional trailing icon. Sits right of label with 0.5rem gap. */
  trailingIcon?: ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  ghost: "btn-ghost",
};

const sizeClass: Record<ButtonSize, string> = {
  default: "",
  lg: "btn-lg",
  sm: "btn-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "default",
    leadingIcon,
    trailingIcon,
    className,
    children,
    type = "button",
    ...rest
  },
  ref
) {
  const composed = [
    "btn",
    variantClass[variant],
    sizeClass[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={composed} {...rest}>
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});
