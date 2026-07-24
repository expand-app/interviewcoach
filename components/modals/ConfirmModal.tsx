"use client";

import { ModalShell } from "./ModalShell";
import { Button } from "@/components/ui";

interface Props {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** "primary" = mono black confirm button (the standard).
   *  "danger" = error-color confirm for destructive actions like
   *  Discard, Delete, Sign-out-without-saving. */
  tone?: "primary" | "danger";
  /** Optional third action, rendered left of Cancel in the error
   *  color's text (destructive-but-secondary, e.g. "Exit without
   *  saving" on the retake end dialog). Omit for the standard
   *  two-button layout. */
  altLabel?: string;
  onAlt?: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "primary",
  altLabel,
  onAlt,
  onCancel,
  onConfirm,
}: Props) {
  // Danger tone overrides the Button's mono background with the
  // design system's error color via inline style. Avoids polluting
  // the global .btn-primary rule with a danger variant — only this
  // one modal needs it. The Button primitive otherwise handles all
  // padding, radius, focus ring, and hover transitions.
  const dangerStyle =
    tone === "danger"
      ? {
          background: "var(--color-error)",
          color: "var(--color-bg)",
          borderColor: "var(--color-error)",
        }
      : undefined;

  return (
    <ModalShell open={open} onClose={onCancel}>
      <div className="p-7 px-8">
        <h2 className="text-[18px] font-semibold mb-1.5 text-text">{title}</h2>
        <div className="text-sm text-text-muted mb-5 leading-relaxed">{description}</div>
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex gap-2 justify-end">
            <Button onClick={onCancel}>{cancelLabel}</Button>
            <Button variant="primary" onClick={onConfirm} style={dangerStyle}>
              {confirmLabel}
            </Button>
          </div>
          {/* Destructive-secondary action on its own row so three
              buttons never overflow the 420px modal (the one-row
              layout clipped "Exit without saving" off the left edge). */}
          {altLabel && onAlt && (
            <button
              type="button"
              onClick={onAlt}
              className="self-start text-[13px] font-medium hover:underline"
              style={{ color: "var(--color-error)" }}
            >
              {altLabel}
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
