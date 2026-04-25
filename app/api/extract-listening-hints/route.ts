import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";
export const maxDuration = 600;

interface ExtractBody {
  jd: string;
  resume?: string;
  lang: "en" | "zh";
  utterances: Array<{
    role: "interviewer" | "candidate" | "unknown";
    text: string;
    start: number;
    end: number;
  }>;
}

/**
 * Companion to /api/extract-commentary. Produces "listening hints" —
 * short coaching notes that fire when the INTERVIEWER monologues for a
 * while (describing the team, product, a case setup, constraints,
 * stakeholder dynamics). Mirrors the live-mode mode:"listening" output
 * so uploaded-recording review has parity with the live experience.
 *
 * The hints are NOT a judgment of an answer. They tell the candidate:
 *   - What key detail just got dropped
 *   - Why the interviewer brought it up (what they care about)
 *   - How to weave it into the next answer
 *   - What constraint to respect
 *   - When to acknowledge + ask clarifying questions before diving in
 *
 * Returns `{ listeningHints: [{ id, atSec, text }] }`.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as ExtractBody;
  const { jd, resume, lang, utterances } = body;
  if (!utterances || utterances.length === 0) {
    return NextResponse.json({ error: "No utterances" }, { status: 400 });
  }

  const fmtTime = (s: number) => {
    const mm = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };
  const transcript = utterances
    .map((u, i) => {
      const role =
        u.role === "interviewer" ? "I" : u.role === "candidate" ? "C" : "?";
      return `[${i}|${fmtTime(u.start)}|${role}] ${u.text}`;
    })
    .join("\n");

  const langClauseZh = `中文为主,关键词保留英文。和 Live Commentary 一致的 bilingual 风格。每条提示 3-4 句(严格上限:主体 150 字以内,英文术语不计入)。这段要放进固定大小的展示框,超出会被裁掉,宁可短不能超。抓面试官刚透露的具体细节、点出他的关切、再给一句候选人可以怎么接的具体建议。不要硬凑;一句 sharp 的也可以。`;
  const langClauseEn = `English. Each hint 3–4 sentences (strict upper bound: ~70 words / ~450 characters). Must fit in a FIXED display pane — anything longer will be clipped. Catch the specific detail the interviewer just revealed, flag what they care about, and give one concrete suggestion for how the candidate can pick up the thread. Don't pad — a sharp short tip is fine.`;

  const system = `You are a senior interview coach producing LISTENING HINTS for a recorded interview. These hints fire during stretches where the INTERVIEWER is monologuing — describing the team, product, role, setting up a case, or providing context — WITHOUT yet asking a specific question.

Your job is NOT to evaluate the candidate's answer. It's to help the candidate READ the interviewer's monologue: what to catch, why the interviewer brought it up, and how to use it in the next answer.

== TRANSCRIPT FORMAT ==
Each line: [index|mm:ss|I|C|?] text
where I = interviewer, C = candidate, ? = unknown speaker.

== WHEN TO FIRE A HINT ==
Identify stretches where the interviewer speaks substantively for several consecutive turns (or one long turn) WITHOUT landing a specific question. Typical trigger patterns:
- Team / product / role description at the beginning ("We sit within the credit risk team, we build models to predict default…")
- Case study / technical setup ("Imagine you're designing a system that does X, with N users, constrained by Y…")
- Mid-interview context dump between questions ("By the way, our platform has no user-level data yet…")
- Feedback or clarification where the interviewer reveals what they actually care about

Skip:
- Brief one-liners ("Got it", "Interesting")
- Transitional filler ("Okay so…", "Let me think…")
- The question itself (those are handled by the commentary flow)

Aim for ONE hint per substantive monologue. Multiple short interviewer turns that form a single logical monologue count as one.

== WHAT EACH HINT SHOULD DO ==
Pick the MOST useful angle for each monologue. These are the five angles (same as live mode):

1. 抓信息 · Catch the fact — name the specific detail the interviewer just dropped (team size, tech stack, metric, constraint, priority).
2. 读意图 · Read intent — why are they saying this? Long setup = they care about this area; flag it as the anchor for the answer.
3. 准备接 · Prep the hook — what can the candidate DO with this info? Use their team pain point to frame relevant experience, use a named metric to define success.
4. 风险提示 · Flag a risk — if the interviewer disclosed a constraint ("we don't have user data"), remind the candidate not to assume that resource.
5. 回应建议 · Response tip — if this is a case setup, suggest acknowledging first and asking 2–3 scoped clarifying questions before diving in.

Combine angles when natural (e.g. "interviewer cares about cross-team influence (intent) — use your resume's platform work as the anchor (prep)").

== TONE ==
- Light, conversational — a friend with interview experience murmuring advice in real time.
- Point at SPECIFIC words from the monologue. No generic "listen carefully".
- Resume cross-check: if the candidate's resume has something directly relevant to what the interviewer just described, name it explicitly as a hook.
- Pronouns: refer to the candidate as "he" or "she" (default "he" if unknown). Never singular "they".
- May use <strong>…</strong> to highlight 1–2 key terms. No markdown. No preamble.

== EXAMPLES ==

Positive hint examples:
- "面试官反复提到 <strong>cross-team</strong> 和 <strong>stakeholder alignment</strong> —— 这就是后面答题的 anchor,他关心的是协作而不是纯技术。"
- "他刚透露团队只有 3 个人 + 没有 dedicated data eng —— 候选人答 case 时要把 <strong>scope</strong> 收窄,别提依赖大团队的方案。"
- "Setup 很长,说明这个 problem 他 care。建议先说一句 'let me reflect, then a few clarifying questions',避免急着答。"
- "他提到了 <strong>CCAR</strong> 和 regulatory timeline —— 候选人简历里有 regulatory modeling 经验,接下来答题时可以主动 link 过去。"

In English (when lang=en):
- "Interviewer just named <strong>cross-team influence</strong> and <strong>stakeholder alignment</strong> — that's the anchor for the answer. He cares about collaboration, not pure technical depth."
- "He mentioned the team is only 3 people with no dedicated data engineer — narrow the scope in any answer, avoid solutions that assume a big team."
- "Long setup = he cares about this problem. Acknowledge first, then ask 2–3 scoped clarifying questions before diving in."

== OUTPUT ==
Strict JSON, no prose wrapper:
{
  "listeningHints": [
    {"id": "h1", "atSec": 145, "text": "…short hint…"}
  ]
}

atSec: the timestamp of the monologue's LAST interviewer turn, optionally +5-10s so the hint surfaces right as the monologue wraps up.

== OUTPUT LANGUAGE ==
${lang === "zh" ? langClauseZh : langClauseEn}

If there are no substantive monologues in the transcript, return {"listeningHints": []}. Don't invent monologues that aren't there.

Return JSON only.`;

  const resumeBlock = resume
    ? `\n=== CANDIDATE RESUME ===\n${resume}\n=== END RESUME ===\n`
    : "";

  const user = `=== JOB DESCRIPTION ===
${jd}
=== END JD ===
${resumeBlock}
=== TRANSCRIPT ===
${transcript}
=== END TRANSCRIPT ===

Produce listening hints. JSON only.`;

  try {
    const client = getAnthropicClient();
    const t0 = Date.now();
    console.log(
      `[extract-listening-hints] calling Opus · utterances=${utterances.length}`
    );
    const resp = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    });
    console.log(
      `[extract-listening-hints] Opus returned in ${Date.now() - t0}ms · output_tokens=${resp.usage?.output_tokens ?? "?"} stop_reason=${resp.stop_reason ?? "?"}`
    );

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: {
      listeningHints?: Array<{
        id?: string;
        atSec?: number;
        text?: string;
      }>;
    } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* fall through */
        }
      }
    }

    const listeningHints = (parsed.listeningHints || [])
      .filter(
        (h): h is { id: string; atSec: number; text: string } =>
          typeof h.id === "string" &&
          typeof h.atSec === "number" &&
          isFinite(h.atSec) &&
          typeof h.text === "string" &&
          h.text.trim().length > 0
      )
      .map((h) => ({
        id: h.id,
        atSec: Math.max(0, h.atSec),
        text: h.text.trim(),
      }))
      .sort((a, b) => a.atSec - b.atSec);

    console.log(
      `[extract-listening-hints] raw=${(parsed.listeningHints || []).length} valid=${listeningHints.length}`
    );

    return NextResponse.json({ listeningHints });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
