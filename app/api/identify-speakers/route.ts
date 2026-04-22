import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

interface IdentifyBody {
  /** Recent utterances tagged with their Deepgram speaker number. */
  utterances: Array<{ speaker: number; text: string }>;
}

/**
 * Given a sample of utterances tagged with raw Deepgram speaker numbers,
 * decides which numbers are "Interviewer" vs "Candidate" based on what they
 * actually say (questioning vs storytelling), NOT speaking order.
 *
 * Returns: { roles: { "0": "Interviewer", "1": "Candidate", ... } }
 *
 * If a speaker hasn't said enough to tell, Haiku is instructed to omit them
 * — caller should keep showing the placeholder ("Speaker N") and try again
 * later when more text accumulates.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as IdentifyBody;
  const utterances = (body.utterances || []).filter(
    (u) => typeof u.speaker === "number" && u.text?.trim()
  );
  if (utterances.length === 0) {
    return NextResponse.json({ roles: {} });
  }

  const client = new Anthropic({ apiKey });

  const system = `You identify the role of each speaker in a recorded interview.

You receive a list of utterances tagged with a raw speaker number (0, 1, 2, ...) from a diarization system. The speaker numbers are arbitrary — they do NOT tell you who the interviewer or candidate is. You must judge by SEMANTICS (what each speaker says).

Roles:
- Interviewer: asks questions ("tell me about...", "walk me through...", "how would you...", "why did you..."), gives short prompts and acknowledgements ("got it", "interesting", "uh huh"), drives the conversation pace, references the role/company in the second person ("at our company", "in this role").
- Candidate: tells stories about their own experience in first-person ("I led a team of...", "at my last job...", "what I did was..."), explains decisions and tradeoffs, gives long answers in response to prompts.

CRITICAL:
- Do not assume the first speaker is the interviewer. Many interviews start with the candidate introducing themselves. Judge by content, not order.
- If a speaker hasn't said enough to tell (only a couple words, or only ambiguous fragments like "yeah" / "okay"), OMIT that speaker number from your response. Do not guess.
- A panel interview can have multiple speakers all classified as "Interviewer". A single candidate is most common.

Return JSON only, no prose. Format:
{"0": "Interviewer", "1": "Candidate", "2": "Interviewer"}

Only include speaker numbers you are confident about. Empty object {} is valid if nobody is clear yet.`;

  const formatted = utterances
    .map((u) => `[Speaker ${u.speaker}]: ${u.text}`)
    .join("\n");

  const user = `Utterances:
"""
${formatted}
"""

Classify each speaker number you have enough evidence for.`;

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

    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
      }
    }

    // Normalize: map "Interviewer" / "Candidate" (case-insensitive) to lowercase.
    // Drop any other labels.
    const roles: Record<number, "interviewer" | "candidate"> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const n = Number(k);
      if (!Number.isFinite(n)) continue;
      const lower = String(v).toLowerCase();
      if (lower === "interviewer") roles[n] = "interviewer";
      else if (lower === "candidate") roles[n] = "candidate";
    }

    return NextResponse.json({ roles });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg, roles: {} }, { status: 500 });
  }
}
