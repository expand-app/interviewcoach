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
  /** The text of the currently-displayed Current Question, if any.
   *  Used to decide whether new interviewer speech is a follow-up or a NEW topic. */
  currentQuestionText?: string;
}

/**
 * The conversation state machine. Decides which of three moments the live
 * conversation is in and provides a one-line summary for the top bar.
 *
 * CRUCIAL: when a question has already been finalized (currentQuestionText
 * is non-empty), we are very conservative about transitioning away from
 * QUESTION_FINALIZED. Follow-ups, candidate clarifications, and side-
 * chitchat all keep the existing question pinned. Only a clear NEW topical
 * question fires isNewQuestion=true (or returns a different question text).
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
    return NextResponse.json({
      state: "chitchat",
      summary: "",
      question: "",
      isNewQuestion: false,
    });
  }
  const currentState = body.currentState || "idle";
  const msSinceLastTranscript = Number(body.msSinceLastTranscript) || 0;
  const currentQuestionText = (body.currentQuestionText || "").trim();

  const client = new Anthropic({ apiKey });

  const system = `You are the state machine for a live interview assistant. You read recent transcript turns and decide the current "moment" of the conversation.

States:
- "chitchat": small talk — greetings, intros, audio test ("can you hear me?"), screen sharing chatter. Long candidate self-introductions in response to "tell me about yourself" are NOT chitchat — they're an answer.
- "interviewer_speaking": the interviewer is mid-question — started but not finished, OR may continue (recent silence is short, the question feels incomplete, restarts like "um, so what I mean is...").
- "question_finalized": the interviewer has asked a complete, coherent question AND one of:
    (a) msSinceLastTranscript >= 2000 — silence ≥ 2s, OR
    (b) the candidate has substantively started answering (>= 30 chars of first-person speech in the most recent turn).

Compound questions ("Can you tell me about X, and also Y?") count as a single question still being formed until the interviewer clearly stops.

== ANCHORING — most important rule ==
If currentQuestionText is non-empty (a question is already locked in), be VERY conservative about transitioning. Specifically:

1. If the latest interviewer turn is a FOLLOW-UP on the same topic — clarification ("by X I mean Y"), drilling deeper ("can you give a specific example?", "what was the architecture?"), or a sub-question that explores the same story — STAY in "question_finalized" with the SAME question text. Set isNewQuestion=false.

2. If the candidate is asking for clarification, going off-topic, or chatting — STAY in "question_finalized". Set isNewQuestion=false.

3. ONLY transition out of question_finalized when the interviewer pivots to a clearly DIFFERENT topic, story, or area:
   - Q1 was about Project A → interviewer asks about Project B → NEW. isNewQuestion=true.
   - Q1 was about technical decisions → interviewer asks about team management → NEW. isNewQuestion=true.
   - Q1 was about background → interviewer asks "let's do a case study" → NEW. isNewQuestion=true.

When isNewQuestion=true and the new question is also complete, return state="question_finalized" with the new question text. Otherwise return state="interviewer_speaking" with isNewQuestion=true to flag the topic shift while the new question is still being asked.

== OUTPUT ==
JSON only, no prose:
{
  "state": "chitchat" | "interviewer_speaking" | "question_finalized",
  "summary": "<one short human-readable line for the UI top bar>",
  "question": "<cleaned question text — only when state=question_finalized, otherwise empty>",
  "isNewQuestion": true | false
}

Summary writing style:
- chitchat: "Greeting and audio check", "Just chatting about the weather"
- interviewer_speaking: short topic phrase, e.g. "asking about the recommendation model goal", "setting up a case study about Stripe checkout"
- question_finalized: omit or echo the question

The "question" field, when present:
- Clean filler ("so uh", "okay so", "alright")
- Preserve the interviewer's wording — don't paraphrase
- Combine compound clauses into one coherent question if asked together`;

  const formatted = utterances
    .map((u) => `[${u.speaker}]: ${u.text}`)
    .join("\n");

  const user = `Recent transcript:
"""
${formatted}
"""

Current displayed state: ${currentState}
${currentQuestionText ? `Current locked-in question: """${currentQuestionText}"""` : "Current locked-in question: (none)"}
Milliseconds since last transcript: ${msSinceLastTranscript}

Decide the moment. Apply the anchoring rule strictly if there is a locked-in question.`;

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

    let parsed: {
      state?: string;
      summary?: string;
      question?: string;
      isNewQuestion?: boolean;
    } = {};
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
    const isNewQuestion = Boolean(parsed.isNewQuestion);

    void logClassification({
      kind: "classify-moment",
      currentState,
      currentQuestionText,
      msSinceLastTranscript,
      utteranceCount: utterances.length,
      state,
      summary,
      question,
      isNewQuestion,
      raw: text,
    });

    return NextResponse.json({ state, summary, question, isNewQuestion });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      {
        error: msg,
        state: "chitchat",
        summary: "",
        question: "",
        isNewQuestion: false,
      },
      { status: 500 }
    );
  }
}
