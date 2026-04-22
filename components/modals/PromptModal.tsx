"use client";

import { useState, useEffect, useRef } from "react";
import { ModalShell } from "./ModalShell";

interface Props {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  cancelLabel: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export function PromptModal({
  open,
  title,
  description,
  placeholder,
  initialValue = "",
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset when opened; focus and select the input so user can just type to replace.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, initialValue]);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return (
    <ModalShell open={open} onClose={onCancel}>
      <div className="p-7 px-8">
        <h2 className="text-[18px] font-semibold mb-1.5 text-ink">{title}</h2>
        {description && (
          <div className="text-sm text-ink-light mb-4 leading-relaxed">{description}</div>
        )}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={placeholder}
          className="w-full px-3 py-2 border border-rule-strong rounded-md text-sm text-ink bg-paper outline-none focus:border-accent focus:ring focus:ring-accent/20"
        />
        <div className="flex gap-2 justify-end mt-5">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-sm font-medium border border-rule-strong bg-paper text-ink hover:bg-paper-hover"
          >
            {cancelLabel}
          </button>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="px-4 py-2 rounded-md text-sm font-medium bg-accent hover:bg-[#1a73d1] border border-accent text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
