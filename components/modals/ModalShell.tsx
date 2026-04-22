"use client";

import { useEffect, ReactNode } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Pass "wide" for the JD+Resume modal (600px), defaults to 420px. */
  variant?: "default" | "wide";
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

  const width = variant === "wide" ? "w-[600px]" : "w-[420px]";

  return (
    <>
      <div
        className="fixed inset-0 bg-black/35 backdrop-blur-[2px] z-50"
        onClick={() => dismissible && onClose()}
      />
      <div
        className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-paper border border-rule-strong rounded-xl shadow-[0_20px_60px_rgba(15,15,15,0.22),0_4px_12px_rgba(15,15,15,0.08)] z-[60] ${width} max-w-[92vw] max-h-[90vh] overflow-y-auto animate-appear`}
      >
        {children}
      </div>
    </>
  );
}
