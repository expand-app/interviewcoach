"use client";

import { useState, useEffect } from "react";
import { ModalShell } from "./ModalShell";

export type StartMode = "live" | "upload";

interface Props {
  open: boolean;
  onCancel: () => void;
  /** jd, resume: always present. file: present iff mode === "upload".
   *  Earphone / tab-audio handling is automatic in live mode — no flag here. */
  onStart: (args: {
    mode: StartMode;
    jd: string;
    resume: string;
    file?: File;
  }) => void;
}

export function StartModal({ open, onCancel, onStart }: Props) {
  const [mode, setMode] = useState<StartMode>("live");
  const [jd, setJd] = useState("");
  const [resume, setResume] = useState("");
  const [file, setFile] = useState<File | null>(null);

  useEffect(() => {
    if (open) {
      setMode("live");
      setJd("");
      setResume("");
      setFile(null);
    }
  }, [open]);

  const canSubmit =
    jd.trim().length > 0 && (mode === "live" || file !== null);

  return (
    <ModalShell open={open} onClose={onCancel} variant="wide">
      <div className="p-7 px-8">
        <h2 className="text-[22px] font-bold tracking-tight mb-1 text-ink">
          Start a new session
        </h2>
        <p className="text-[13.5px] text-ink-light mb-5 leading-relaxed">
          Paste the job description below. Adding the candidate&apos;s resume
          helps AI judge how well answers fit the person&apos;s background.
        </p>

        {/* Mode toggle: live mic vs upload recording */}
        <div className="mb-5 inline-flex bg-paper-hover p-0.5 rounded-md">
          <button
            onClick={() => setMode("live")}
            className={`px-3 py-1.5 text-[12.5px] font-medium rounded transition-all ${
              mode === "live"
                ? "bg-paper text-ink shadow-sm"
                : "text-ink-light"
            }`}
          >
            Live microphone
          </button>
          <button
            onClick={() => setMode("upload")}
            className={`px-3 py-1.5 text-[12.5px] font-medium rounded transition-all ${
              mode === "upload"
                ? "bg-paper text-ink shadow-sm"
                : "text-ink-light"
            }`}
          >
            Upload recording
          </button>
        </div>

        {/* Upload field (visible only in upload mode) */}
        {mode === "upload" && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[13px] font-semibold text-ink">
                Interview recording
              </label>
              <span className="text-[11px] font-medium tracking-wider uppercase py-0.5 px-1.5 rounded bg-accent-bg text-accent">
                Required
              </span>
            </div>
            <input
              type="file"
              accept="audio/*,video/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-ink file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-rule-strong file:bg-paper file:text-ink file:text-sm file:font-medium file:cursor-pointer hover:file:bg-paper-hover"
            />
            <div className="text-xs text-ink-lighter mt-1">
              Audio (mp3/wav/m4a/webm) or video file. Playback drives live
              commentary as the recording plays.
            </div>
          </div>
        )}

        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[13px] font-semibold text-ink">
              Job Description
            </label>
            <span className="text-[11px] font-medium tracking-wider uppercase py-0.5 px-1.5 rounded bg-accent-bg text-accent">
              Required
            </span>
          </div>
          <textarea
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the full JD here — role, responsibilities, required skills, company context, etc."
            className="w-full px-3 py-2 border border-rule-strong rounded-md text-sm text-ink bg-paper outline-none focus:border-accent focus:ring focus:ring-accent/20 focus:ring-offset-0 resize-y min-h-[140px] leading-relaxed"
          />
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-[13px] font-semibold text-ink">
              Candidate Resume
            </label>
            <span className="text-[11px] font-medium tracking-wider uppercase py-0.5 px-1.5 rounded bg-paper-hover text-ink-lighter">
              Optional
            </span>
          </div>
          <textarea
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            placeholder="Paste the candidate's resume — past roles, projects, education, etc. This helps AI calibrate answers against their actual experience."
            className="w-full px-3 py-2 border border-rule-strong rounded-md text-sm text-ink bg-paper outline-none focus:border-accent focus:ring focus:ring-accent/20 focus:ring-offset-0 resize-y min-h-[110px] leading-relaxed"
          />
          <div className="text-xs text-ink-lighter mt-1">
            AI won&apos;t just check what they say — it will cross-check
            against what they&apos;ve actually done.
          </div>
        </div>

        <div className="flex gap-2 justify-end mt-5">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md text-sm font-medium border border-rule-strong bg-paper text-ink hover:bg-paper-hover"
          >
            Cancel
          </button>
          <button
            onClick={() =>
              canSubmit &&
              onStart({
                mode,
                jd: jd.trim(),
                resume: resume.trim(),
                file: mode === "upload" && file ? file : undefined,
              })
            }
            disabled={!canSubmit}
            className="px-4 py-2 rounded-md text-sm font-medium bg-accent text-white border border-accent hover:bg-[#1a73d1] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {mode === "upload" ? "Start playback →" : "Start listening →"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
