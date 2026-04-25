import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";
// Opus 4.7 with a full transcript + three artifact arrays is the
// heaviest call in the pipeline. 10 minutes cap covers even long
// recordings with extensive commentary to review.
export const maxDuration = 600;

interface ReviewBody {
  jd: string;
  resume?: string;
  lang: "en" | "zh";
  utterances: Array<{
    role: "interviewer" | "candidate" | "unknown";
    text: string;
    start: number;
    end: number;
  }>;
  questions: Array<{
    id: string;
    text: string;
    parentId?: string;
    askedAtSec: number;
  }>;
  phases: Array<{
    fromSec: number;
    kind: string;
    questionId?: string;
  }>;
  commentary: Array<{
    id: string;
    questionId: string;
    atSec: number;
    text: string;
  }>;
  listeningHints: Array<{
    id: string;
    atSec: number;
    text: string;
  }>;
}

/**
 * Round 4 of the upload-mode pipeline. After questions/phases/commentary
 * have been extracted in earlier rounds, this endpoint gives the whole
 * set to Sonnet ONE MORE TIME with the transcript, and asks it to
 * verify semantic coherence. If anything is off, it revises in place:
 *   - Drops extracted "questions" that are actually pleasantries or
 *     candidate clarifying asks.
 *   - Adds missed questions the extractor skipped.
 *   - Fixes Lead/Probe parenting.
 *   - Normalizes phase boundaries + kinds to match what's actually
 *     happening at each time range; ensures full coverage.
 *   - Verifies each commentary's atSec sits in its question's answer
 *     window and that the text actually reflects transcript content.
 *
 * Returns the final (corrected or unchanged) artifacts, plus a `notes`
 * field listing what was changed for diagnostic visibility.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as ReviewBody;
  const {
    jd,
    resume,
    lang,
    utterances,
    questions,
    phases,
    commentary,
    listeningHints,
  } = body;
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

  const langClauseZh = `评论语言:中文为主 + 英文关键词保留,跟输入一致。`;
  const langClauseEn = `Commentary language: English, technical terms preserved.`;

  const system = `You are a senior reviewer checking an automated interview analysis. Given the full transcript + the extracted questions, phases, and commentary, verify semantic coherence and output the FINAL (possibly revised) artifacts.

== YOUR JOB ==
Read the transcript. For each of the three artifacts, check:

QUESTIONS
- Every entry must be an actual substantive INTERVIEWER → CANDIDATE ask that appears in the transcript at or near \`askedAtSec\`.
- Drop pleasantries ("can you hear me?", "ready to start?") that were mistakenly kept.
- Drop candidate-initiated asks back to the interviewer (e.g. "can you clarify…?") — those are NOT interview questions.
- If the interviewer asked a substantive question that's MISSING from the list, add it with a plausible timestamp.
- Lead vs Probe: a probe drills into the same topic as a recent Lead. A new topic = new Lead (parentId: null).
- Text cleanup: keep the interviewer's wording but strip filler. Rephrase "Let's start with the data" into "Can you start with the data?". Fix obvious ASR homophones ("soft process" → "thought process") when the wrong word is nonsensical and the fix is a clear phonetic match.

PHASES
- Must cover [0, lastUtteranceEnd] with NO gaps and NO overlaps. First fromSec = 0.
- Each phase's kind must match what's actually happening in its time range:
  • chitchat = pleasantries, audio check, candidate clarifying asks, or other non-question-panel content
  • interviewer_asking_first = interviewer mid-question, no Lead locked yet
  • interviewer_probing = interviewer asking a follow-up while a Lead is active (set questionId)
  • candidate_answering = candidate has the floor answering a question (set questionId)
  • between_questions = candidate done, next question hasn't started (set questionId to most recent Lead)
- Coherent segments, not flicker. Typical phase length 10-60s. Don't fragment into micro-phases.
- Anchoring rule: once a Lead is set, don't accidentally demote it with every small interviewer backchannel. Only leave a Lead's tree on a clear topic shift.

COMMENTARY
- Each entry's \`questionId\` must point to an existing question.
- \`atSec\` should be DURING or right after the answer to that question (not before the question was asked, not long after the session moved on).
- The \`text\` must describe something that actually happened in the transcript — if the observation is generic or doesn't fit, fix or drop it.
- Ensure there's at least one commentary per substantive Lead answer. Add one if missing.
- When a resume is provided, commentary may cross-check claims or flag missed opportunities to invoke relevant resume experience.
- Don't introduce new commentary that wasn't implicitly warranted.
- ${lang === "zh" ? langClauseZh : langClauseEn}

LISTENING HINTS
- Each hint's \`atSec\` should sit at the END (or slightly after) of a substantive INTERVIEWER monologue — a stretch where the interviewer described the team, product, role, or set up a case without finalizing a question. One hint per monologue max.
- Text must coach the candidate on WHAT to extract from that monologue: what detail was dropped (team size / constraint / metric), why the interviewer brought it up, how to weave it into the next answer, or whether to acknowledge + ask clarifying questions first.
- Hints are NOT judgments of an answer — if a hint has slipped into evaluating the candidate's reply, rewrite it as a listening prompt or drop it.
- If the recording truly has no substantive interviewer monologue, hints can stay empty. Don't manufacture them.

== OUTPUT (strict JSON, no prose wrapper) ==
{
  "verdict": "clean" | "revised",
  "notes": "<1-2 sentences describing what changed, or 'no changes needed' if clean>",
  "questions": [ { "id": "q1", "text": "...", "parentId": null, "askedAtSec": 312 } ],
  "phases": [ { "fromSec": 0, "kind": "chitchat" } ],
  "commentary": [ { "id": "c1", "questionId": "q1", "atSec": 145, "text": "..." } ],
  "listeningHints": [ { "id": "h1", "atSec": 42, "text": "..." } ]
}

\`questions\`, \`phases\`, \`commentary\`, \`listeningHints\` are the FINAL arrays after any revisions you made. If verdict = "clean", they're identical to the input. Never omit these arrays.

Preserve existing IDs when possible. If you remove an entry, simply don't include it. If you add a new question or commentary, give it a fresh id ("q99", "c99" etc — any unique string) and keep existing ids stable.

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

=== CURRENT QUESTIONS ===
${JSON.stringify(questions, null, 2)}

=== CURRENT PHASES ===
${JSON.stringify(phases, null, 2)}

=== CURRENT COMMENTARY ===
${JSON.stringify(commentary, null, 2)}

=== CURRENT LISTENING HINTS ===
${JSON.stringify(listeningHints ?? [], null, 2)}

Review. If anything is off, revise it in the output arrays. JSON only.`;

  try {
    // Opus 4.7 for the review pass — this is where catching the
    // subtle miscategorizations matters most, and Opus's judgment is
    // materially better than Sonnet on nuanced semantic checks.
    const client = getAnthropicClient();
    const t0 = Date.now();
    console.log(
      `[review-timeline] calling Opus · utterances=${utterances.length} questions=${questions.length} phases=${phases.length} commentary=${commentary.length}`
    );
    const resp = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
    });
    console.log(
      `[review-timeline] Opus returned in ${Date.now() - t0}ms · output_tokens=${resp.usage?.output_tokens ?? "?"} stop_reason=${resp.stop_reason ?? "?"}`
    );

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: {
      verdict?: string;
      notes?: string;
      questions?: Array<{
        id?: string;
        text?: string;
        parentId?: string | null;
        askedAtSec?: number;
      }>;
      phases?: Array<{
        fromSec?: number;
        kind?: string;
        questionId?: string | null;
      }>;
      commentary?: Array<{
        id?: string;
        questionId?: string;
        atSec?: number;
        text?: string;
      }>;
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

    // Normalize the three output arrays the same way the two source
    // endpoints do. Invalid entries are dropped rather than patched.
    const outQuestions = (parsed.questions || [])
      .filter(
        (q): q is {
          id: string;
          text: string;
          parentId?: string | null;
          askedAtSec: number;
        } =>
          typeof q.id === "string" &&
          typeof q.text === "string" &&
          q.text.trim().length > 0 &&
          typeof q.askedAtSec === "number" &&
          isFinite(q.askedAtSec)
      )
      .map((q) => ({
        id: q.id,
        text: q.text.trim(),
        askedAtSec: Math.max(0, q.askedAtSec),
        parentId: q.parentId || undefined,
      }));

    const outPhases = (parsed.phases || [])
      .filter(
        (p): p is { fromSec: number; kind: string; questionId?: string | null } =>
          typeof p.fromSec === "number" &&
          isFinite(p.fromSec) &&
          typeof p.kind === "string"
      )
      .map((p) => ({
        fromSec: Math.max(0, p.fromSec),
        kind: p.kind,
        questionId: p.questionId || undefined,
      }))
      .sort((a, b) => a.fromSec - b.fromSec);

    const validQIds = new Set(outQuestions.map((q) => q.id));
    const outCommentary = (parsed.commentary || [])
      .filter(
        (c): c is { id: string; questionId: string; atSec: number; text: string } =>
          typeof c.id === "string" &&
          typeof c.questionId === "string" &&
          validQIds.has(c.questionId) &&
          typeof c.atSec === "number" &&
          isFinite(c.atSec) &&
          typeof c.text === "string" &&
          c.text.trim().length > 0
      )
      .map((c) => ({
        id: c.id,
        questionId: c.questionId,
        atSec: Math.max(0, c.atSec),
        text: c.text.trim(),
      }))
      .sort((a, b) => a.atSec - b.atSec);

    const outListeningHints = (parsed.listeningHints || [])
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

    const verdict = parsed.verdict === "clean" ? "clean" : "revised";
    const notes = (parsed.notes || "").trim();

    console.log(
      `[review-timeline] verdict=${verdict} · q=${questions.length}→${outQuestions.length} p=${phases.length}→${outPhases.length} c=${commentary.length}→${outCommentary.length} h=${(listeningHints ?? []).length}→${outListeningHints.length} · notes=${notes.slice(0, 200)}`
    );

    return NextResponse.json({
      verdict,
      notes,
      questions: outQuestions,
      phases: outPhases,
      commentary: outCommentary,
      listeningHints: outListeningHints,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
