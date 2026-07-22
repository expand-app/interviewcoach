/**
 * Shared contract for the two Retake mock-interview engines:
 *  - MockInterviewer          (lib/mockInterviewer.ts)        — Aura TTS + Deepgram STT + Claude next-turn
 *  - RealtimeMockInterviewer  (lib/mockInterviewerRealtime.ts) — OpenAI Realtime voice (WebRTC)
 *
 * getMockInterviewer() returns whichever the RETAKE engine flag selects;
 * MockInterviewView + app/page.tsx only depend on this interface, so
 * swapping engines needs no UI changes.
 */

import type { RetakePlan } from "@/app/api/retake/plan/route";

export interface StartArgs {
  plan: RetakePlan;
  jd: string;
  resume: string;
  interviewerProfileSummary?: string;
}

export interface IMockInterviewer {
  start(args: StartArgs): Promise<void>;
  stop(): Promise<void>;
  getCameraStream(): MediaStream | null;
  setUserMuted(muted: boolean): void;
  skipQuestion(): void;
}
