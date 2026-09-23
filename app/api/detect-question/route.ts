import { NextResponse } from "next/server";
import { getDeepseekClient, DEEPSEEK_MODEL } from "@/lib/deepseek-client";

export const runtime = "nodejs";

interface DetectBody {
  /** The latest finalized transcript chunk from Deepgram. */
  utterance: string;
  /** Short context: last ~200 chars of what preceded it. */
  recentContext?: string;
}

/**
 * Returns { isQuestion: boolean, question?: string }.
 *
 * Kept on a tight max_tokens budget: this fires on every finalized
 * utterance, and the answer is a boolean plus a short string.
 *
 * "question" in the response is the normalized question text (trimmed,
 * cleaned up), useful because Deepgram sometimes returns fragments like
 * "so uh tell me about yourself".
 */
export async function POST(req: Request) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "DEEPSEEK_API_KEY not set" }, { status: 500 });
  }

  const body = (await req.json()) as DetectBody;
  const { utterance, recentContext = "" } = body;
  if (!utterance?.trim()) {
    return NextResponse.json({ isQuestion: false });
  }

  const client = getDeepseekClient("detect_question");

  const system = `You are a classifier inside a live interview assistant. You decide if the latest utterance from the transcript stream is the interviewer asking a NEW question.

Rules:
- Return JSON only, no prose.
- Format: {"isQuestion": true|false, "question": "cleaned up question text"}
- If isQuestion is false, omit "question" or set it to "".
- An utterance is a question if it solicits new information, opinion, or a story from the candidate. Requests like "tell me about...", "walk me through...", "how would you..." all count.
- Follow-up probes like "why?", "can you expand?", "what else?" are NOT new questions — they continue the current one.
- The candidate's own speech (first-person "I did...") is not a question even if it ends with a rising tone.
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
    const resp = await client.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 200,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const text = (resp.choices[0]?.message?.content ?? "").trim();

    // Try to parse as strict JSON, falling back to extracting the first {...}.
    let parsed: { isQuestion?: boolean; question?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
      }
    }

    return NextResponse.json({
      isQuestion: Boolean(parsed.isQuestion),
      question: parsed.question?.trim() || "",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg, isQuestion: false }, { status: 500 });
  }
}
