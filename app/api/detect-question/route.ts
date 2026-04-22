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
 * Claude Haiku is used here because it's fast and cheap — we call this on
 * every finalized utterance, and we don't want to pay Sonnet rates for a
 * boolean classification.
 *
 * "question" in the response is the normalized question text (trimmed,
 * cleaned up), useful because Deepgram sometimes returns fragments like
 * "so uh tell me about yourself".
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 });
  }

  const body = (await req.json()) as DetectBody;
  const { utterance, recentContext = "" } = body;
  if (!utterance?.trim()) {
    return NextResponse.json({ isQuestion: false });
  }

  const client = new Anthropic({ apiKey });

  const system = `You are a classifier inside a live interview assistant. The mic picks up BOTH the interviewer and the candidate. For each utterance you must decide (a) who is speaking and (b) whether it is the interviewer asking a NEW question.

Rules:
- Return JSON only, no prose.
- Format: {"speaker": "interviewer"|"candidate"|"unknown", "isQuestion": true|false, "question": "cleaned up question text"}
- If isQuestion is false, omit "question" or set it to "".

Speaker cues:
- INTERVIEWER: asks questions, gives prompts ("tell me about...", "walk me through..."), short acknowledgements between candidate turns ("got it", "uh huh", "interesting"), references the role/company in second person ("what would you do at our company", "in this role you would...").
- CANDIDATE: first-person narration about own experience ("I led a team of...", "at my last job we..."), explaining decisions/tradeoffs, telling stories. Long monologues are almost always the candidate.
- If a single utterance clearly mixes both (rare — usually a transcription artifact), pick whichever dominates.
- If genuinely ambiguous (e.g. "okay" alone, "yeah", a short fragment), use "unknown".
- Use the recent context to disambiguate — if the prior turns were the candidate telling a story, a new "so um, what about X?" is probably the interviewer interrupting.

Question cues (only relevant when speaker is interviewer):
- An utterance is a question if it solicits new information, opinion, or a story. Requests like "tell me about...", "walk me through...", "how would you..." all count.
- Follow-up probes like "why?", "can you expand?", "what else?" are NOT new questions — they continue the current one.
- If speaker is candidate or unknown, isQuestion MUST be false.
- Clean up filler ("so uh", "okay so") when you return the question.`;

  const user = `Recent context (what came just before — may be empty):
"""
${recentContext.slice(-400)}
"""

Latest utterance:
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

    // Try to parse as strict JSON, falling back to extracting the first {...}.
    let parsed: { speaker?: string; isQuestion?: boolean; question?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
      }
    }

    const speaker =
      parsed.speaker === "interviewer" || parsed.speaker === "candidate"
        ? parsed.speaker
        : "unknown";
    // Hard guard: only the interviewer can be asking a new question.
    const isQuestion = speaker === "interviewer" && Boolean(parsed.isQuestion);
    const question = isQuestion ? parsed.question?.trim() || "" : "";

    void logClassification({
      utterance,
      recentContext: recentContext.slice(-300),
      speaker,
      isQuestion,
      question,
      raw: text,
    });

    return NextResponse.json({ speaker, isQuestion, question });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg, isQuestion: false }, { status: 500 });
  }
}
