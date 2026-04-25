"use client";

import { useStore } from "@/lib/store";
import { Dock } from "./Dock";

interface Props {
  onStart: () => void;
  onPause: () => void;
  onEnd: () => void;
}

export function Topbar({ onStart, onPause, onEnd }: Props) {
  const selectedPastId = useStore((s) => s.selectedPastId);
  const pastSessions = useStore((s) => s.pastSessions);

  const current = selectedPastId
    ? pastSessions.find((s) => s.id === selectedPastId)
    : null;
  const crumb = current ? current.title : "Live Session";

  return (
    <div className="h-11 border-b border-rule flex items-center px-5 gap-2.5 shrink-0">
      <div className="flex items-center gap-1.5 text-[13px] text-ink-light min-w-0">
        <span>Interview Coach</span>
        <span className="text-ink-lighter">/</span>
        <b className="text-ink font-medium truncate">{crumb}</b>
      </div>
      <div className="ml-auto">
        <Dock onStart={onStart} onPause={onPause} onEnd={onEnd} />
      </div>
    </div>
  );
}
