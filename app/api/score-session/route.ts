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

  // Schema detection. Two cases route to "legacy" (= grade from coach
  // notes only):
  //
  //   (1) PURE LEGACY — sessions saved before commit b2de823, where no
  //       Question has an `answerText` field at all. The model's only
  //       evidence is the in-flight coach commentary.
  //
  //   (2) BUCKETING-BUG VICTIMS — sessions saved between b2de823 and
  //       the live-append fix, which had `answerText` fields but the
  //       end-of-session bucketing read from a rolling 30-entry
  //       `liveUtterances` window. On a 20+ minute session, all but
  //       the final ~30 candidate utterances had been evicted, so only
  //       the LAST question got any answer text. We detect this by
  //       comparing answer-evidence vs. coach-note-evidence: if coach
  //       notes have substantive content (≥3 Qs with ≥60 chars each)
  //       but answer text doesn't, the answer-text channel was broken
  //       — fall back to legacy path so the session can score against
  //       the rich coach notes instead of insufficient-ing on empty
  //       answers.
  //
  // Without (2), users with bucketing-bugged sessions hit "Re-score"
  // and get the same `insufficient_data` over and over even though
  // the coach notes contain plenty of gradable signal.
  const naivelyLegacy = mains.every(
    (q) => typeof q.answerText !== "string"
  );
  const qsWithAnswerEvidence = questions.filter(
    (q) =>
      typeof q.answerText === "string" && q.answerText.trim().length >= 60
  ).length;
  const qsWithCommentEvidence = questions.filter(
    (q) =>
      q.comments.reduce(
        (s, c) => s + stripTags(c.text).trim().length,
        0
      ) >= 60
  ).length;
  const looksBucketingBugged =
    !naivelyLegacy &&
    qsWithAnswerEvidence < 3 &&
    qsWithCommentEvidence >= 3;
  const isLegacySchema = naivelyLegacy || looksBucketingBugged;
  if (looksBucketingBugged) {
    console.log(
      "[score-session] schema-mismatch detected — forcing legacy path:",
      {
        qsWithAnswerEvidence,
        qsWithCommentEvidence,
      }
    );
  }

  // Build the per-question block. Two formats:
  //   - Modern schema: ANSWER (verbatim candidate speech) is primary,
  //     COACH NOTES are corroborating colour.
  //   - Legacy schema: skip ANSWER lines entirely (they'd all just say
  //     "not recorded") and lead with COACH NOTES as the sole evidence.
  //     The system prompt tells the model to grade legacy sessions from
  //     coach observations.
  const fmtAnswer = (q: Question): string => {
    const a = (q.answerText ?? "").trim();
    if (a.length === 0) {
      return "  ANSWER: (no candidate speech attributed to this question)";
    }
    const trimmed = a.length > 8000 ? a.slice(0, 8000) + "…" : a;
    return `  ANSWER: ${trimmed}`;
  };

  const fmtCommentBlock = (
    q: Question,
    indent: "  " | "    "
  ): string => {
    if (q.comments.length === 0) {
      return `${indent}COACH NOTES: (none)`;
    }
    const header = isLegacySchema
      ? `${indent}COACH NOTES (the coach's in-flight observations are the primary evidence for this session — see scoring rules):`
      : `${indent}COACH NOTES (in-flight commentary, may include interviewer-reaction reads):`;
    const bullets = q.comments
      .map((c) => `${indent}  · ${stripTags(c.text)}`)
      .join("\n");
    return `${header}\n${bullets}`;
  };

  const qaBlock = mains
    .map((m, i) => {
      const blockHeader = `Q${i + 1}. ${m.text}`;
      const answerLine = isLegacySchema ? "" : "\n" + fmtAnswer(m);
      const commentLines = "\n" + fmtCommentBlock(m, "  ");
      const probes = followUps.get(m.id) ?? [];
      const probeBlock = probes
        .map((p) => {
          const head = `\n  ↳ PROBE: ${p.text}`;
          const probeAns = isLegacySchema ? "" : "\n  " + fmtAnswer(p);
          const probeCmt = "\n" + fmtCommentBlock(p, "    ");
          return head + probeAns + probeCmt;
        })
        .join("");
      return blockHeader + answerLine + commentLines + probeBlock;
    })
    .join("\n\n");

  // Aggregate stats — keyed differently per schema. Modern sessions are
  // judged by candidate-speech volume; legacy sessions by the volume of
  // substantive coach observations (since that IS the evidence). The
  // "questionsWithEvidence" stat is a single number the prompt can use
  // to gate INSUFFICIENT regardless of schema. Reuse the per-Q counts
  // we computed above for schema detection.
  const totalAnswerChars = questions.reduce(
    (sum, q) =>
      sum + (typeof q.answerText === "string" ? q.answerText.trim().length : 0),
    0
  );
  const totalCommentChars = questions.reduce(
    (sum, q) =>
      sum +
      q.comments.reduce(
        (s, c) => s + stripTags(c.text).trim().length,
        0
      ),
    0
  );
  const questionsWithAnswers = qsWithAnswerEvidence;
  const questionsWithSubstantiveComments = qsWithCommentEvidence;
  // Single number the prompt's INSUFFICIENT gate keys on, regardless
  // of schema. For modern: how many Qs had a real answer. For legacy:
  // how many Qs had real coach notes.
  const questionsWithEvidence = isLegacySchema
    ? questionsWithSubstantiveComments
    : questionsWithAnswers;
  const totalEvidenceChars = isLegacySchema
    ? totalCommentChars
    : totalAnswerChars;

  // Server-side diagnostics so when the user files a bug (e.g. "scoring
  // came back insufficient on a 32-min session") we can see exactly
  // what the route received without round-tripping the user. Logged
  // once per request, INFO level. Includes a 200-char preview of the
  // first question's content (Q text + ANSWER + first comment) so we
  // can sanity-check the shape end-to-end.
  const firstMain = mains[0];
  const firstPreview = firstMain
    ? [
        `Q: ${firstMain.text}`,
        firstMain.answerText
          ? `A: ${firstMain.answerText.slice(0, 80)}`
          : "A: (no answerText)",
        firstMain.comments[0]
          ? `C: ${stripTags(firstMain.comments[0].text).slice(0, 80)}`
          : "C: (no comments)",
      ].join(" | ")
    : "(no questions)";
  console.log(
    "[score-session] payload:",
    JSON.stringify({
      schema: isLegacySchema ? "legacy" : "modern",
      durationSeconds,
      mainQuestions: mains.length,
      totalAnswerChars,
      totalCommentChars,
      questionsWithAnswers,
      questionsWithSubstantiveComments,
      questionsWithEvidence,
      totalEvidenceChars,
      jdLen: jd.length,
      resumeLen: (resume || "").length,
      firstPreview: firstPreview.slice(0, 200),
    })
  );

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

== TRANSCRIPT STRUCTURE ==
The transcript comes in one of TWO schemas. The user message tells you which.

(A) MODERN SCHEMA — each question has both ANSWER and COACH NOTES:
  - ANSWER: the candidate's verbatim speech captured during the time window between this question and the next. PRIMARY ground truth for grading. May be filler-heavy or disfluent — that's real speech; score Communication accordingly.
  - COACH NOTES: in-flight observations a coach made WHILE the answer was being given. SECONDARY colour, useful for interviewer-reaction reads ("interviewer laughed", "pivoted to simpler Q") and for sanity-checking the ANSWER content. Do NOT score the coach's opinion — score the candidate's speech.

(B) LEGACY SCHEMA — only COACH NOTES are present (sessions saved before per-question answer capture landed):
  - COACH NOTES are the PRIMARY evidence. Treat them as authoritative observations from a senior coach who watched the interview live and is now describing what the candidate said. They typically reference specific content the candidate produced ("named RF / logistic / LightGBM", "story about the manager wanting a simple model", "caught coefficient sign reversed against business logic"), interviewer reactions, and quality-of-delivery signals (filler, pacing, structure).
  - For legacy sessions, you grade DIRECTLY from COACH NOTES. There is no separate ANSWER stream to wait for. A session with 5 substantive coach notes is roughly equivalent to a modern session with 5 graded answers — both contain enough signal to score the rubric.
  - Do NOT bail to insufficient just because ANSWER lines are absent — that's the schema, not the data quality.

If the answer is short or fragmented but on-topic, that's normal. Don't conflate disfluency with lack of substance. Filler ("like", "you know", "kind of") doesn't lower the content score; it lowers the Communication score.

== WHEN THERE ISN'T ENOUGH TO JUDGE ==
Honesty over false confidence. The bar is HIGH for insufficient — it should be rare, reserved for genuinely empty transcripts. Two cases — draw the line carefully:

(1) INSUFFICIENT OVERALL — the transcript has almost NO content to work with. Use ONLY when the session stats in the user message satisfy ALL of:
  - questionsWithEvidence < 3 (fewer than 3 questions had substantive evidence — either ≥60 chars of ANSWER for modern, or ≥60 chars of coach notes for legacy)
  - totalEvidenceChars < 1000 (less than ~1000 chars of total gradable content)
  - The session reads as audio setup / chitchat / immediate disconnect, NOT as a real Q&A
  ALL THREE must be true. If even ONE is false, do NOT return insufficient — score whatever you have, with per-dimension N/A as needed.

  Concrete: a 30-minute session with 5 main questions and 1500+ chars of coach notes describing real candidate content (projects, methods, stories, named techniques) is NEVER insufficient. Score it. The model running on a banking quant interview that mentions "RF / LightGBM / logistic regression", "negative income coefficient sign reversed", "XGBoost on commercial loans", "model documentation 2500 pages", and "challenger model" has plenty to grade — those are technical content references, not generic platitudes.

  Return when insufficient applies (only):
  {"insufficient": true, "reason": "<specific reason tied to actual stats — e.g. 'Session ran 90 seconds with one self-introduction question and no candidate answer captured (totalEvidenceChars=0).'>"}
  When insufficient=true, do NOT return dimensions or improvements.

(2) PER-DIMENSION N/A — the session HAD substantive content, but a specific dimension genuinely can't be judged from what was covered. Examples:
  - Only behavioral questions asked; no technical / JD-aligned problem → Role Fit is N/A.
  - Candidate only answered self-intro questions; no scoped problem to reason through → Depth & Reasoning is N/A.
  - Communication can almost ALWAYS be judged when COACH NOTES exist — they describe filler, pacing, clarity directly.
  Set "score": null and use "justification" to explain what was missing. That dimension is excluded from the total. Other dimensions still get scored normally. This is preferred over the insufficient-overall escape hatch whenever there's enough content to score SOME dimensions. Do NOT use N/A to dodge a harsh score — if there's evidence to grade, grade it.

  Coach-note-derived grading (legacy schema) — explicit cues to use:
  - "三个模型点出来了" / "named X, Y, Z" → Specificity has evidence (named tools/methods)
  - "story about ___" / "concrete project ___" → Specificity + Question Addressing have evidence
  - "filler 太多" / "rambled" / "重复" → Communication signal (negative)
  - "pivot 到了 X" / "redirected to ___" → Question Addressing signal (negative — didn't answer what was asked)
  - "面试官 reactions 平淡" / "interviewer pivoted to simpler Q" → Read-the-room negative signal
  - "面试官 'great point' + deeper follow-up" → Read-the-room positive signal
  - "caught X / sharp finding" → Depth + Specificity positive
  Each note typically gives signal on 2-3 dimensions; aggregate across notes for a dimension to land its score.

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

  const schemaLine = isLegacySchema
    ? "Schema: LEGACY (coach notes only — grade directly from observations; do NOT mark insufficient just because ANSWER lines are absent)"
    : "Schema: MODERN (ANSWER + COACH NOTES — grade primarily from ANSWER, COACH NOTES are corroborating)";

  const transcriptLabel = isLegacySchema
    ? "questions + coach notes (in order)"
    : "questions + candidate answers + coach notes (in order)";

  const user = `=== JOB DESCRIPTION ===
${jd}
=== END JD ===

${resume ? `=== CANDIDATE RESUME ===
${resume}
=== END RESUME ===

` : ""}=== INTERVIEW TRANSCRIPT (${transcriptLabel}) ===
${qaBlock}
=== END TRANSCRIPT ===

Session stats:
- Duration: ${Math.round(durationSeconds / 60)} minutes
- Main questions: ${mains.length}
- ${schemaLine}
- questionsWithEvidence: ${questionsWithEvidence} (questions with ≥ 60 chars of ${isLegacySchema ? "coach notes" : "answer text"})
- totalEvidenceChars: ${totalEvidenceChars}

INSUFFICIENT gate: requires questionsWithEvidence < 3 AND totalEvidenceChars < 1000 AND session reads as setup/disconnect. If any of those is false, score the rubric.

Score the interview. Return JSON only.`;

  // Diagnostic: log the rough prompt size before firing. Sonnet 4.5
  // handles ~200K input tokens but the bigger risk is route latency at
  // ~5K-tokens-per-1K-chars rates → 30s+ generation on huge prompts.
  // Helps explain a hang as "too big" rather than "API down".
  const systemChars = system.length;
  const userChars = user.length;
  const estTokens = Math.ceil((systemChars + userChars) / 3.5);
  console.log("[score-session] calling Sonnet:", {
    systemChars,
    userChars,
    estTokens,
    schema: isLegacySchema ? "legacy" : "modern",
  });

  try {
    const client = getAnthropicClient();
    const t0 = Date.now();
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: user }],
    });
    console.log("[score-session] Sonnet returned in", Date.now() - t0, "ms");

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    if (!text) {
      // Empty model output — would otherwise silently fall through to
      // allNA and surface as "insufficient_data" with no diagnostic.
      // Better to fail loudly so the client retries.
      console.error("[score-session] empty model output");
      return NextResponse.json(
        {
          error: "Scoring model returned empty output. Try Re-score.",
          status: 502,
        },
        { status: 502 }
      );
    }

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
    // Defensive: parsed.dimensions could come back as a non-array (model
    // wrote prose, returned null, etc.). Normalize before downstream
    // .find() / .every() which would crash.
    if (parsed.dimensions !== undefined && !Array.isArray(parsed.dimensions)) {
      console.warn(
        "[score-session] parsed.dimensions is not array, ignoring:",
        typeof parsed.dimensions
      );
      parsed.dimensions = undefined;
    }

    // Case A: model flagged the transcript as insufficient for any verdict.
    // We construct the summary explicitly from the stats we computed
    // server-side so the user sees concrete numbers ("only X questions with
    // evidence, Y chars total") instead of a generic "too thin to judge".
    // The model's own `reason` is included as additional context when
    // present.
    if (parsed.insufficient) {
      const statsLine = isLegacySchema
        ? `Captured ${mains.length} main question${mains.length === 1 ? "" : "s"} and ${questionsWithSubstantiveComments} with substantive coach notes (${totalCommentChars} chars total). Full scoring needs ≥ 3 questions with ≥ 60 chars of notes each, totaling ≥ 1000 chars.`
        : `Captured ${mains.length} main question${mains.length === 1 ? "" : "s"} and ${questionsWithAnswers} with substantive candidate answers (${totalAnswerChars} chars total). Full scoring needs ≥ 3 answered questions totaling ≥ 1000 chars of candidate speech.`;
      const modelReason = (parsed.reason || "").trim();
      const summary = modelReason
        ? `${statsLine} Model: ${modelReason}`
        : statsLine;
      const score: SessionScore = {
        total: 0,
        totalMax: 0,
        percent: 0,
        verdict: "insufficient_data",
        summary,
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
    // misleading 0/0. Same stats-keyed summary as the explicit
    // insufficient branch so the user sees what the route actually had
    // to work with.
    const allNA = dimensionsOut.every((d) => d.score === null);
    if (allNA) {
      const statsLine = isLegacySchema
        ? `Captured ${mains.length} main question${mains.length === 1 ? "" : "s"} and ${questionsWithSubstantiveComments} with substantive coach notes (${totalCommentChars} chars total). The model judged none of the rubric dimensions assessable from this content.`
        : `Captured ${mains.length} main question${mains.length === 1 ? "" : "s"} and ${questionsWithAnswers} with substantive candidate answers (${totalAnswerChars} chars total). The model judged none of the rubric dimensions assessable from this content.`;
      const modelSummary = (parsed.summary || "").trim();
      const summary = modelSummary
        ? `${statsLine} Model: ${modelSummary}`
        : statsLine;
      const score: SessionScore = {
        total: 0,
        totalMax: 0,
        percent: 0,
        verdict: "insufficient_data",
        summary,
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
