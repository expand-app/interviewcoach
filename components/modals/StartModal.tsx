"use client";

import { useState, useEffect } from "react";
import { ModalShell } from "./ModalShell";

export type StartMode = "live" | "upload";

interface Props {
  open: boolean;
  onCancel: () => void;
  /** jd, resume: always present. file: present iff mode === "upload".
   *  captureSystemAudio: only meaningful in live mode — when true, the
   *  AudioSession will prompt for tab/window share with audio so Zoom
   *  meetings, browser playback, etc. are picked up alongside the mic.
   *  captureVideo: only effective when captureSystemAudio is also true —
   *  if so, the same tab/window share retains its video track and a
   *  WebM screen recording is saved on the session for later playback +
   *  download from the Past Session view. */
  onStart: (args: {
    mode: StartMode;
    jd: string;
    resume: string;
    file?: File;
    captureSystemAudio?: boolean;
    captureVideo?: boolean;
  }) => void;
}

export function StartModal({ open, onCancel, onStart }: Props) {
  const [mode, setMode] = useState<StartMode>("live");
  const [jd, setJd] = useState("");
  const [resume, setResume] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // Default ON: most users running this run an interview through Zoom
  // / Meet on their laptop with headphones, where mic-only would miss
  // the interviewer entirely. Auto-detect headphones still kicks in
  // when this is off, so flipping off is a safe explicit override
  // (e.g. in-room interview with laptop speakers).
  const [captureSystemAudio, setCaptureSystemAudio] = useState(true);
  // Default ON when system audio is on: the same browser share dialog
  // already has a video track piggy-backed; we just keep it instead
  // of stopping it. Cost: ~50-150 MB per 30-min session held in tab
  // memory. User can flip off if they only need transcript / scoring.
  const [captureVideo, setCaptureVideo] = useState(true);

  useEffect(() => {
    if (open) {
      setMode("live");
      setJd("");
      setResume("");
      setFile(null);
      setCaptureSystemAudio(true);
      setCaptureVideo(true);
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

        {/* System-audio capture toggle (live mode only). When ON, the
            session prompts for a tab/window share with "Share tab audio"
            checked, so Zoom meeting audio + browser playback get
            transcribed alongside the mic. Default ON.
            The "Also record screen video" sub-checkbox piggybacks on the
            same browser share — no extra dialog. Disabled / hidden when
            system audio is off because there's no share to attach to. */}
        {mode === "live" && (
          <div className="mb-4 px-3.5 py-3 rounded-md border border-rule bg-paper-subtle">
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={captureSystemAudio}
                onChange={(e) => setCaptureSystemAudio(e.target.checked)}
                className="mt-0.5 cursor-pointer accent-accent"
              />
              <span className="flex-1 text-[13px] leading-relaxed">
                <span className="font-semibold text-ink">
                  Capture system audio
                </span>
                <span className="text-ink-light">
                  {" "}
                  — pick up sound from a Zoom meeting, browser playback,
                  or any other tab. After clicking Start, your browser
                  will ask which tab/window to share —{" "}
                  <strong className="text-ink">
                    check &quot;Share tab audio&quot;
                  </strong>{" "}
                  in that prompt or only the mic will be used. Leave on
                  if interviewing through any audio source other than
                  the mic.
                </span>
              </span>
            </label>
            {captureSystemAudio && (
              <label className="mt-2 ml-6 flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={captureVideo}
                  onChange={(e) => setCaptureVideo(e.target.checked)}
                  className="mt-0.5 cursor-pointer accent-accent"
                />
                <span className="flex-1 text-[12.5px] leading-relaxed">
                  <span className="font-semibold text-ink">
                    Also record screen video
                  </span>
                  <span className="text-ink-light">
                    {" "}
                    — saves a WebM of the shared tab/window with the
                    same mixed audio. Available for download from the
                    Past Session view. Held in browser memory, lost on
                    refresh — download to keep.
                  </span>
                </span>
              </label>
            )}
          </div>
        )}

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
                captureSystemAudio:
                  mode === "live" ? captureSystemAudio : undefined,
                captureVideo:
                  mode === "live" && captureSystemAudio
                    ? captureVideo
                    : undefined,
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
