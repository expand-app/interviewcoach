import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";

interface Body {
  interviewerProfile: string;
}

/**
 * Live-time helper: summarizes the user's pasted interviewer profile
 * (often a verbatim LinkedIn copy that runs hundreds of lines) into a
 * compact ~50-word prose blurb that the orchestrator threads into
 * every Live Commentary / Listening Hint / Candidate-Question call.
 *
 * Why a separate route from /api/summarize-context: this fires at
 * SESSION START, in parallel with the user accepting share dialogs,
 * so by the time the first commentary triggers (~30s+ into the
 * session) the model already has a calibrated short blurb. Per-call
 * we then ship ~50 words instead of ~3000 — same coaching effect,
 * far fewer tokens across a 30-question session.
 *
 * Output shape: `{ summary }` on success, `{ error, fallback: true }`
 * on failure. The orchestrator falls back to the raw paste when the
 * summary isn't ready, so failure here is non-fatal.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set", fallback: true },
      { status: 200 }
    );
  }

  const body = (await req.json()) as Body;
  const profile = (body.interviewerProfile || "").trim();
  if (!profile) {
    return NextResponse.json({ error: "missing interviewerProfile", fallback: true });
  }

  const system = `You produce a SHORT prose summary of an interviewer's background, used by an interview-coaching system to calibrate the tone of its live commentary.

Output STRICT JSON, no prose wrapper, no markdown:

{
  "summary": "<2-3 sentences, ~50-80 words, plain prose>"
}

What to include (priority order):
1. Full name (if present in the input).
2. Current title + company.
3. ONE OR TWO most relevant background facts — years of experience, prior employer, area of focus. Pick the facts most likely to influence what kind of answer "lands" with this person (e.g. "ex-FAANG engineer" → expects technical depth; "10 years in management consulting" → expects structured impact narratives).

What to OMIT:
- Bullet lists, skills enumerations, certifications, scholarship names.
- University degrees unless they're the only signal available.
- Every prior role — pick one if it informs their lens.
- Filler phrases ("experienced professional", "passionate about...").

Length cap: 80 words. Going over is worse than going short.`;

  const user = `Raw interviewer profile (verbatim paste — extract the essentials):
"""
${profile.slice(0, 6000)}
"""

Write the JSON.`;

  // Retry shape mirrors the other Haiku-backed routes.
  async function callWithRetry() {
    const client = getAnthropicClient();
    const doCall = () =>
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }],
      });
    const MAX_ATTEMPTS = 2;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await doCall();
      } catch (e) {
        lastErr = e;
        const status = (e as { status?: number })?.status;
        const isTransient =
          status === undefined ||
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504;
        if (!isTransient) throw e;
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
      }
    }
    throw lastErr;
  }

  try {
    const resp = await callWithRetry();
    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: { summary?: string } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* swallow */
        }
      }
    }
    const summary = (parsed.summary || "").trim();
    if (!summary) {
      return NextResponse.json({
        error: "empty summary",
        fallback: true,
      });
    }
    return NextResponse.json({ summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[summarize-interviewer] failed:", msg);
    return NextResponse.json({ error: msg, fallback: true });
  }
}
