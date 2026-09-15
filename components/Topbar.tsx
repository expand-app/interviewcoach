"use client";

import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { Dock } from "./Dock";

interface Props {
  onStart: () => void;
  onPause: () => void;
  onEnd: () => void;
  /** Live-mode layout controls. Rendered as real flex items on the
   *  LEFT (right after the breadcrumb) — and ONLY when these handlers
   *  are supplied, i.e. on the live session view, never the Past view.
   *
   *  Why here, as flex siblings, and not a fixed/portaled overlay:
   *  the old design portaled these to <body> at `fixed top-2 z-50`
   *  (to beat the ready-bar popup's stacking context). That overlay
   *  sat on top of the Dock's End / Pause buttons during recording and
   *  swallowed their clicks — the operator couldn't End & Save. As
   *  ordinary flex children they occupy their own reserved space in the
   *  bar, so they can NEVER overlap the Dock at any width or zoom, and
   *  they sit in the top bar row (above the popup, which is centered
   *  below the bar) so no z-index games are needed. They're outside the
   *  `#ic-capture-region` crop target, so rendering them never changes
   *  the recording bbox → no 花屏. */
  phoneMode?: boolean;
  onTogglePhoneMode?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function Topbar({
  onStart,
  onPause,
  onEnd,
  phoneMode = false,
  onTogglePhoneMode,
  isFullscreen = false,
  onToggleFullscreen,
}: Props) {
  const t = useTranslations();
  const selectedPastId = useStore((s) => s.selectedPastId);
  const pastSessions = useStore((s) => s.pastSessions);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const status = useStore((s) => s.live.status);

  const current = selectedPastId
    ? pastSessions.find((s) => s.id === selectedPastId)
    : null;
  const crumb = current ? current.title : "Live Session";

  // Both layout toggles are LOCKED once recording is live (recording /
  // paused). Toggling either mid-recording moves / resizes the Region
  // Capture crop target → 花屏 in the saved video. The user picks the
  // layout BEFORE clicking Begin, then it's committed for the duration.
  const controlsLocked = status === "recording" || status === "paused";
  const showLayoutControls =
    Boolean(onTogglePhoneMode) || Boolean(onToggleFullscreen);

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

      {/* Live-mode layout controls — left cluster, next to breadcrumb. */}
      {showLayoutControls && (
        <>
          <span
            aria-hidden="true"
            className="hidden sm:block w-px h-4 bg-border shrink-0"
          />
          <div className="flex items-center gap-1 shrink-0">
            {/* "Live 演示" — narrow-tall (iPhone-ish) vs default
                wide-flat (iPad-ish) box layout. */}
            {onTogglePhoneMode && (
              <button
                type="button"
                onClick={controlsLocked ? undefined : onTogglePhoneMode}
                disabled={controlsLocked}
                aria-pressed={phoneMode}
                title={
                  controlsLocked
                    ? t(
                        "Layout is locked during recording — set this before you click Begin.",
                        "录制期间无法切换布局 —— 请在点击 Begin 之前设置好。"
                      )
                    : phoneMode
                      ? t("Switch to wide layout", "切换回宽屏布局")
                      : t("Switch to Live-demo layout", "切换到 Live 演示布局")
                }
                className="btn btn-ghost btn-sm"
              >
                {/* Phone / tablet frame icon. Portrait rounded rect
                    when we'd switch INTO phone mode; wider rect when
                    we'd switch back to the default layout. */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {phoneMode ? (
                    <rect x="1.5" y="3.5" width="11" height="7" rx="1.2" />
                  ) : (
                    <>
                      <rect x="3.5" y="1.5" width="7" height="11" rx="1.5" />
                      <line x1="6" y1="10.7" x2="8" y2="10.7" />
                    </>
                  )}
                </svg>
                <span className="hidden sm:inline">
                  {phoneMode ? t("Wide", "宽屏") : t("Live demo", "Live 演示")}
                </span>
              </button>
            )}
            {/* Fullscreen toggle. In fullscreen the whole Topbar
                auto-hides, so this button hides with it — Esc exits,
                and hovering the top edge reveals the bar again. */}
            {onToggleFullscreen && (
              <button
                type="button"
                onClick={controlsLocked ? undefined : onToggleFullscreen}
                disabled={controlsLocked}
                title={
                  controlsLocked
                    ? t(
                        "Fullscreen is locked during recording — set this before you click Begin.",
                        "录制期间无法切换全屏 —— 请在点击 Begin 之前设置好。"
                      )
                    : isFullscreen
                      ? t("Exit fullscreen (Esc)", "退出全屏 (Esc)")
                      : t("Fullscreen", "全屏")
                }
                className="btn btn-ghost btn-sm"
              >
                {/* Fullscreen toggle icon — SVG instead of Unicode
                    `⤡` / `⤢` since those glyphs fall back
                    inconsistently on some font stacks. Two arrows
                    pointing into / out of the corners of a square. */}
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {isFullscreen ? (
                    <path d="M6 2v3H3M2 6h3V3M8 12V9h3M12 8H9v3" />
                  ) : (
                    <path d="M3 6V3h3M11 3h-3v3M3 8v3h3M11 8v3H8" />
                  )}
                </svg>
                <span className="hidden sm:inline">
                  {isFullscreen ? t("Exit", "退出全屏") : t("Fullscreen", "全屏")}
                </span>
              </button>
            )}
          </div>
        </>
      )}

      <div className="ml-auto">
        <Dock onStart={onStart} onPause={onPause} onEnd={onEnd} />
      </div>
    </div>
  );
}
