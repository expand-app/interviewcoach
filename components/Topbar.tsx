"use client";

import { useStore } from "@/lib/store";

export function Topbar() {
  const selectedPastId = useStore((s) => s.selectedPastId);
  const pastSessions = useStore((s) => s.pastSessions);
  const commentLang = useStore((s) => s.commentLang);
  const setCommentLang = useStore((s) => s.setCommentLang);

  const current = selectedPastId
    ? pastSessions.find((s) => s.id === selectedPastId)
    : null;
  const crumb = current
    ? `📚 ${current.title}`
    : "🎙️ Live Session";

  return (
    <div className="h-11 border-b border-rule flex items-center px-5 gap-2.5 shrink-0">
      <div className="flex items-center gap-1.5 text-[13px] text-ink-light">
        <span>Interview Coach</span>
        <span className="text-ink-lighter">/</span>
        <b className="text-ink font-medium">{crumb}</b>
      </div>
      <div className="ml-auto flex items-center gap-0.5">
        <div className="inline-flex bg-paper-hover rounded-md p-0.5" title="Commentary language">
          <button
            onClick={() => setCommentLang("en")}
            className={`px-2.5 py-[3px] text-xs font-medium rounded transition-all ${
              commentLang === "en"
                ? "bg-paper text-ink shadow-sm"
                : "text-ink-light"
            }`}
          >
            EN
          </button>
          <button
            onClick={() => setCommentLang("zh")}
            className={`px-2.5 py-[3px] text-xs font-medium rounded transition-all ${
              commentLang === "zh"
                ? "bg-paper text-ink shadow-sm"
                : "text-ink-light"
            }`}
          >
            中
          </button>
        </div>
      </div>
    </div>
  );
}
