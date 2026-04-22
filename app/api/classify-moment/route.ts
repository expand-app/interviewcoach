import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { appendFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const DEBUG_LOG_PATH = path.join(process.cwd(), "debug-classifications.jsonl");
const DEBUG_ENABLED = process.env.NODE_ENV !== "production";

async function logClassification(entry: Record<string, unknown>) {
  if (!DEBUG_ENABLED) return;
  try {
    await appendFile(
      DEBUG_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
    );
  } catch {
    /* logging must never break the request */
  }
}

type MomentStateKind =
  | "chitchat"
  | "interviewer_speaking"
  | "question_finalized";

interface ClassifyBody {
  /** Recent utterances tagged with their speaker label (resolved or placeholder). */
  utterances: Array<{ speaker: string; text: string }>;
  /** What we're currently displaying — helps avoid bouncing. */
  currentState: "idle" | MomentStateKind;
  /** Milliseconds since the last finalized utterance. Used to detect silence. */
  msSinceLastTranscript: number;
}

/**
 * The conversation state machine. Replaces the older /api/detect-question.
 *
 * Decides which of three states the live moment is in, and provides a one-line
 * human-readable summary for the top bar. When a question is fully formed AND
 * it's safe to lock it in (interviewer paused or candidate has substantively
 * started answering), returns state="question_finalized" with the cleaned
 * question text.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as ClassifyBody;
  const utterances = (body.utterances || []).filter((u) => u.text?.trim());
  if (utterances.length === 0) {
    return NextResponse.json({ state: "chitchat", summary: "", question: "" });
  }
  const currentState = body.currentState || "idle";
  const msSinceLastTranscript = Number(body.msSinceLastTranscript) || 0;

  const client = new Anthropic({ apiKey });

  const system = `You are the state machine for a live interview assistant. You read recent transcript turns and decide the current "moment" of the conversation.

States:
- "chitchat": small talk — greetings, intros, weather, audio test ("can you hear me?"), screen sharing chatter, anything that is NOT an actual interview question being asked. Long candidate self-introductions in response to "tell me about yourself" are NOT chitchat — they're an answer.
- "interviewer_speaking": the interviewer is mid-question. They've started asking but either haven't finished, OR they may continue (recent silence is short, the question feels incomplete, or they're correcting themselves with "um, so, what I mean is..."). Compound questions ("Can you tell me about X, and also Y?") count as a single question still being formed until the interviewer clearly stops.
- "question_finalized": the interviewer has asked a complete, coherent question AND one of the following is true:
    (a) msSinceLastTranscript >= 2000 — they've been silent at least 2 seconds, OR
    (b) the candidate has substantively started answering (>= 30 chars of first-person speech in the most recent turn).

CRITICAL rules:
- Do NOT finalize a question prematurely. Brief pauses (< 2s) inside a question, restarts ("um, so..."), and self-corrections are part of "interviewer_speaking", not finalization.
- Do not flip-flop. If currentState is "question_finalized", stay there until the interviewer clearly starts a NEW question (then go to "interviewer_speaking" for the new one). The candidate answering does not change the state away from "question_finalized".
- Stage-setting from the interviewer ("so for this part I'm going to give you a case study") is "interviewer_speaking", not "question_finalized" — wait for the actual question to follow.

Output JSON only:
{
  "state": "chitchat" | "interviewer_speaking" | "question_finalized",
  "summary": "<one short human-readable line for the UI top bar>",
  "question": "<cleaned question text — ONLY when state is question_finalized, otherwise empty string>"
}

Summary writing style:
- chitchat: e.g. "Greeting and audio check", "Just chatting about the weather"
- interviewer_speaking: start with what they're asking about, e.g. "Asking about your understanding of the recommendation model goal...", "Setting up a case study about Stripe checkout..."
- question_finalized: a brief restatement, e.g. the question text itself or a 5-8 word topic

The question field, when present:
- Clean filler ("so uh", "okay so", "alright")
- Preserve the interviewer's wording — don't paraphrase
- Combine compound clauses into one coherent question if they were asked together`;

  const formatted = utterances
    .map((u) => `[${u.speaker}]: ${u.text}`)
    .join("\n");

  const user = `Recent transcript:
"""
${formatted}
"""

Current displayed state: ${currentState}
Milliseconds since last transcript: ${msSinceLastTranscript}

Decide the moment.`;

  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: { state?: string; summary?: string; question?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
      }
    }

    const state: MomentStateKind =
      parsed.state === "chitchat" ||
      parsed.state === "interviewer_speaking" ||
      parsed.state === "question_finalized"
        ? parsed.state
        : "chitchat";
    const summary = (parsed.summary || "").trim();
    const question =
      state === "question_finalized" ? (parsed.question || "").trim() : "";

    void logClassification({
      kind: "classify-moment",
      currentState,
      msSinceLastTranscript,
      utteranceCount: utterances.length,
      state,
      summary,
      question,
      raw: text,
    });

    return NextResponse.json({ state, summary, question });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: msg, state: "chitchat", summary: "", question: "" },
      { status: 500 }
    );
  }
}
