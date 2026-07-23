import { NextResponse } from "next/server";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";

/**
 * POST /api/retake/plan — generate the AI interviewer's script for a
 * Retake (mock interview) from a completed original session.
 *
 * The plan mirrors the ORIGINAL interview's structure — same topic
 * coverage, same style mix (behavioral / technical / case), follow-up
 * depth where the original interviewer probed — but with freshly
 * worded questions so the user can't just replay a memorized answer.
 *
 * One Sonnet call at retake start (the modal shows a loading state).
 * The client keeps the plan in memory for the whole call; it is not
 * persisted (refresh mid-retake loses the run — same contract as a
 * live session).
 */

interface PlanBody {
  jd: string;
  /** The resume the user just entered/updated in the RetakeModal. */
  resume?: string;
  interviewerProfileSummary?: string;
  originalQuestions: Array<{
    id?: string;
    text: string;
    parentQuestionId?: string;
    kind?: string;
    answerText?: string;
  }>;
}

export interface RetakePlanSlot {
  topic: string;
  style: string;
  question: string;
  allowFollowups: boolean;
}

export interface RetakePlan {
  language: "en" | "zh";
  /** The AI interviewer's display + spoken name (e.g. "Sarah Chen" /
   *  "王磊"). Taken from the original interviewer's profile when the
   *  name is known there, otherwise invented to fit the language. */
  interviewerName?: string;
  greeting: string;
  closing: string;
  slots: RetakePlanSlot[];
}

/** Cap on generated question slots — mirrors the original's lead
 *  count but a marathon original shouldn't produce an unusably long
 *  mock. */
const MAX_SLOTS = 12;

export async function POST(req: Request) {
  let body: PlanBody;
  try {
    body = (await req.json()) as PlanBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const jd = (body.jd ?? "").trim();
  const originals = body.originalQuestions ?? [];
  // Interviewer-kind lead questions define the structure we mirror.
  const leads = originals.filter(
    (q) => !q.parentQuestionId && q.kind !== "candidate"
  );
  if (!jd || leads.length === 0) {
    return NextResponse.json(
      { error: "jd and originalQuestions (with at least one lead) required" },
      { status: 400 }
    );
  }

  // Which leads had probes in the original — those slots allow
  // follow-ups in the mock too.
  const probedParents = new Set(
    originals
      .filter((q) => q.parentQuestionId)
      .map((q) => q.parentQuestionId as string)
  );

  // Build a compact structural sketch of the original interview for
  // the prompt: order + wording (for topic extraction — the model must
  // NOT reuse it) + a taste of the original answer for difficulty
  // calibration.
  const usedLeads = leads.slice(0, MAX_SLOTS);
  const sketch = usedLeads
    .map((q, i) => {
      const answerHint = (q.answerText ?? "").slice(0, 200);
      return `${i + 1}. "${q.text}"${answerHint ? `\n   (candidate's original answer began: "${answerHint}…")` : ""}`;
    })
    .join("\n");

  // A slot allows follow-ups when the original interviewer probed
  // that lead. When the client didn't send ids, default to allowing
  // follow-ups everywhere (the next-turn route still rations depth).
  const followupFlags = usedLeads.map((q) =>
    q.id ? probedParents.has(q.id) : true
  );

  const prompt = `You are designing a MOCK interview that lets a candidate re-practice a real interview they already completed.

# Job description
${jd.slice(0, 4000)}

${body.resume ? `# Candidate resume (updated)\n${body.resume.slice(0, 3000)}\n` : ""}
${body.interviewerProfileSummary ? `# Original interviewer\n${body.interviewerProfileSummary}\n` : ""}
# The original interview's questions, in order
${sketch}

# Per-question follow-up flags (true = the original interviewer asked follow-ups on this question)
${JSON.stringify(followupFlags)}

# Your task
Produce a JSON object with this exact shape:
{
  "language": "en" | "zh",          // the language the ORIGINAL questions are written in
  "interviewerName": string,        // the interviewer's name. The AI voice speaking it is FEMALE, so the name MUST be a natural female name fitting the language (e.g. "Sarah Chen" for en, "王婷" for zh). If the original interviewer's profile above clearly identifies a FEMALE interviewer's real name, use that; otherwise invent one. Never "Interviewer", never a male name.
  "greeting": string,               // 2-3 spoken sentences: greet the candidate, introduce yourself BY NAME (the interviewerName above) as the interviewer for this role, say you'll ask a series of questions. Natural, warm, professional. Will be read aloud by TTS.
  "closing": string,                // 1-2 spoken sentences wrapping up the interview and thanking them. No "any questions for me". Will be read aloud by TTS.
  "slots": [                        // EXACTLY one slot per original question above, same order
    {
      "topic": string,              // short label of what the original question was testing
      "style": string,              // "behavioral" | "technical" | "case" | "experience" | "motivation" | other short label
      "question": string,           // a NEW question testing the same topic/skill at the same difficulty — similar coverage, DIFFERENT wording and different specific scenario. Must NOT be answerable by reciting the original answer verbatim. 1-3 sentences, natural spoken phrasing (it will be read aloud).
      "allowFollowups": boolean     // copy the per-question flag from above
    }
  ]
}

Rules:
- Write greeting/closing/questions in "language" (match the original interview's language exactly).
- NEVER reuse the original question wording. Change the angle: if the original asked "tell me about a conflict with a PM", ask about a different interpersonal scenario testing the same competency.
- Keep the same overall difficulty and seniority bar as the original.
- Questions must be self-contained and speakable — no bullet lists, no "as mentioned above".
Return ONLY the JSON object, no markdown fences.`;

  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });
    const text =
      resp.content[0]?.type === "text" ? resp.content[0].text : "";
    // Tolerate accidental markdown fences.
    const jsonText = text
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const plan = JSON.parse(jsonText) as RetakePlan;

    // Minimal structural validation — a malformed plan must fail HERE
    // (modal shows Retry) and never reach the call view.
    if (
      (plan.language !== "en" && plan.language !== "zh") ||
      typeof plan.greeting !== "string" ||
      !plan.greeting.trim() ||
      typeof plan.closing !== "string" ||
      !Array.isArray(plan.slots) ||
      plan.slots.length === 0 ||
      plan.slots.some(
        (s) =>
          typeof s.question !== "string" ||
          !s.question.trim() ||
          typeof s.allowFollowups !== "boolean"
      )
    ) {
      console.warn("[retake/plan] structurally invalid plan:", jsonText.slice(0, 300));
      return NextResponse.json(
        { error: "plan generation produced invalid structure" },
        { status: 502 }
      );
    }
    plan.slots = plan.slots.slice(0, MAX_SLOTS);

    // Interviewer name is display-critical (the call UI shows it) but
    // not worth failing the whole plan over — fall back per language.
    if (
      typeof plan.interviewerName !== "string" ||
      !plan.interviewerName.trim()
    ) {
      // Female fallbacks — the realtime voice (marin) is female.
      plan.interviewerName = plan.language === "zh" ? "李静" : "Sarah Bennett";
    }
    plan.interviewerName = plan.interviewerName.trim().slice(0, 40);

    return NextResponse.json({ plan });
  } catch (e) {
    console.warn("[retake/plan] failed:", e);
    return NextResponse.json(
      { error: "plan generation failed" },
      { status: 502 }
    );
  }
}
