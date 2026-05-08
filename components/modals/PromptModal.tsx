"use client";

import { useState, useEffect, useRef } from "react";
import { ModalShell } from "./ModalShell";
import { Button, Input } from "@/components/ui";

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
        <h2 className="text-[18px] font-semibold mb-1.5 text-text">{title}</h2>
        {description && (
          <div className="text-sm text-text-muted mb-4 leading-relaxed">{description}</div>
        )}
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={placeholder}
        />
        <div className="flex gap-2 justify-end mt-5">
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
