import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";

interface TitleBody {
  jd: string;
  resume?: string;
}

/**
 * Extracts a concise session title from the JD (and optionally the
 * resume, for context) — used as the heading on the live view and as
 * the default name when saving the session. Kept deliberately short:
 * one line, role + company if present, nothing fancy. Haiku is plenty
 * for this and keeps latency low.
 *
 * Examples of good output:
 *   "Senior ML Engineer · Acme"
 *   "Data Scientist · Meta Ads"
 *   "Senior PM Interview"
 *
 * Returns {"title": "..."}. Falls back to "Live Interview Session" on
 * any failure so the UI always has something to render.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { title: "Live Interview Session", error: "ANTHROPIC_API_KEY not set" },
      { status: 200 }
    );
  }

  const body = (await req.json()) as TitleBody;
  const jd = (body.jd || "").trim();
  if (!jd) {
    return NextResponse.json({ title: "Live Interview Session" });
  }

  const system = `You produce a short session title from a job description. Output RAW TEXT only — no JSON, no quotes, no prose wrapper.

Format: "<Level + Role> · <Company>" when the company name is obvious from the JD. Omit the company when it isn't. Cap the whole title at 60 characters.

Examples of good outputs:
Senior ML Engineer · Acme
Data Scientist · Meta Ads
Staff Backend Engineer · Stripe
Senior PM Interview
Applied Scientist · Amazon Search

Do NOT add "Interview", "Session", etc. unless no company is found (fallback form only). Output the title on a single line with no trailing punctuation.`;

  const user = `Job description:
"""
${jd.slice(0, 4000)}
"""

Write the title.`;

  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 40,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "") // strip stray quotes if the model slipped
      .split("\n")[0]
      .slice(0, 80);

    return NextResponse.json({
      title: text || "Live Interview Session",
    });
  } catch {
    return NextResponse.json({ title: "Live Interview Session" });
  }
}
