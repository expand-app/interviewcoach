"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { BrandMark } from "@/components/ui";
import { isAdminUser } from "@/lib/auth-client";

interface Props {
  onRenameRequest: (id: string, currentTitle: string) => void;
  onDeleteRequest: (id: string, title: string) => void;
}

export function Sidebar({ onRenameRequest, onDeleteRequest }: Props) {
  const t = useTranslations();
  const router = useRouter();
  // Phase 2: the sidebar reads the lightweight pastSessionList that
  // hydratePastSessions() populates from /api/sessions. The full
  // Session[] in pastSessions only contains entries the user has
  // already opened (lazy-loaded via loadPastSession) plus any session
  // ended in this tab. Falling back to pastSessions when the list is
  // empty keeps the local-dev-without-DB path working.
  const pastSessionList = useStore((s) => s.pastSessionList);
  const pastSessions = useStore((s) => s.pastSessions);
  const sidebarSessions =
    pastSessionList.length > 0
      ? pastSessionList
      : pastSessions.map((s) => ({
          id: s.id,
          title: s.title,
          startedAt: s.startedAt,
          durationSeconds: s.durationSeconds,
          hasScore: Boolean(s.score),
          scoreError: s.scoreError,
        }));
  const selectedPastId = useStore((s) => s.selectedPastId);
  const selectPast = useStore((s) => s.selectPast);
  const user = useStore((s) => s.user);
  const signOut = useStore((s) => s.signOut);
  // Commentary language preference. "zh" = current bilingual mix
  // (Chinese with English keywords) — the historical default.
  // "en" = pure English. Drives Live Commentary, Listening Hint,
  // post-session Score wording.
  const commentLang = useStore((s) => s.commentLang);
  const setCommentLang = useStore((s) => s.setCommentLang);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  // Commentary-language flyout state. Hover opens the right-side
  // submenu; we keep it open with a small grace period so the user's
  // mouse can travel from the trigger row to the submenu without
  // closing it. Mobile / keyboard users get the same row as a click
  // toggle (the wrapper div listens for both).
  //
  // CRITICAL: the submenu has to escape the parent `<aside>`'s
  // overflow:hidden. Rendering it via createPortal into document.body
  // sidesteps the clipping; we compute its position with the trigger
  // row's getBoundingClientRect so it lands directly to the right of
  // the trigger regardless of layout.
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [langMenuPos, setLangMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const langTriggerRef = useRef<HTMLButtonElement | null>(null);
  const langCloseTimerRef = useRef<number | null>(null);
  const openLangMenu = () => {
    if (langCloseTimerRef.current !== null) {
      window.clearTimeout(langCloseTimerRef.current);
      langCloseTimerRef.current = null;
    }
    // Recompute position each open — sidebar can scroll between
    // opens and we need the up-to-date rect.
    if (langTriggerRef.current) {
      const r = langTriggerRef.current.getBoundingClientRect();
      setLangMenuPos({
        top: r.top - 4, // small upward nudge so the submenu's first
                        // option aligns with the trigger row visually
        left: r.right + 4,
      });
    }
    setLangMenuOpen(true);
  };
  const scheduleCloseLangMenu = () => {
    if (langCloseTimerRef.current !== null) {
      window.clearTimeout(langCloseTimerRef.current);
    }
    langCloseTimerRef.current = window.setTimeout(() => {
      setLangMenuOpen(false);
      langCloseTimerRef.current = null;
    }, 150);
  };

  // Close menu on outside click
  useEffect(() => {
    if (!menuFor) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [menuFor]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!userMenuRef.current?.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [userMenuOpen]);

  const initial = (user?.name?.trim()?.[0] ?? "?").toUpperCase();

  // Inline SVG chevron-down used by both the user dropdown and any
  // future caret affordances. Replaces the previous Unicode `▾`
  // (U+25BE) which was rendering as `;` in some font stacks (Inter
  // doesn't include the BLACK DOWN-POINTING SMALL TRIANGLE glyph
  // and certain CJK fallbacks substitute a semicolon). SVG removes
  // the font-fallback dependency entirely.
  const ChevronDown = (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="2 4 5 7 8 4" />
    </svg>
  );

  return (
    <>
      {/* Mobile-only backdrop. Shows behind the drawer when open;
          click closes the drawer. Hidden on sm+ where the sidebar
          is part of the grid layout (no overlay needed). */}
      {sidebarOpen && (
        <div
          className="sm:hidden fixed inset-0 bg-black/40 z-40"
          aria-hidden="true"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      {/* Outer aside is a fixed-height column with overflow HIDDEN —
          it does NOT scroll. Inside, the brand row + nav header are
          shrink-0 (always visible at top), the past-sessions list is
          flex-1 with its OWN overflow-y-auto (only the list scrolls),
          and the user-info row at the bottom is shrink-0 (always
          visible). Result: pinned-at-bottom user info regardless of
          how many past sessions exist — matches Claude/Linear/Notion.

          Mobile (<sm): aside becomes a fixed-position off-canvas
          drawer that slides in from the left when sidebarOpen is
          true. The page-level grid drops the 240px column on mobile
          (see app/page.tsx). The drawer's z-index sits above the
          backdrop (z-40) so the panel is interactive. */}
      <aside
        className={`bg-surface border-r border-border flex flex-col p-3 overflow-hidden
          fixed inset-y-0 left-0 w-72 z-50 transform transition-transform duration-200
          ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
          sm:relative sm:inset-auto sm:translate-x-0 sm:w-60 sm:z-auto`}
      >
      {/* Brand row — puebulo mark + wordmark at the top of the
          sidebar. shrink-0 so it never gets squeezed when the
          past-sessions list grows. Uses the HTML BrandMark
          (renders "p" / "b" via DOM spans against next/font's
          Inter, avoiding SVG-text font-fallback rendering bugs). */}
      <div className="flex items-center gap-2.5 px-2 py-2 mb-3 shrink-0">
        <BrandMark size={24} />
        <span className="text-[15px] font-semibold tracking-tight text-text">
          puebulo
        </span>
      </div>

      {/* ===== Navigation block ===== */}
      <div className="flex flex-col gap-0.5 shrink-0">
        {/* Live Session nav. Selected state uses surface-2 bg + bold
            label so the user can tell at a glance which view they're
            in. Same treatment used by past-session rows below for
            visual consistency. */}
        <button
          onClick={() => {
            selectPast(null);
            setSidebarOpen(false);
          }}
          className={`flex items-center px-2.5 py-1.5 rounded-md text-[13px] text-left transition-colors ${
            selectedPastId === null
              ? "bg-surface-2 text-text font-semibold"
              : "text-text-muted hover:bg-surface-2 hover:text-text"
          }`}
        >
          <span>{t("Live Session", "实时会话")}</span>
        </button>

        {/* Past Sessions section header */}
        <div className="eyebrow px-2.5 pt-5 pb-1.5">
          {t("Past Sessions", "历史会话")}
        </div>
      </div>

      {/* Scrollable past-sessions list. flex-1 takes all the
          remaining vertical space between the nav header above and
          the user-info row below; min-h-0 is the flex-child trick
          that lets overflow-y-auto actually engage on a flex-1
          child (without it the child grows past its parent and
          never scrolls). */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5">
        {sidebarSessions.length === 0 ? (
          // Distinguish "still authenticating + waking Aurora" from
          // "user genuinely has no sessions". Without this check,
          // users returning after a few minutes saw "No past sessions
          // yet" for 15-30s while /api/users/upsert + Aurora cold
          // start were in flight — looked like their data had
          // disappeared. Once user.userId is present AND
          // hydratePastSessions has had a chance to land, the empty
          // state becomes meaningful.
          !user?.userId ? (
            <div className="text-[12px] text-text-subtle italic px-2.5 py-1 inline-flex items-center gap-1.5">
              <span className="inline-flex gap-[2px]">
                <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot" />
                <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.15s]" />
                <span className="w-[3px] h-[3px] rounded-full bg-text-subtle animate-bounce-dot [animation-delay:.3s]" />
              </span>
              <span>{t("Loading sessions…", "加载历史会话…")}</span>
            </div>
          ) : (
            <div className="text-[12px] text-text-subtle italic px-2.5 py-1">
              {t("No past sessions yet", "还没有历史会话")}
            </div>
          )
        ) : (
          sidebarSessions.map((s) => (
            <div
              key={s.id}
              onClick={() => {
                selectPast(s.id);
                // Close mobile drawer after picking — desktop ignores
                // (no-op if drawer wasn't open).
                setSidebarOpen(false);
              }}
              // select-none kills the text-caret blink that Chrome was
              // dropping into the truncated session title on click.
              // The row is a navigation control, not editable text;
              // there's no scenario where the user wants to text-select
              // the title from inside the sidebar (and `title` attr
              // already gives them the full string on hover).
              className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[13px] cursor-pointer transition-colors select-none ${
                selectedPastId === s.id
                  ? "bg-surface-2 text-text font-semibold"
                  : "text-text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              <span className="truncate flex-1 leading-snug" title={s.title}>
                {s.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenuPos({ x: rect.right + 4, y: rect.top });
                  setMenuFor(s.id);
                }}
                className={`w-6 h-6 grid place-items-center rounded text-text-subtle hover:bg-bg hover:text-text shrink-0 transition-opacity ${
                  selectedPastId === s.id || menuFor === s.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                aria-label="More options"
              >
                {/* SVG horizontal-ellipsis (three dots) replaces the
                    Unicode `⋯` (U+22EF) which falls back inconsistently
                    across font stacks. */}
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                  <circle cx="3" cy="7" r="1.2" />
                  <circle cx="7" cy="7" r="1.2" />
                  <circle cx="11" cy="7" r="1.2" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>

      {/* ===== User identity row at the bottom =====
          shrink-0 so it stays visible no matter how long the
          past-sessions list grows. The dropdown opens UPWARD so
          it doesn't get clipped by the sidebar's bottom edge. */}
      <div className="shrink-0 pt-2">
        <div className="h-px bg-border mx-2 mb-2" />
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[13px] font-medium text-text rounded-md hover:bg-surface-2 text-left"
          >
            <div
              className="w-5 h-5 rounded grid place-items-center text-[10.5px] font-semibold shrink-0"
              style={{ background: "var(--color-text)", color: "var(--color-bg)" }}
            >
              {initial}
            </div>
            <div className="flex flex-col leading-tight overflow-hidden min-w-0">
              <span className="truncate">{user?.name ?? "puebulo"}</span>
              <span className="text-[11px] text-text-subtle font-normal mt-0.5 truncate">
                {user?.email ?? "Guest"}
              </span>
            </div>
            <span className="ml-auto text-text-subtle shrink-0">
              {ChevronDown}
            </span>
          </button>

          {/* Dropdown opens UPWARD (bottom-full) since this row is at
              the bottom of the sidebar — opening downward would push
              the menu off-screen. */}
          {userMenuOpen && (
            <div
              className="absolute left-0 right-0 bottom-full mb-1 bg-bg border border-border-strong rounded-md p-1 z-[70]"
              style={{ boxShadow: "var(--shadow-lg)" }}
            >
              {/* Commentary Language — single row with right chevron
                  that reveals a hover-flyout submenu (Claude /
                  macOS Settings / system-language-picker idiom).
                  Single row keeps the main menu compact; the
                  submenu hides options the user usually doesn't
                  need to touch. The wrapper div listens for hover
                  enter/leave on BOTH the trigger row AND the
                  flyout — that way the user's mouse can travel
                  across the small gap between them without the
                  submenu snapping shut. Tap on the row also
                  toggles, for keyboard / mobile / tablet users
                  who don't hover. */}
              <div
                onMouseEnter={openLangMenu}
                onMouseLeave={scheduleCloseLangMenu}
              >
                <button
                  type="button"
                  ref={langTriggerRef}
                  onClick={() =>
                    langMenuOpen ? setLangMenuOpen(false) : openLangMenu()
                  }
                  aria-haspopup="listbox"
                  aria-expanded={langMenuOpen}
                  className="w-full flex items-center justify-between gap-2.5 px-2.5 py-1.5 rounded text-sm hover:bg-surface text-left"
                >
                  <span>Commentary Language</span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="text-text-muted"
                  >
                    <polyline points="4 2 8 6 4 10" />
                  </svg>
                </button>
              </div>
              <div className="h-px bg-border my-1 mx-1" />

              {/* Admin-only entries: Analytics + Invitation codes.
                  Sit ABOVE Sign out so the destructive action stays
                  at the bottom of the menu. Non-admin users never see
                  these; for them the dropdown contains only Sign out
                  exactly as before. Analytics is listed first because
                  it's the more frequent destination — debug a session
                  / look at usage. Invitation codes is administrative
                  housekeeping and used less often. */}
              {isAdminUser(user) && (
                <>
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      router.push("/admin/analytics");
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm hover:bg-surface text-left"
                  >
                    <span>Admin Portal</span>
                  </button>
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      router.push("/admin/invitations");
                    }}
                    className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm hover:bg-surface text-left"
                  >
                    <span>Generate Invitation Code</span>
                  </button>
                  <div className="h-px bg-border my-1 mx-1" />
                </>
              )}
              <button
                onClick={() => {
                  // Sign out clears the user slice; we then route to
                  // the marketing landing rather than letting the
                  // /app auth-gate effect bounce to /sign-in. Going
                  // to / matches the user's mental model: signing
                  // out should land you "back at the website", not
                  // immediately on a re-login form.
                  setUserMenuOpen(false);
                  selectPast(null);
                  signOut();
                  router.push("/");
                }}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm hover:bg-surface text-left"
              >
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Context menu — small dropdown for Rename / Delete actions
          on past-session rows. Inline emoji removed per the design
          rule (no emoji in UI copy); the action label alone is
          enough since context is the row it's anchored to. */}
      {menuFor && (
        <div
          ref={menuRef}
          className="fixed bg-bg border border-border-strong rounded-md min-w-[180px] p-1 z-[70]"
          style={{ left: menuPos.x, top: menuPos.y, boxShadow: "var(--shadow-lg)" }}
        >
          <button
            onClick={() => {
              const s = pastSessions.find((x) => x.id === menuFor);
              if (s) onRenameRequest(s.id, s.title);
              setMenuFor(null);
            }}
            className="w-full px-2.5 py-1.5 rounded text-sm hover:bg-surface text-left"
          >
            {t("Rename", "重命名")}
          </button>
          <div className="h-px bg-border my-1" />
          <button
            onClick={() => {
              const s = pastSessions.find((x) => x.id === menuFor);
              if (s) onDeleteRequest(s.id, s.title);
              setMenuFor(null);
            }}
            className="w-full px-2.5 py-1.5 rounded text-sm hover:bg-surface text-left"
            style={{ color: "var(--color-error)" }}
          >
            {t("Delete", "删除")}
          </button>
        </div>
      )}

      {/* Commentary-language flyout. Rendered via React Portal into
          document.body so it escapes the parent <aside>'s
          overflow:hidden — without this, the submenu visibly clipped
          the moment it tried to extend past the sidebar's right
          edge. Position is computed in JS from the trigger button's
          getBoundingClientRect, refreshed every time the menu opens.
          We listen for hover enter/leave on the flyout itself with
          the same handlers as the trigger so mouse can travel
          between the two without a flicker close. */}
    </aside>
    {langMenuOpen && langMenuPos && typeof document !== "undefined"
        ? createPortal(
            <div
              role="listbox"
              aria-label="Commentary language"
              className="bg-bg border border-border-strong rounded-md p-1"
              style={{
                position: "fixed",
                top: langMenuPos.top,
                left: langMenuPos.left,
                minWidth: 160,
                boxShadow: "var(--shadow-lg)",
                zIndex: 100,
              }}
              onMouseEnter={openLangMenu}
              onMouseLeave={scheduleCloseLangMenu}
            >
              {(
                [
                  { code: "en" as const, label: "English" },
                  { code: "zh" as const, label: "Chinese" },
                ]
              ).map(({ code, label }) => {
                const active = commentLang === code;
                return (
                  <button
                    key={code}
                    type="button"
                    onClick={() => {
                      setCommentLang(code);
                      setLangMenuOpen(false);
                    }}
                    role="option"
                    aria-selected={active}
                    className="w-full flex items-center justify-between text-left text-[13px] hover:bg-surface transition-colors"
                    style={{
                      padding: "6px 10px",
                      borderRadius: "var(--radius-sm)",
                      color: "var(--color-text)",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    <span>{label}</span>
                    {active && (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        style={{ color: "var(--color-text)" }}
                      >
                        <polyline points="3 8.5 6.5 12 13 4.5" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
