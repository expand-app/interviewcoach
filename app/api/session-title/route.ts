import { NextResponse } from "next/server";
import { getDeepseekClient, DEEPSEEK_MODEL } from "@/lib/deepseek-client";

export const runtime = "nodejs";

interface TitleBody {
  jd: string;
  resume?: string;
}

/**
 * Extracts a concise session title from the JD (and optionally the
 * resume, for context) — used as the heading on the live view and as
 * the default name when saving the session. Kept deliberately short:
 * one line, role + company if present, nothing fancy. the model is plenty
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
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { title: "Live Interview Session", error: "DEEPSEEK_API_KEY not set" },
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
    const client = getDeepseekClient("session_title");
    const resp = await client.chat.completions.create({
      model: DEEPSEEK_MODEL,
      max_tokens: 40,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = (resp.choices[0]?.message?.content ?? "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "") // strip stray quotes if the model slipped
      .split("\n")[0]
      .slice(0, 80);

    if (!text) {
      // Model returned empty / whitespace — count as fallback so the
      // client knows to retry. Surface in server log too so we can
      // see if this happens in patterns (specific JD shapes etc.).
      console.warn("[session-title] model returned empty text");
      return NextResponse.json({
        title: "Live Interview Session",
        fallback: true,
      });
    }

    return NextResponse.json({ title: text });
  } catch (e) {
    // Used to be a bare `catch {}` — completely silent, the only
    // visible symptom was the title staying as "Live Interview
    // Session". Now log the real cause (ECONNRESET / 429 / timeout /
    // etc.) and signal `fallback: true` so the client can retry.
    const status = (e as { status?: number })?.status;
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[session-title] failed:", status, msg);
    return NextResponse.json({
      title: "Live Interview Session",
      fallback: true,
    });
  }
}
