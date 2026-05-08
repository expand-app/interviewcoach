"use client";

import { useState, useEffect, useRef } from "react";
import { ModalShell } from "./ModalShell";
import { Button, Input } from "@/components/ui";

interface Props {
  open: boolean;
  initialTitle: string;
  /** Save the session under the given title — full End & Save flow:
   *  stop capture, persist transcript + recordings, fire scoring. */
  onSave: (title: string) => void;
  /** End the session WITHOUT saving — release mic, drop the
   *  in-progress transcript / recording. User picks this when the
   *  session was a misstart, mic-check, or otherwise not worth keeping. */
  onDiscard: () => void;
  /** User backed out of ending — close the modal, keep the live
   *  session running as-is. Bound to the X close button (top-right)
   *  AND to backdrop / Escape via ModalShell. */
  onCancel: () => void;
}

/**
 * Three-action end-session prompt. Replaces the previous two-button
 * "End & Save / Cancel" PromptModal use because the prior flow had
 * no way to end WITHOUT saving — the only options were "save it" or
 * "keep recording", and a misstarted live session would clutter the
 * past list forever.
 *
 * Action map:
 *   X (top-right)  → onCancel: keep the live session running
 *   Discard        → onDiscard: stop the live session, do NOT save
 *   Save           → onSave(title): full End & Save flow
 *
 * The X button is intentionally distinct from the Discard button so
 * users can't conflate "I changed my mind, keep going" with "stop it
 * and throw away the data".
 */
export function EndSessionModal({
  open,
  initialTitle,
  onSave,
  onDiscard,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(initialTitle);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, initialTitle]);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onSave(trimmed);
  };

  return (
    <ModalShell open={open} onClose={onCancel}>
      <div className="relative p-7 px-8">
        {/* X close — explicitly cancels the End action and keeps the
            live session running. */}
        <button
          onClick={onCancel}
          aria-label="Close"
          className="absolute top-3 right-3 w-7 h-7 inline-flex items-center justify-center rounded-md text-text-subtle hover:text-text hover:bg-surface transition-colors"
        >
          <span className="text-[16px] leading-none">×</span>
        </button>

        <h2 className="text-[18px] font-semibold mb-1.5 text-text">
          End this session?
        </h2>
        <div className="text-sm text-text-muted mb-4 leading-relaxed">
          This stops recording. You can save it to Past Sessions or
          discard it if it was a misstart. Click × (top-right) to keep
          the live session running.
        </div>

        <label className="field-label">Session name</label>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Session name"
        />

        {/* Two-action footer: Discard (left, ghost button with error
            tint on hover) / Save (right, primary). */}
        <div className="flex gap-2 justify-end mt-5 items-center">
          <Button
            variant="ghost"
            onClick={onDiscard}
            className="mr-auto"
            style={{ color: "var(--color-text-muted)" }}
          >
            Discard (don&apos;t save)
          </Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            Save
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
