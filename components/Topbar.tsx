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
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);

  const current = selectedPastId
    ? pastSessions.find((s) => s.id === selectedPastId)
    : null;
  const crumb = current ? current.title : "Live Session";

  return (
    <div className="h-11 border-b border-border flex items-center px-3 sm:px-5 gap-2.5 shrink-0">
      {/* Mobile-only hamburger that toggles the sidebar drawer.
          Desktop hides it because the sidebar is always visible
          inside the page grid — the button would just be noise. */}
      <button
        type="button"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle sidebar"
        aria-expanded={sidebarOpen}
        className="sm:hidden -ml-1 w-8 h-8 grid place-items-center rounded-md text-text-muted hover:bg-surface hover:text-text transition-colors"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="3" y1="5" x2="15" y2="5" />
          <line x1="3" y1="9" x2="15" y2="9" />
          <line x1="3" y1="13" x2="15" y2="13" />
        </svg>
      </button>
      <div className="flex items-center gap-1.5 text-[13px] text-text-muted min-w-0">
        <span className="hidden sm:inline">puebulo</span>
        <span className="hidden sm:inline text-text-subtle">/</span>
        <b className="text-text font-medium truncate">{crumb}</b>
      </div>
      <div className="ml-auto">
        <Dock onStart={onStart} onPause={onPause} onEnd={onEnd} />
      </div>
    </div>
  );
}
