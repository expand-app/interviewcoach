"use client";

import { useState, useEffect, useRef } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { LiveView } from "@/components/LiveView";
import { PastView } from "@/components/PastView";
import { Dock } from "@/components/Dock";
import { StartModal } from "@/components/modals/StartModal";
import { ConfirmModal } from "@/components/modals/ConfirmModal";
import { PromptModal } from "@/components/modals/PromptModal";
import { useStore } from "@/lib/store";
import { useTranslations } from "@/lib/i18n";
import { getOrchestrator } from "@/lib/orchestrator";

export default function Page() {
  const t = useTranslations();

  // Global store
  const selectedPastId = useStore((s) => s.selectedPastId);
  const startLive = useStore((s) => s.startLive);
  const liveStatus = useStore((s) => s.live.status);
  const endLive = useStore((s) => s.endLive);
  const renamePast = useStore((s) => s.renamePastSession);
  const deletePast = useStore((s) => s.deletePastSession);
  const setElapsed = useStore((s) => s.setElapsed);
  const setLiveStatus = useStore((s) => s.setLiveStatus);

  // Modal state
  const [showStart, setShowStart] = useState(false);
  const [showPause, setShowPause] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

  // Toast state (simple non-intrusive error notifications)
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent).detail as string;
      setToast(msg);
      setTimeout(() => setToast(null), 3500);
    };
    window.addEventListener("ic:error", handler);
    return () => window.removeEventListener("ic:error", handler);
  }, []);

  // Tick the elapsed timer every second while recording.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (liveStatus !== "recording") {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    const startedAt = Date.now() - useStore.getState().live.elapsedSeconds * 1000;
    intervalRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [liveStatus, setElapsed]);

  // === Handlers ===

  const handleStart = () => {
    if (liveStatus === "paused") {
      // Resume — no modal, just flip status and resume audio.
      getOrchestrator().resume();
      return;
    }
    // Fresh start — show the JD/Resume modal
    setShowStart(true);
  };

  const handleStartConfirm = async (jd: string, resume: string) => {
    setShowStart(false);
    startLive(jd, resume);
    try {
      await getOrchestrator().start();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to start";
      setToast(msg);
      setLiveStatus("idle");
    }
  };

  const handlePauseRequest = () => setShowPause(true);

  const handlePauseConfirm = () => {
    setShowPause(false);
    getOrchestrator().pause();
  };

  const handleEndRequest = () => setShowEnd(true);

  const handleEndConfirm = async (title: string) => {
    setShowEnd(false);
    await getOrchestrator().stop();
    // Pick up the recorded audio URL that the orchestrator stashed.
    const audioUrl = (window as unknown as { __ic_audioUrl?: string }).__ic_audioUrl;
    endLive(title, audioUrl);
    (window as unknown as { __ic_audioUrl?: string }).__ic_audioUrl = undefined;
  };

  return (
    <div className="grid grid-cols-[240px_1fr] h-screen max-[900px]:grid-cols-1">
      <Sidebar
        onRenameRequest={(id, title) => setRenameTarget({ id, title })}
        onDeleteRequest={(id, title) => setDeleteTarget({ id, title })}
      />

      <main className="flex flex-col overflow-hidden">
        <Topbar />
        {selectedPastId === null ? <LiveView /> : <PastView />}
      </main>

      <Dock
        onStart={handleStart}
        onPause={handlePauseRequest}
        onEnd={handleEndRequest}
      />

      {/* Modals */}
      <StartModal
        open={showStart}
        onCancel={() => setShowStart(false)}
        onStart={handleStartConfirm}
      />

      <ConfirmModal
        open={showPause}
        title={t("Pause listening?", "暂停录音?")}
        description={t(
          "The timer will stop and AI will stop generating commentary. You can resume anytime.",
          "计时会停止,AI 将停止生成评论。你可以随时继续。"
        )}
        confirmLabel={t("Pause", "暂停")}
        cancelLabel={t("Cancel", "取消")}
        onCancel={() => setShowPause(false)}
        onConfirm={handlePauseConfirm}
      />

      <PromptModal
        open={showEnd}
        title={t("End & save this session?", "结束并保存本场?")}
        description={t(
          "This will stop recording and save everything to Past Sessions. You can give this session a name for easier reference later.",
          "录音将停止,整场内容会保存到 Past Sessions。你可以给这次面试命名方便之后查找。"
        )}
        placeholder={t("Session name", "面试名称")}
        initialValue={t("Untitled session", "未命名面试")}
        confirmLabel={t("End & save", "结束并保存")}
        cancelLabel={t("Cancel", "取消")}
        onCancel={() => setShowEnd(false)}
        onConfirm={handleEndConfirm}
      />

      <PromptModal
        open={Boolean(renameTarget)}
        title={t("Rename session", "重命名")}
        description={t("Give this session a new name.", "为这场面试设置一个新名称。")}
        initialValue={renameTarget?.title || ""}
        confirmLabel={t("Rename", "重命名")}
        cancelLabel={t("Cancel", "取消")}
        onCancel={() => setRenameTarget(null)}
        onConfirm={(value) => {
          if (renameTarget) renamePast(renameTarget.id, value);
          setRenameTarget(null);
        }}
      />

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t("Delete this session?", "删除这场面试?")}
        description={
          <>
            {t(
              `This will permanently delete "`,
              `"`
            )}
            <b>{deleteTarget?.title}</b>
            {t(
              `" including its recording and commentary. This cannot be undone.`,
              `" 将被永久删除,包括录音和所有评论。此操作无法撤销。`
            )}
          </>
        }
        confirmLabel={t("Delete", "删除")}
        cancelLabel={t("Cancel", "取消")}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deletePast(deleteTarget.id);
          setDeleteTarget(null);
        }}
      />

      {/* Error toast */}
      {toast && (
        <div className="fixed bottom-20 left-1/2 -translate-x-1/2 bg-[#c73434] text-paper py-2.5 px-4 rounded-md text-[13.5px] z-[100] shadow-lg animate-appear">
          {toast}
        </div>
      )}
    </div>
  );
}
