"use client";

import { useState, useEffect } from "react";
import { ModalShell } from "./ModalShell";
import { Button, Field, Textarea } from "@/components/ui";

interface Props {
  open: boolean;
  onCancel: () => void;
  /** Live mic capture is the only entry point. Audio + screen capture
   *  are NOT user-configurable: every session captures system audio
   *  (tab share with audio) AND records the LiveView card via the
   *  second share prompt. The AudioSession options are still threaded
   *  so the orchestrator can pass canonical values, but the UI no
   *  longer exposes toggles for them. */
  onStart: (args: {
    jd: string;
    resume: string;
    captureSystemAudio: boolean;
    captureVideo: boolean;
    useMic: boolean;
    /** Optional summary of the interviewer's background (typically
     *  pasted from LinkedIn or written manually). Empty string when
     *  not provided. Threaded into Live Commentary so the coach can
     *  tailor framing to the interviewer's role. */
    interviewerProfile?: string;
  }) => void;
}

export function StartModal({ open, onCancel, onStart }: Props) {
  const [jd, setJd] = useState("");
  const [resume, setResume] = useState("");
  // "Microphone On" toggle. Default OFF — the common path is the
  // candidate using a tab share that already contains their voice
  // (Zoom etc. routed through the shared tab), so the mic is opt-in.
  // Flip ON when the candidate's voice needs to come from the laptop
  // mic specifically. System-audio capture + screen recording are NOT
  // user-toggleable (always on).
  const [useMic, setUseMic] = useState(false);
  // Optional interviewer profile — short summary the user pastes in
  // (LinkedIn copy-paste, manual notes, etc.). Threaded into Live
  // Commentary so the coach can tailor framing to the interviewer's
  // role.
  const [interviewerProfile, setInterviewerProfile] = useState("");

  useEffect(() => {
    if (open) {
      setJd("");
      setResume("");
      setUseMic(false);
      setInterviewerProfile("");
    }
  }, [open]);

  const canSubmit = jd.trim().length > 0;

  return (
    <ModalShell open={open} onClose={onCancel} variant="wide">
      {/* Type scale normalized to four sizes:
            - Heading:    20px / 600
            - Body:       13px / 400 muted   (description, mic-toggle text)
            - Help:       12px / 400 subtle  (footer note)
            - Field internals: handled by Field primitive (13px label,
              11px Required/Optional badge)
          Padding uses --space-6 (24px) verticals + --space-8 (32px)
          horizontals — these match the design system's actual scale
          (the previous --space-5/--space-7 references were phantom
          tokens; the spec deliberately skips 5 and 7 in the scale,
          so var() resolved to 0 and the modal had no top/bottom
          padding). */}
      <div className="px-8 py-6">
        {/* Modal heading — h2 design-system rule: weight 600, never
            700 at this size, with -0.02em letter-spacing baked in. */}
        <h2
          className="text-text mb-2"
          style={{
            fontSize: "1.25rem",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            lineHeight: 1.25,
          }}
        >
          Start a new session
        </h2>
        <p
          className="text-text-muted leading-relaxed mb-6"
          style={{ fontSize: "0.8125rem" }}
        >
          Paste the job description. Adding the resume and interviewer
          background helps AI tailor commentary — the more context you
          give, the sharper the suggestions.
        </p>

        {/* Microphone toggle — visually distinct from the Field
            textareas below (it's a yes/no decision, not a typed
            input). Light surface bg + subtle border. Internal type
            matches the body scale of the modal subtitle above:
            13px label + 12.5px help. */}
        <label
          className="flex items-start gap-2.5 cursor-pointer rounded-md border border-border bg-surface mb-5"
          style={{ padding: "10px 12px" }}
        >
          <input
            type="checkbox"
            checked={useMic}
            onChange={(e) => setUseMic(e.target.checked)}
            className="cursor-pointer"
            style={{
              accentColor: "var(--color-text)",
              marginTop: "3px",
            }}
          />
          <span className="flex-1 leading-snug">
            <span
              className="font-medium text-text"
              style={{ fontSize: "0.8125rem" }}
            >
              Microphone On
            </span>
            <span
              className="text-text-muted"
              style={{ fontSize: "0.8125rem" }}
            >
              {" "}
              — turn on if your own voice goes through the laptop mic.
              Leave off if you&apos;ll share an interview tab that
              already includes both sides&apos; audio.
            </span>
          </span>
        </label>

        {/* Form fields. Field primitive owns the label-row + Required/
            Optional badges, so the typography is identical across all
            three. Textarea min-heights are sized to fit a typical 13"
            viewport without modal scrolling — JD bigger since it's
            mandatory and most-used. */}
        <Field label="Job Description" required>
          <Textarea
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            placeholder="Paste the full JD — role, responsibilities, required skills, company context."
            style={{ minHeight: "88px" }}
          />
        </Field>

        <Field label="Candidate Resume" optional>
          <Textarea
            value={resume}
            onChange={(e) => setResume(e.target.value)}
            placeholder="Paste the candidate's resume — past roles, projects, education."
            style={{ minHeight: "64px" }}
          />
        </Field>

        <Field label="Interviewer Profile" optional>
          <Textarea
            value={interviewerProfile}
            onChange={(e) => setInterviewerProfile(e.target.value)}
            placeholder="Short summary of the interviewer — current role, company, notable background."
            style={{ minHeight: "64px" }}
          />
        </Field>

        {/* Footer note — help-text scale (12px / text-subtle) so it
            reads as a quiet hint, not a second body paragraph.
            mt-4 / mb-4 = 16px each, matching the rhythm above. */}
        <p
          className="text-text-subtle leading-snug mt-4 mb-4"
          style={{ fontSize: "0.75rem" }}
        >
          On Continue, you&apos;ll share your interview tab (with audio)
          and this app&apos;s tab (for recording).
        </p>

        <div className="flex gap-2 justify-end">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() =>
              canSubmit &&
              onStart({
                jd: jd.trim(),
                resume: resume.trim(),
                captureSystemAudio: true,
                captureVideo: true,
                useMic,
                interviewerProfile: interviewerProfile.trim() || undefined,
              })
            }
          >
            Continue →
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
