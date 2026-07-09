import { NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";

/**
 * POST /api/mock-interviewer/next-turn — the AI interviewer's brain
 * for one turn of a Retake (mock interview).
 *
 * Called after the candidate finishes answering the current question.
 * Decides between:
 *   - "followup": probe the answer (only when the slot allows it and
 *     depth < 2 and the answer left a concrete thread worth pulling)
 *   - "next": brief acknowledgment + the next planned question
 *   - "wrapup": we're past the last slot — the controller plays the
 *     plan's closing script (utterance is ignored for wrapup)
 *
 * The client treats ANY failure of this route as {action: "next"}
 * with the next slot's pre-generated question verbatim — the plan is
 * the script of last resort; the interview never stalls.
 */

interface NextTurnBody {
  jd: string;
  resume?: string;
  language: "en" | "zh";
  planSlots: Array<{
    topic: string;
    style: string;
    question: string;
    allowFollowups: boolean;
  }>;
  currentSlotIndex: number;
  /** What was actually asked (the planned lead or a generated followup). */
  currentQuestionText: string;
  followupDepth: number; // 0 | 1 | 2
  candidateAnswer: string;
  recentTranscript?: Array<{
    speaker: "interviewer" | "candidate";
    text: string;
  }>;
}

interface NextTurnResult {
  action: "followup" | "next" | "wrapup";
  utterance: string;
  nextSlotIndex?: number;
}

export async function POST(req: Request) {
  let body: NextTurnBody;
  try {
    body = (await req.json()) as NextTurnBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const {
    jd,
    language,
    planSlots,
    currentSlotIndex,
    currentQuestionText,
    followupDepth,
    candidateAnswer,
  } = body;

  if (!planSlots?.length || typeof currentSlotIndex !== "number") {
    return NextResponse.json(
      { error: "planSlots and currentSlotIndex required" },
      { status: 400 }
    );
  }

  const slot = planSlots[currentSlotIndex];
  const nextSlot = planSlots[currentSlotIndex + 1];
  const isLastSlot = currentSlotIndex >= planSlots.length - 1;
  const canFollowup =
    !!slot?.allowFollowups &&
    followupDepth < 2 &&
    (candidateAnswer ?? "").trim().length >= 40;

  // Degenerate cases decided without a model call: nothing to probe
  // and nothing next → wrapup; can't probe → next with the planned
  // question. Saves latency + tokens on the common "move along" path
  // ONLY when probing isn't even on the table.
  if (!canFollowup) {
    if (isLastSlot) {
      return NextResponse.json({
        result: { action: "wrapup", utterance: "" } satisfies NextTurnResult,
      });
    }
    // Still use the model for a natural transition + possible light
    // rephrase referencing the conversation — but with a fallback if
    // it fails, the client uses nextSlot.question verbatim anyway.
  }

  const transcript = (body.recentTranscript ?? [])
    .slice(-12)
    .map((t) => `${t.speaker === "interviewer" ? "YOU" : "CANDIDATE"}: ${t.text}`)
    .join("\n");

  const prompt = `You are a professional interviewer running a live mock interview (spoken, voice-based). Decide your next move and produce EXACTLY what you will say next.

# Role you are hiring for
${(jd ?? "").slice(0, 2000)}

# Current question you asked (follow-up depth ${followupDepth})
"${currentQuestionText}"

# Candidate's answer (verbatim transcript, may have speech artifacts)
"${(candidateAnswer ?? "").slice(0, 3000)}"

# Recent conversation
${transcript || "(none)"}

# Remaining planned questions
${
  nextSlot
    ? `Next planned question: "${nextSlot.question}" (topic: ${nextSlot.topic})`
    : "(none — this was the last planned question)"
}

# Decision rules
- May you ask a follow-up now? ${canFollowup ? "YES (at most one more level)" : "NO (move on)"}
- Follow up ONLY if the answer left a specific, concrete thread worth probing (a claim without evidence, an interesting decision, a vague area the role cares about). A complete, well-evidenced answer → move on.
- When moving on: 1 short natural acknowledgment sentence, then ask the next planned question. You may lightly rephrase it to connect to the conversation, but keep its topic and difficulty identical.
- When this was the last planned question and you're not following up → action "wrapup" (utterance empty).
- Speak in ${language === "zh" ? "Chinese" : "English"}. Natural spoken style — it will be read aloud by TTS. No lists, no stage directions, no quotes around the question.

Return ONLY JSON: {"action": "followup" | "next" | "wrapup", "utterance": string, "nextSlotIndex": number}
- action "followup": utterance = your follow-up question (with a brief natural lead-in), nextSlotIndex = ${currentSlotIndex}
- action "next": utterance = acknowledgment + next question, nextSlotIndex = ${currentSlotIndex + 1}
- action "wrapup": utterance = "", nextSlotIndex = ${currentSlotIndex}`;

  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text =
      resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const jsonText = text
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const parsed = JSON.parse(jsonText) as NextTurnResult;

    // Sanitize: clamp the model's choice to what the rules allow so a
    // rogue "followup" at depth 2 can't loop the interview forever.
    let action = parsed.action;
    if (action === "followup" && !canFollowup) {
      action = isLastSlot ? "wrapup" : "next";
    }
    if (action === "next" && isLastSlot) action = "wrapup";
    const result: NextTurnResult = {
      action,
      utterance:
        action === "wrapup" ? "" : (parsed.utterance ?? "").trim(),
      nextSlotIndex:
        action === "next" ? currentSlotIndex + 1 : currentSlotIndex,
    };
    // An empty utterance on a non-wrapup action is useless — tell the
    // client to fall back to the planned script.
    if (result.action !== "wrapup" && !result.utterance) {
      return NextResponse.json(
        { error: "empty utterance from model" },
        { status: 502 }
      );
    }
    return NextResponse.json({ result });
  } catch (e) {
    console.warn("[next-turn] failed:", e);
    return NextResponse.json({ error: "next-turn failed" }, { status: 502 });
  }
}
