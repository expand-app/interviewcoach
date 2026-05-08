import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";

interface Body {
  jd: string;
  resume?: string;
  /** Raw interviewer profile paste (typically a LinkedIn copy/paste).
   *  Often hundreds of lines including job history, skills, awards
   *  etc. — too long to render verbatim in the Past view. We summarize
   *  to ~40-60 words: name + current role + company + 1-2 notable
   *  background points. Empty / missing → no interviewerSummary in
   *  the response. */
  interviewerProfile?: string;
}

/**
 * Post-session helper. Produces SHORT prose summaries of the JD,
 * (when present) the candidate's resume, and (when present) the
 * interviewer's pasted profile so the Past Session view can render a
 * Context block above the transcript without forcing the user to
 * re-read raw text.
 *
 * Output shape: `{ jdSummary, resumeSummary?, interviewerSummary? }`.
 * Each optional summary is undefined (omitted from JSON) when its
 * input was blank or the model returned empty text — the caller
 * treats either as "skip that row".
 *
 * One Haiku call per (jd | resume | interviewer) — all three summaries
 * fit comfortably in a single 500-token response so we make ONE call
 * with structured sections in the prompt.
 *
 * Failure handling: on any model / network error, returns
 * `{ error, fallback: true }` with no summaries so the client can
 * retry or just leave the Context block hidden.
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
  const jd = (body.jd || "").trim();
  const resume = (body.resume || "").trim();
  const interviewerProfile = (body.interviewerProfile || "").trim();
  if (!jd) {
    return NextResponse.json({ error: "missing jd", fallback: true });
  }

  const hasResume = resume.length > 0;
  const hasInterviewer = interviewerProfile.length > 0;

  const system = `You produce ultra-short context summaries for an interview review screen.

Output STRICT JSON, no prose wrapper, no markdown:

{
  "jdSummary": "<2-3 sentence summary of the role + key responsibilities. Plain prose. ~40-60 words.>",
  "resumeSummary": "<2-3 sentence summary of the candidate's background — most recent role, years of experience, notable strengths. ~40-60 words. Set to empty string if no resume was provided.>",
  "interviewerSummary": "<2-3 sentence summary of the interviewer — name, current role, company, and at most 1-2 notable background points (years of experience, prior employer, area of focus). ~40-60 words. Set to empty string if no interviewer profile was provided.>"
}

Rules:
- All summaries are PROSE in plain English. No bullet points, no markdown, no newlines inside the JSON strings.
- Skip generic filler ("This role is exciting...", "Experienced professional with..."). Lead with the concrete.
  * JD: company, role title, scope, key responsibilities.
  * Resume: most recent role + company, total YoE, 1-2 strengths the JD cares about.
  * Interviewer: full name (if present), current title + company, then 1-2 background facts (e.g. "4 years at Goldman Sachs across Prime Brokerage and FICC", "ex-FP&A at a hospital network"). DO NOT include skills lists, certifications, university details, or every prior role — pick ONE sharp signal.
- If a company name is in the JD or interviewer profile, use it. Same for technologies, products, and named projects.
- DO NOT speculate or invent details that aren't in the input.
- Length cap: 60 words each. Going over is worse than going short.
${hasResume ? "" : "- Resume input is empty. Set resumeSummary to an empty string."}
${hasInterviewer ? "" : "- Interviewer input is empty. Set interviewerSummary to an empty string."}`;

  const user = `Job description:
"""
${jd.slice(0, 4000)}
"""

${hasResume ? `Candidate resume:\n"""\n${resume.slice(0, 4000)}\n"""\n` : "(No candidate resume provided.)\n"}
${hasInterviewer ? `Interviewer profile (raw paste — extract the essentials):\n"""\n${interviewerProfile.slice(0, 4000)}\n"""\n` : "(No interviewer profile provided.)\n"}
Write the JSON.`;

  // Same retry shape as the other Anthropic-backed routes — one
  // ECONNRESET shouldn't lose the summary. 2 attempts, 2s backoff.
  async function callWithRetry() {
    const client = getAnthropicClient();
    const doCall = () =>
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
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

    let parsed: {
      jdSummary?: string;
      resumeSummary?: string;
      interviewerSummary?: string;
    } = {};
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

    const jdSummary = (parsed.jdSummary || "").trim();
    const resumeSummary = (parsed.resumeSummary || "").trim();
    const interviewerSummary = (parsed.interviewerSummary || "").trim();

    if (!jdSummary) {
      console.warn("[summarize-context] empty jdSummary from model");
      return NextResponse.json({ error: "empty jdSummary", fallback: true });
    }

    return NextResponse.json({
      jdSummary,
      // Only include each optional summary when both input and output
      // are non-empty. The client distinguishes "no input" from
      // "summarization failed" by checking truthiness — undefined
      // means skip the row.
      resumeSummary: hasResume && resumeSummary ? resumeSummary : undefined,
      interviewerSummary:
        hasInterviewer && interviewerSummary ? interviewerSummary : undefined,
    });
  } catch (e) {
    const status = (e as { status?: number })?.status;
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[summarize-context] failed:", status, msg);
    return NextResponse.json({ error: msg, fallback: true });
  }
}
