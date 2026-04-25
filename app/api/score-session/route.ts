import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { SessionScore, Question } from "@/types/session";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";

interface ScoreBody {
  jd: string;
  resume?: string;
  /** Every question recorded during the session, in chronological order,
   *  INCLUDING probe (follow-up) questions. Each carries its commentary. */
  questions: Question[];
  /** Wall-clock duration of the session in seconds, for context only. */
  durationSeconds: number;
}

const DIMENSIONS = [
  {
    key: "question_addressing",
    label: "Question Addressing",
    max: 25,
    description:
      "Did the candidate answer what was asked, or pivot / dodge / restate their background? Interviewers score this high when answers engage the actual prompt, low when answers drift to safer topics.",
  },
  {
    key: "specificity",
    label: "Specificity & Evidence",
    max: 25,
    description:
      "Concrete work, numbers, decisions — not generalities. Score high when claims are grounded in named projects, metrics, architecture choices; low when answers stay abstract or sound rehearsed.",
  },
  {
    key: "depth",
    label: "Depth & Reasoning",
    max: 20,
    description:
      "Senior-level thinking: tradeoffs surfaced, scope narrowed intelligently, clarifying questions asked when the prompt was ambiguous. Score high for demonstrated judgment; low for shallow or over-broad answers.",
  },
  {
    key: "role_fit",
    label: "Role Fit",
    max: 15,
    description:
      "Alignment with the JD's expectations and seniority bar. Score high when answers hit the signals the JD calls out (e.g. cross-team influence, ML depth); low when they miss them.",
  },
  {
    key: "communication",
    label: "Communication",
    max: 15,
    description:
      "Clarity, structure, pacing. Score high for organized, confident delivery; low for rambling, heavy filler, or answers so hard to follow that strong content gets obscured.",
  },
] as const;

function verdictForPercent(percent: number): SessionScore["verdict"] {
  if (percent >= 85) return "strong_pass";
  if (percent >= 70) return "pass";
  if (percent >= 60) return "borderline";
  return "fail";
}

/**
 * End-of-session overall assessment. Takes the full interview (JD, resume,
 * every Q + commentary) and returns a 100-point score broken down across
 * the five rubric dimensions, plus 2–3 targeted improvement suggestions.
 *
 * Called once when the user hits "End & Save" — result is cached on the
 * Session so past-session views don't re-call the model.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as ScoreBody;
  const { jd, resume, questions, durationSeconds } = body;

  if (!jd || !questions || questions.length === 0) {
    return NextResponse.json(
      { error: "Missing JD or questions" },
      { status: 400 }
    );
  }

  // Flatten the Q&A tree into a transcript-like block for the model. We
  // keep main questions and their follow-ups (probes) visually nested so
  // it can see which comments apply to which ask.
  const mains = questions.filter((q) => !q.parentQuestionId);
  const followUps = new Map<string, Question[]>();
  for (const q of questions) {
    if (!q.parentQuestionId) continue;
    const list = followUps.get(q.parentQuestionId) ?? [];
    list.push(q);
    followUps.set(q.parentQuestionId, list);
  }

  const qaBlock = mains
    .map((m, i) => {
      const commentLines = m.comments.length
        ? m.comments.map((c) => `  · ${stripTags(c.text)}`).join("\n")
        : "  (no commentary)";
      const probes = followUps.get(m.id) ?? [];
      const probeBlock = probes
        .map((p) => {
          const pc = p.comments.length
            ? p.comments.map((c) => `    · ${stripTags(c.text)}`).join("\n")
            : "    (no commentary)";
          return `  ↳ PROBE: ${p.text}\n${pc}`;
        })
        .join("\n");
      return `Q${i + 1}. ${m.text}\n${commentLines}${probeBlock ? "\n" + probeBlock : ""}`;
    })
    .join("\n\n");

  const rubricBlock = DIMENSIONS.map(
    (d) => `- ${d.label} (${d.max} pts, key="${d.key}"): ${d.description}`
  ).join("\n");

  const system = `You are a senior interview panel calibrator. You score a completed interview on a 100-point rubric and write a hiring-committee-style verdict.

== RUBRIC (100 points total when all dimensions are judgeable) ==
${rubricBlock}

== SCORING CALIBRATION ==
The verdict is computed from (sum of awarded) / (sum of max across JUDGED dimensions):
- >= 85%: strong pass — a panel would advance without hesitation.
- 70-84%: pass — advances, but with reservations to probe next round.
- 60-69%: borderline — committee would hesitate. Could go either way; most real loops this still fails.
- Below 60%: fail — clear no.

Be calibrated, not generous. A vague answer that sounded fluent but said nothing specific is a 10–12 on Specificity, not 20. An answer that never engaged the actual question is a single-digit on Question Addressing. Do NOT inflate to avoid being harsh.

== READ THE ROOM ==
This is a human interaction, not a written exam. The transcript includes the live commentary, which often notes the interviewer's in-the-moment reactions (laughs, "interesting", "great point", flat "okay…", immediate re-phrasings, shifts to simpler questions). Factor those in:
- A candidate who didn't have the technical answer but made a quick, confident recovery that visibly amused the interviewer (laughter, warm banter, engaged follow-ups) should earn credit on Communication and Depth — presence of mind and poise DO matter in hiring decisions. Don't score them as if they'd flubbed in silence.
- Conversely, a technically correct answer delivered to a visibly disengaged interviewer (flat reactions, reduced questions, shift to safer topics) is a weaker signal than the content alone suggests — something about the delivery or framing isn't landing.

DON'T TAKE INTERVIEWER WORDS AT FACE VALUE. Interviewers are trained to be courteous — they rarely say "that was bad", and polite verbal feedback often masks a non-landing answer. Cross-check words with behavior:
- "Interesting." / "Good point." / "Right." followed by a topic pivot, a simpler question, or a long pause → those words are politeness, not real enthusiasm. Read it as a non-landing signal.
- Warm words PLUS deeper follow-ups that build on the answer → genuine engagement.
- Perfunctory "yeah, makes sense" that closes the thread without probing → checkbox courtesy, not agreement.
- A short polite chuckle followed by an immediate re-rail → the joke didn't actually land.
When verbal feedback and behavior conflict, trust the behavior. Don't be fooled into scoring an interview higher than it went just because the interviewer was polite.

Don't invent reactions that aren't in the transcript. But when the commentary clearly reflects interviewer energy, use it — good coaching scores the interview as it actually went, not as a checklist.

== OUTPUT LANGUAGE (Chinese with English keywords) ==
Write every user-facing string — \`summary\`, each dimension's \`justification\`, and every \`improvements\` entry — in Chinese as the base language, with English keywords preserved inline. Match the tone and mixing style of the Live Commentary:
- Product / technical terms (recommendation model, feature store, A/B test, CCAR, LightGBM, tradeoff, scope, probe) → keep English.
- Named entities from the JD / resume (company names, team names, model/framework names) → keep as they appear.
- Direct candidate quotes → preserve in the original language the candidate used.
- Everyday evaluative words (具体, 模糊, 清晰, 空洞, 跑题, 深入, 主动, 扎实, 薄弱) → Chinese.
- Connective / framing language → Chinese.

Tone examples:
- "整体表现扎实,specificity 很够 —— Q2 里点出了 <strong>30% lift</strong> 并把它归在模型改动上,不是 launch 本身,这是 hiring committee 想看到的颗粒度。"
- "Question addressing 偏弱:Q1 里没有回答 '为什么转 banking',而是花了大量时间讲 company history,面试官立刻 pivot 到了简单题。"
- "Q2 在 walk me through a tough decision 上,建议用 problem → options → pick → why 的 shape 来回答。直接点 Postgres vs Dynamo + p99 latency 数据,比现在的叙述更紧。"

Do NOT output pure English. Do NOT output pure Chinese — keep the bilingual mix.

Keep each justification under 25 Chinese characters (English terms don't count). Each improvement: 1-2 sentences, specific to a moment in the transcript.

== WHEN THERE ISN'T ENOUGH TO JUDGE ==
Honesty over false confidence. Two cases — draw the line carefully:

(1) INSUFFICIENT OVERALL — the transcript has almost NO substantive Q&A to work with. Reserved for truly thin sessions. Use this ONLY when one of the following is true:
  - Session has no substantively-answered question at all (pure chitchat, audio setup, an interrupted intro).
  - The candidate's speaking content across the whole session is < ~30 seconds worth of words.
  - Fewer than 2 questions were asked AND no meaningful answer was given.
  DO NOT use this for a session that covered multiple questions with real answers — even if the session was short-ish (5-10 min) or covered only behavioral questions. If at least one real question has a real answer, score it (some dimensions may be N/A, see below).
  Return:
  {"insufficient": true, "reason": "<specific reason tied to what actually happened — e.g. 'Session ran 4 minutes and ended after the self-introduction; no follow-up question was reached.'>"}
  When insufficient=true, do NOT return dimensions or improvements.

(2) PER-DIMENSION N/A — the session HAD substantive content, but a specific dimension genuinely can't be judged from what was covered. Examples:
  - Only behavioral questions asked; no technical / JD-aligned problem → Role Fit is N/A.
  - Candidate only answered self-intro questions; no scoped problem to reason through → Depth & Reasoning is N/A.
  - Very short transcript snippets that don't reveal pacing/filler behavior → Communication is N/A.
  Set "score": null and use "justification" to explain what was missing. That dimension is excluded from the total. Other dimensions still get scored normally. This is preferred over the insufficient-overall escape hatch whenever there's enough content to score SOME dimensions. Do not use N/A to dodge a harsh score.

== OUTPUT (strict JSON, no prose wrapper) ==

Case A — insufficient overall:
{"insufficient": true, "reason": "<one sentence, specific>"}

Case B — normal scoring (with or without per-dimension N/As):
{
  "dimensions": [
    {"key": "question_addressing", "score": <0..25 or null>, "justification": "<one line, reference a moment OR explain why N/A>"},
    {"key": "specificity",         "score": <0..25 or null>, "justification": "..."},
    {"key": "depth",               "score": <0..20 or null>, "justification": "..."},
    {"key": "role_fit",            "score": <0..15 or null>, "justification": "..."},
    {"key": "communication",       "score": <0..15 or null>, "justification": "..."}
  ],
  "summary": "<1-2 sentence overall read>",
  "improvements": [
    "<actionable — name the moment>",
    "<second>",
    "<optional third>"
  ]
}

Justifications and improvements must reference SPECIFIC moments from the transcript (question numbers, phrases the candidate used, or gaps that stood out). Generic advice like "be more specific" is not acceptable — it must tie to something that actually happened.

Each justification under 25 words. Each improvement 1–2 sentences.`;

  const user = `=== JOB DESCRIPTION ===
${jd}
=== END JD ===

${resume ? `=== CANDIDATE RESUME ===
${resume}
=== END RESUME ===

` : ""}=== INTERVIEW TRANSCRIPT (questions + live commentary, in order) ===
${qaBlock}
=== END TRANSCRIPT ===

Session duration: ${Math.round(durationSeconds / 60)} minutes, ${mains.length} main question${mains.length === 1 ? "" : "s"} covered.

Score the interview. Return JSON only.`;

  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: {
      insufficient?: boolean;
      reason?: string;
      dimensions?: Array<{
        key?: string;
        score?: number | null;
        justification?: string;
      }>;
      summary?: string;
      improvements?: string[];
    } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          /* fall through to error */
        }
      }
    }

    // Case A: model flagged the transcript as insufficient for any verdict.
    if (parsed.insufficient) {
      const score: SessionScore = {
        total: 0,
        totalMax: 0,
        percent: 0,
        verdict: "insufficient_data",
        summary:
          (parsed.reason || "").trim() ||
          "The transcript didn't contain enough substantive content to form a judgment.",
        dimensions: DIMENSIONS.map((d) => ({
          key: d.key,
          label: d.label,
          max: d.max,
          score: null,
          justification: "Not judged — insufficient transcript content.",
        })),
        improvements: [],
      };
      return NextResponse.json({ score });
    }

    // Case B: per-dimension scores, any of which may be null (N/A).
    const dimensionsOut: SessionScore["dimensions"] = DIMENSIONS.map((d) => {
      const hit = parsed.dimensions?.find((x) => x.key === d.key);
      const raw = hit?.score;
      let score: number | null;
      if (raw === null || raw === undefined) {
        score = null;
      } else {
        const n = Number(raw);
        score = Number.isFinite(n)
          ? Math.max(0, Math.min(d.max, Math.round(n)))
          : null;
      }
      return {
        key: d.key,
        label: d.label,
        max: d.max,
        score,
        justification:
          (hit?.justification || "").trim() ||
          (score === null
            ? "Not assessable from this transcript."
            : "Not scored."),
      };
    });

    // Total = sum of judged dimension scores; totalMax = sum of judged max.
    let total = 0;
    let totalMax = 0;
    for (const d of dimensionsOut) {
      if (d.score === null) continue;
      total += d.score;
      totalMax += d.max;
    }

    // If the model returned N/A for EVERY dimension, that's effectively
    // "insufficient" — downgrade the verdict so the UI doesn't render a
    // misleading 0/0.
    const allNA = dimensionsOut.every((d) => d.score === null);
    if (allNA) {
      const score: SessionScore = {
        total: 0,
        totalMax: 0,
        percent: 0,
        verdict: "insufficient_data",
        summary:
          (parsed.summary || "").trim() ||
          "Every dimension came back not-assessable — transcript too thin to judge.",
        dimensions: dimensionsOut,
        improvements: [],
      };
      return NextResponse.json({ score });
    }

    const percent = totalMax > 0 ? Math.round((total / totalMax) * 100) : 0;
    const score: SessionScore = {
      total,
      totalMax,
      percent,
      verdict: verdictForPercent(percent),
      summary:
        (parsed.summary || "").trim() || "No overall summary produced.",
      dimensions: dimensionsOut,
      improvements: (parsed.improvements || [])
        .map((s) => (s || "").trim())
        .filter(Boolean)
        .slice(0, 3),
    };

    return NextResponse.json({ score });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/** Strips <strong>/<em> HTML from commentary so the model sees plain text. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}
