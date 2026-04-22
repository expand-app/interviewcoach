"use client";

import { ModalShell } from "./ModalShell";

interface Props {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  /** "primary" = blue button, "danger" = red destructive. */
  tone?: "primary" | "danger";
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
  onCancel,
  onConfirm,
}: Props) {
  const confirmClass =
    tone === "danger"
      ? "bg-[#c73434] hover:bg-[#a82828] border-[#c73434]"
      : "bg-accent hover:bg-[#1a73d1] border-accent";

  return (
    <ModalShell open={open} onClose={onCancel}>
      <div className="p-7 px-8">
        <h2 className="text-[18px] font-semibold mb-1.5 text-ink">{title}</h2>
        <div className="text-sm text-ink-light mb-4 leading-relaxed">{description}</div>
        <div className="flex gap-2 justify-end mt-4">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-sm font-medium border border-rule-strong bg-paper text-ink hover:bg-paper-hover"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 rounded-md text-sm font-medium text-white border ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
