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

interface DetectBody {
  /** The latest finalized transcript chunk from Deepgram. */
  utterance: string;
  /** Short context: last ~200 chars of what preceded it. */
  recentContext?: string;
}

/**
 * Returns { isQuestion: boolean, question?: string }.
 *
 * Pure question-detection now — caller should only invoke this when it has
 * already determined that the speaker is the INTERVIEWER (via the separate
 * /api/identify-speakers route). Speaker classification has been removed
 * from this endpoint to avoid double-work.
 *
 * Claude Haiku is used here because it's fast and cheap.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  const body = (await req.json()) as DetectBody;
  const { utterance, recentContext = "" } = body;
  if (!utterance?.trim()) {
    return NextResponse.json({ isQuestion: false, question: "" });
  }

  const client = new Anthropic({ apiKey });

  const system = `You are a classifier inside a live interview assistant. The utterance below is from the INTERVIEWER. Your only job is to decide whether it is a NEW interview question.

Rules:
- Return JSON only, no prose.
- Format: {"isQuestion": true|false, "question": "cleaned up question text"}
- If isQuestion is false, omit "question" or set it to "".

What counts as a NEW question:
- Solicits new information, opinion, or a story from the candidate. Examples: "tell me about...", "walk me through...", "how would you...", "why did you...", "what's an example of...".

What does NOT count as a new question (return false):
- Follow-up probes on the current question: "why?", "can you expand?", "what else?", "and then what happened?".
- Acknowledgements / fillers: "got it", "interesting", "uh huh", "ok".
- Stage-setting that isn't a question: "so for this part I'm going to give you a case study".

When isQuestion is true, "question" should be the cleaned-up version with filler removed ("so uh", "okay so", "alright"). Preserve the interviewer's wording otherwise — don't paraphrase.`;

  const user = `Recent context (what came just before — may be empty):
"""
${recentContext.slice(-400)}
"""

Latest interviewer utterance:
"""
${utterance}
"""`;

  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: { isQuestion?: boolean; question?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
      }
    }

    const isQuestion = Boolean(parsed.isQuestion);
    const question = isQuestion ? parsed.question?.trim() || "" : "";

    void logClassification({
      kind: "detect-question",
      utterance,
      recentContext: recentContext.slice(-300),
      isQuestion,
      question,
      raw: text,
    });

    return NextResponse.json({ isQuestion, question });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg, isQuestion: false, question: "" }, { status: 500 });
  }
}
