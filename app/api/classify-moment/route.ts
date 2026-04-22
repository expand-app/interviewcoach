import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { appendFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const DEBUG_LOG_PATH = path.join(process.cwd(), "debug-classifications.jsonl");
const DEBUG_ENABLED = process.env.NODE_ENV !== "production";

async function logClassification(entry: Record<string, unknown>) {
  if (!DEBUG_ENABLED) return;
  try {
    await appendFile(
      DEBUG_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
    );
  } catch {
    /* logging must never break the request */
  }
}

type MomentStateKind =
  | "chitchat"
  | "interviewer_speaking"
  | "question_finalized";

type QuestionRelation = "new_topic" | "follow_up" | null;

interface ClassifyBody {
  utterances: Array<{ speaker: string; text: string }>;
  currentState: "idle" | MomentStateKind;
  msSinceLastTranscript: number;
  /** The currently displayed MAIN question (top of the bar). May be empty. */
  currentMainQuestionText?: string;
  /** The currently displayed follow-up sub-question, if any. */
  currentFollowUpText?: string;
}

/**
 * The conversation state machine. Decides the moment + the relation between
 * any newly-detected question and the current main question.
 *
 * Stricter finalization than before:
 *   - Silence threshold raised to 3s
 *   - Candidate substantive-answer threshold lowered to 20 chars
 *   - Filler / transition words ("so...", "uh let me think", "and also...")
 *     do NOT count as the interviewer being done
 *   - Haiku must verify the accumulated interviewer text has a complete
 *     question structure before allowing question_finalized
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as ClassifyBody;
  const utterances = (body.utterances || []).filter((u) => u.text?.trim());
  if (utterances.length === 0) {
    return NextResponse.json({
      state: "chitchat",
      summary: "",
      question: "",
      questionRelation: null,
    });
  }
  const currentState = body.currentState || "idle";
  const msSinceLastTranscript = Number(body.msSinceLastTranscript) || 0;
  const currentMain = (body.currentMainQuestionText || "").trim();
  const currentFollowUp = (body.currentFollowUpText || "").trim();

  const client = new Anthropic({ apiKey });

  const system = `You are the state machine for a live interview assistant. You read recent transcript turns and decide the current "moment" of the conversation, plus how any new question relates to the current one.

== STATES ==
- "chitchat": small talk — greetings, intros, audio test ("can you hear me?"), screen sharing chatter. NOT this if the candidate is delivering a substantive self-introduction in response to a "tell me about yourself" prompt.
- "interviewer_speaking": the interviewer is mid-question. Started but not finished. Any of these signal NOT YET DONE:
    • silence < 3 seconds
    • the latest interviewer utterance ends with "so", "and", "um", "uh", "let me think", "actually", "wait", or any other transition word
    • the accumulated interviewer text doesn't yet form a complete question (no clear interrogative or imperative request for information)
    • restarts or self-corrections ("so what I mean is...")
- "question_finalized": all of the following are true:
    1. msSinceLastTranscript >= 3000 OR the candidate has substantively started answering (>= 20 chars of first-person speech in the most recent turn), AND
    2. the accumulated interviewer text forms a complete, coherent question (interrogative or clear imperative ask), AND
    3. the question does NOT trail off into a transition word.

Compound questions ("Can you tell me about X, and also Y?") count as ONE question still being formed until the interviewer clearly stops.

== ANCHORING (most important rule) ==
If currentMainQuestionText is non-empty, be VERY conservative about disrupting it:

1. Interviewer follow-up on the same topic — clarification ("by X I mean Y"), drilling deeper ("can you give a specific example?", "what was the architecture?"), or a sub-question on the same story → questionRelation = "follow_up". This does NOT archive the main question.
2. Candidate clarifying back, going off-topic, or chatting → DON'T transition. Stay in question_finalized, questionRelation = null.
3. ONLY when the interviewer pivots to a clearly DIFFERENT topic / story / area set questionRelation = "new_topic":
   - Q1 was about Project A → interviewer asks about Project B → new_topic
   - Q1 was about technical decisions → interviewer asks about team management → new_topic
   - Q1 was about background → interviewer asks "let's do a case study" → new_topic
4. If a follow-up has finalized (currentFollowUpText non-empty) and the interviewer drills further into the SAME sub-area, that's still "follow_up" (replacing the previous follow-up).

== OUTPUT (JSON only, no prose) ==
{
  "state": "chitchat" | "interviewer_speaking" | "question_finalized",
  "summary": "<one short human-readable line for the UI top bar>",
  "question": "<cleaned question text — only when state=question_finalized, otherwise empty>",
  "questionRelation": "new_topic" | "follow_up" | null
}

questionRelation guidance:
- When currentMainQuestionText is empty: this is the very first question, set questionRelation = "new_topic" (or null — both treated as new main).
- When state is question_finalized + the new question text is identical/near-identical to currentMainQuestionText OR currentFollowUpText: questionRelation = null (it's the same question, no-op).
- When state is interviewer_speaking and you can already tell it's a topic shift, set questionRelation = "new_topic" so the orchestrator can move display state proactively. Otherwise null or "follow_up".

Summary writing style:
- chitchat: "Greeting and audio check"
- interviewer_speaking: short topic phrase, e.g. "asking about the recommendation model goal"
- question_finalized: omit or echo the question

The "question" field, when present:
- Clean filler ("so uh", "okay so", "alright")
- Preserve the interviewer's wording — don't paraphrase
- Combine compound clauses into one coherent question`;

  const formatted = utterances
    .map((u) => `[${u.speaker}]: ${u.text}`)
    .join("\n");

  const user = `Recent transcript:
"""
${formatted}
"""

Current displayed state: ${currentState}
${currentMain ? `Current MAIN question: """${currentMain}"""` : "Current MAIN question: (none)"}
${currentFollowUp ? `Current FOLLOW-UP question: """${currentFollowUp}"""` : "Current FOLLOW-UP: (none)"}
Milliseconds since last transcript: ${msSinceLastTranscript}

Decide the moment. Be strict about finalization (3s silence or substantive 20-char answer + complete question structure). Apply the anchoring rule strictly when there is a locked-in question.`;

  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: {
      state?: string;
      summary?: string;
      question?: string;
      questionRelation?: string;
    } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
      }
    }

    const state: MomentStateKind =
      parsed.state === "chitchat" ||
      parsed.state === "interviewer_speaking" ||
      parsed.state === "question_finalized"
        ? parsed.state
        : "chitchat";
    const summary = (parsed.summary || "").trim();
    const question =
      state === "question_finalized" ? (parsed.question || "").trim() : "";
    const rel = parsed.questionRelation;
    const questionRelation: QuestionRelation =
      rel === "new_topic" || rel === "follow_up" ? rel : null;

    void logClassification({
      kind: "classify-moment",
      currentState,
      currentMain,
      currentFollowUp,
      msSinceLastTranscript,
      utteranceCount: utterances.length,
      state,
      summary,
      question,
      questionRelation,
      raw: text,
    });

    return NextResponse.json({ state, summary, question, questionRelation });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      {
        error: msg,
        state: "chitchat",
        summary: "",
        question: "",
        questionRelation: null,
      },
      { status: 500 }
    );
  }
}
