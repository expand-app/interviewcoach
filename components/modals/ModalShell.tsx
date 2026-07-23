"use client";

import { useEffect, ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Pass "wide" for the JD+Resume modal (600px), "xwide" for the
   *  admin daily-detail modal (760px), defaults to 420px. */
  variant?: "default" | "wide" | "xwide";
  /** If true, clicking backdrop does nothing. */
  dismissible?: boolean;
}

export function ModalShell({ open, onClose, children, variant = "default", dismissible = true }: Props) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  const width =
    variant === "xwide"
      ? "w-[880px]"
      : variant === "wide"
      ? "w-[600px]"
      : "w-[420px]";

  // Backdrop: dimmer + strong blur. The pure-alpha treatment from
  // the marketing-site spec (rgba 0.45 with no blur) doesn't work
  // in practice — black-text-on-white-page bleeds through any
  // partial-alpha overlay because the text/bg contrast survives.
  // We tried bumping alpha to 0.62 and it was still readable.
  //
  // Solution: ALSO apply a strong backdrop-filter blur. At 8px the
  // background is unreadable as text but still discernible as
  // shape/colour, which reads as a cinematic depth cue rather than
  // "hazy / broken" (the earlier 2px blur looked half-applied).
  // Combined with a moderate 0.55 tint, the modal sits
  // unambiguously in the foreground.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "rgba(10, 10, 10, 0.55)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
      onClick={() => dismissible && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`bg-bg border border-border ${width} max-w-[92vw] max-h-[90vh] overflow-y-auto animate-appear`}
        style={{
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
