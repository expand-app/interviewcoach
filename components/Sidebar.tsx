"use client";

import { useState, useRef, useEffect } from "react";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";

interface Props {
  onRenameRequest: (id: string, currentTitle: string) => void;
  onDeleteRequest: (id: string, title: string) => void;
}

export function Sidebar({ onRenameRequest, onDeleteRequest }: Props) {
  const t = useTranslations();
  const pastSessions = useStore((s) => s.pastSessions);
  const selectedPastId = useStore((s) => s.selectedPastId);
  const selectPast = useStore((s) => s.selectPast);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuFor) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [menuFor]);

  return (
    <aside className="w-60 bg-paper-subtle border-r border-rule flex flex-col gap-0.5 p-2.5 overflow-y-auto">
      {/* Workspace header */}
      <div className="flex items-center gap-2 px-2 py-1.5 mb-2.5 text-sm font-semibold text-ink rounded cursor-pointer hover:bg-paper-hover">
        <div className="w-[22px] h-[22px] bg-ink text-paper rounded grid place-items-center font-serif italic font-bold text-xs">
          C
        </div>
        <div className="flex flex-col leading-tight overflow-hidden">
          <span className="truncate">Interview Coach</span>
          <span className="text-[11px] text-ink-lighter font-normal mt-0.5">Guest</span>
        </div>
        <span className="ml-auto text-ink-lighter text-[11px]">⌄</span>
      </div>

      {/* Live Session nav */}
      <button
        onClick={() => selectPast(null)}
        className={`flex items-center gap-2 px-2 py-1 rounded text-sm text-left ${
          selectedPastId === null
            ? "bg-paper-hover text-ink font-medium"
            : "text-ink-light hover:bg-paper-hover"
        }`}
      >
        <span className="text-[15px] w-[18px] text-center">🎙️</span>
        <span>{t("Live Session", "实时会话")}</span>
      </button>

      {/* Past Sessions section */}
      <div className="text-[11px] font-medium text-ink-lighter uppercase tracking-wider px-2 pt-3.5 pb-1">
        {t("Past Sessions", "历史会话")}
      </div>

      <div>
        {pastSessions.length === 0 ? (
          <div className="text-xs text-ink-lighter italic pl-7 py-1">
            {t("No past sessions yet", "还没有历史会话")}
          </div>
        ) : (
          pastSessions.map((s) => (
            <div
              key={s.id}
              onClick={() => selectPast(s.id)}
              className={`group flex items-center gap-2 pl-6 pr-2 py-1 rounded text-[13px] cursor-pointer ${
                selectedPastId === s.id
                  ? "bg-paper-hover text-ink font-medium"
                  : "text-ink-light hover:bg-paper-hover"
              }`}
            >
              <span className="w-1 h-1 rounded-full bg-ink-lighter shrink-0" />
              <span className="truncate flex-1" title={s.jd.slice(0, 200)}>
                {s.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setMenuPos({ x: rect.right + 4, y: rect.top });
                  setMenuFor(s.id);
                }}
                className={`w-[22px] h-[22px] grid place-items-center rounded text-ink-light text-sm hover:bg-black/10 shrink-0 transition-opacity ${
                  selectedPastId === s.id || menuFor === s.id ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                aria-label="More options"
              >
                ⋯
              </button>
            </div>
          ))
        )}
      </div>

      {/* Context menu */}
      {menuFor && (
        <div
          ref={menuRef}
          className="fixed bg-paper border border-rule-strong rounded-md shadow-lg min-w-[180px] p-1 z-[70]"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button
            onClick={() => {
              const s = pastSessions.find((x) => x.id === menuFor);
              if (s) onRenameRequest(s.id, s.title);
              setMenuFor(null);
            }}
            className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm hover:bg-paper-hover text-left"
          >
            <span className="w-3.5 inline-flex justify-center text-ink-lighter text-[13px]">✏️</span>
            <span>{t("Rename", "重命名")}</span>
          </button>
          <div className="h-px bg-rule my-1" />
          <button
            onClick={() => {
              const s = pastSessions.find((x) => x.id === menuFor);
              if (s) onDeleteRequest(s.id, s.title);
              setMenuFor(null);
            }}
            className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded text-sm hover:bg-paper-hover text-left text-red-text"
          >
            <span className="w-3.5 inline-flex justify-center text-[13px]">🗑</span>
            <span>{t("Delete", "删除")}</span>
          </button>
        </div>
      )}
    </aside>
  );
}
