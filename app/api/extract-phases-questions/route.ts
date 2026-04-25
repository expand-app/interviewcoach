import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";
// Opus is slower than Sonnet — 10 min cap is plenty for even long
// recordings (typically 2-4 min actual).
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
 * Round 2 of the upload-mode analysis pipeline. Given the full
 * transcript (roles + timestamps), extract:
 *   - Interview Questions — every substantive Interviewer → Candidate
 *     ask, with timestamp and Lead/Probe relationship.
 *   - Phase segments — non-overlapping chunks covering the whole
 *     recording, labelled with what the conversation is DOING.
 *
 * Commentary + listening hints are produced by a separate endpoint in
 * the next round. Keeping this call focused keeps latency small and
 * lets us iterate on each piece independently.
 *
 * Single Sonnet call. Output is structured JSON consumed by the
 * LiveView's timeline renderer.
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

  const langClauseZh = ``;
  const langClauseEn = `Question text stays in English when the interviewer spoke English; in the original language when they spoke Chinese.`;

  const system = `You are extracting the QUESTION STRUCTURE and PHASE TIMELINE of a recorded interview. Given a transcript (utterances tagged with role + start time), you produce a JSON document describing:
  - every substantive question the interviewer asked the candidate, with timestamp + Lead/Probe relationship
  - a non-overlapping set of phase segments covering the whole recording

You do NOT produce commentary, coaching tips, or judgments here — only structure.

== TRANSCRIPT FORMAT ==
Each line is:  [index|mm:ss|I|C|?] text
where I = interviewer, C = candidate, ? = unknown speaker. mm:ss is the utterance's start time.

== OUTPUT (strict JSON, no prose wrapper) ==
{
  "questions": [
    {"id": "q1", "text": "Walk me through your last project.", "parentId": null, "askedAtSec": 312}
  ],
  "phases": [
    {"fromSec": 0, "kind": "chitchat"},
    {"fromSec": 32, "kind": "interviewer_asking_first"},
    {"fromSec": 58, "kind": "candidate_answering", "questionId": "q1"},
    {"fromSec": 412, "kind": "between_questions", "questionId": "q1"}
  ]
}

== QUESTIONS ==
Include every substantive interview question asked by the interviewer. Skip:
- Administrative pleasantries ("can you hear me?", "ready to start?", "do you have any questions before we start?").
- Candidate's own clarifying questions back to the interviewer. Those are NOT entries here.

A Lead Question opens a topic (parentId: null). A Probe Question drills into the most recent Lead (parentId: the lead's id).

Cleaning rules for the \`text\` field:
- Clean filler ("so uh", "okay so", "alright").
- Combine compound clauses into one coherent question.
- Rephrase collaborative / statement-style prompts into direct question form: "Let's start with the data" → "Can you start with the data?". Already-well-formed imperatives stay as-is ("Tell me about yourself").
- FIX obvious ASR homophone errors when the wrong word is clearly nonsensical in context and the intended word is a close phonetic match. Examples: "soft process" → "thought process", "sift system" → "system design". When in doubt, preserve the original.
- ${langClauseEn}${langClauseZh}

\`askedAtSec\` = the start time of the interviewer utterance where the question finalized (the last utterance of the question's build-up if they spoke in several short chunks).

== PHASES ==
Cover the ENTIRE recording with non-overlapping segments. First \`fromSec\` = 0. Each subsequent phase's \`fromSec\` is where the previous one ended.

Phase kinds:
- "chitchat": greetings, audio checks, administrative talk, or any other speech that shouldn't live in the question panel.
- "interviewer_asking_first": interviewer is mid-question and no Lead is locked in yet.
- "interviewer_probing": interviewer is asking a follow-up while a Lead is already locked in (populate \`questionId\` with the Lead's id).
- "candidate_answering": candidate has the floor, responding to a finalized question (populate \`questionId\`).
- "between_questions": candidate finished answering but a new question hasn't started yet — transition, elaboration, or interviewer providing context before the next probe (populate \`questionId\` with the most recent Lead).
- "candidate_asking": reverse-Q&A tail of the interview. The interviewer has finished asking their questions and explicitly turned the floor over ("any questions for me?", "what questions do you have?", "是你提问的时间了"), and the candidate is now asking the interviewer questions about the company, team, role, etc. Early-session clarifications by the candidate ("can you repeat that?") are NOT this phase — use "chitchat" for those. Only use "candidate_asking" once the interviewer has clearly handed off the floor.

Don't flap per-utterance. Group by "what is this chunk of conversation doing?" Make phases coherent segments that a human coach would recognize — typically 10–60 seconds each, not 2-second flickers.

ANCHORING RULE: once a Lead Question is set, don't accidentally demote it with every interviewer backchannel or candidate pause. Only transition out of a Lead's tree when the interviewer clearly pivots to a DIFFERENT topic/story.

Return JSON only. No prose outside the JSON.`;

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

Extract questions + phases. JSON only.`;

  try {
    // Opus 4.7 — stronger semantic judgment for deciding which
    // utterances are real interview questions vs. pleasantries, and
    // for drawing coherent phase boundaries. Slower than Sonnet, which
    // is why the overlay has a dedicated "analyzing" stage.
    const client = getAnthropicClient();
    const t0 = Date.now();
    console.log(
      `[extract-phases-questions] calling Opus · utterances=${utterances.length}`
    );
    const resp = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    });
    console.log(
      `[extract-phases-questions] Opus returned in ${Date.now() - t0}ms · output_tokens=${resp.usage?.output_tokens ?? "?"} stop_reason=${resp.stop_reason ?? "?"}`
    );

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: {
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

    // Normalize. Drop entries missing required fields rather than
    // inventing values — better to show less than show garbage.
    const questions = (parsed.questions || [])
      .filter(
        (q): q is { id: string; text: string; askedAtSec: number; parentId?: string | null } =>
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

    const phases = (parsed.phases || [])
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

    console.log(
      `[extract-phases-questions] questions=${questions.length} phases=${phases.length}`
    );

    return NextResponse.json({ questions, phases });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
