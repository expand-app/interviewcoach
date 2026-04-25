import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { getAnthropicClient } from "@/lib/anthropic-client";

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
  | "question_finalized"
  | "candidate_questioning";

type QuestionRelation = "new_topic" | "follow_up" | null;

interface ClassifyBody {
  utterances: Array<{ speaker: string; text: string }>;
  currentState: "idle" | MomentStateKind;
  msSinceLastTranscript: number;
  /** The currently displayed MAIN question (top of the bar). May be empty. */
  currentMainQuestionText?: string;
  /** The currently displayed follow-up sub-question, if any. */
  currentFollowUpText?: string;
  /** Mode selector. "classify" (default) runs the full state-machine. "confirm"
   *  takes a candidate question text and answers a focused binary check:
   *  is the interviewer really DONE asking this specific question right now,
   *  or are they still mid-setup? Used as Layer 2 of the question-lock
   *  multi-signal filter — a second independent call that has to agree with
   *  the primary classifier before the orchestrator commits the Lead. */
  mode?: "classify" | "confirm";
  /** For mode=confirm: the question text proposed by the primary classifier. */
  candidateQuestion?: string;
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
  const mode = body.mode === "confirm" ? "confirm" : "classify";
  const candidateQuestion = (body.candidateQuestion || "").trim();

  const client = getAnthropicClient();

  // === Layer 2 branch: confirmation-focused prompt ===
  // Runs in parallel with the main classifier. Asks ONE specific binary
  // question: given the transcript, is the interviewer genuinely DONE
  // asking the proposed question, or are they still setting up / the text
  // isn't actually a question they asked? Returns a confidence verdict
  // the orchestrator uses as the second signal before committing a Lead.
  if (mode === "confirm") {
    if (!candidateQuestion) {
      return NextResponse.json({
        verdict: "unknown",
        reason: "no candidate question supplied",
      });
    }
    const formatted = utterances
      .map((u) => `[${u.speaker}]: ${u.text}`)
      .join("\n");
    const confirmSystem = `You are a second-opinion verifier for an interview-assistant state machine. The primary classifier has proposed that the interviewer just finished asking the candidate a specific question. Your ONE job is to double-check that claim against the raw transcript.

Return ONE of these verdicts:
- "done" — the interviewer has genuinely finished asking this question, it's coherent, and the candidate can now answer.
- "still_setting_up" — the interviewer is mid-thought, trailing off, or still adding context. They are NOT done yet.
- "not_a_question" — the proposed text isn't a real interview question (e.g. administrative "can you hear me", meta-chatter, a declarative statement, or the candidate asking for clarification that was misattributed).

Be strict. A fragment that ends with "and", "so", "um", "uh", "let me think", "actually", or any transition word is NOT done. If the proposed question text does not match something the interviewer literally said in the transcript, return "not_a_question".

Output (strict JSON, no prose):
{ "verdict": "done" | "still_setting_up" | "not_a_question", "reason": "<one short line>" }`;

    const confirmUser = `Proposed question (from primary classifier):
"""
${candidateQuestion}
"""

Recent transcript:
"""
${formatted}
"""

Milliseconds since last transcript: ${msSinceLastTranscript}

Verdict?`;

    try {
      const resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: confirmSystem,
        messages: [{ role: "user", content: confirmUser }],
      });
      const text = resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();
      let parsed: { verdict?: string; reason?: string } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {
            /* ignore */
          }
        }
      }
      const verdict =
        parsed.verdict === "done" ||
        parsed.verdict === "still_setting_up" ||
        parsed.verdict === "not_a_question"
          ? parsed.verdict
          : "still_setting_up"; // conservative default
      const reason = (parsed.reason || "").trim();
      void logClassification({
        kind: "classify-moment-confirm",
        candidateQuestion,
        verdict,
        reason,
        raw: text,
      });
      return NextResponse.json({ verdict, reason });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return NextResponse.json(
        { verdict: "still_setting_up", reason: `confirm error: ${msg}` },
        { status: 500 }
      );
    }
  }

  const system = `You are the state machine for a live interview assistant. You read recent transcript turns and decide the current "moment" of the conversation, plus how any new question relates to the current one.

== WHAT COUNTS AS A QUESTION ==
This system tracks two kinds of interview questions, both ONLY from Interviewer → Candidate:
  • LEAD QUESTION — a main interview question that opens a topic. "Tell me about yourself.", "Walk me through your last project.", "Design a recommendation system for our homepage."
  • PROBE QUESTION — the interviewer drilling deeper into the current Lead Question. "Why did you choose that architecture?", "What data would you use?", "How did you measure success?"

The following are NOT Lead or Probe questions — they should NOT finalize and should keep the currently locked-in question on screen:
- Administrative / conversational asks from the interviewer, even if grammatically questions: "Do you have any questions before we start?", "Ready to begin?", "Can you hear me OK?", "Should we get started?", "Any issues with the setup?", "Does that make sense so far?", "Want to take a short break?". These are real utterances but they are not substantive interview questions.
- CANDIDATE-initiated clarification mid-answer: "Can you clarify what you mean by scale?", "Is it OK if I sketch this out?", "What kind of data can I use?" — these belong to "chitchat" (a small clarifying ask doesn't shift the phase). The Probe Question panel is STRICTLY interviewer → candidate.
- Meta-process chatter: "let me switch tabs", "one sec", "got it", "uh-huh".

NOTE: A SEPARATE state (candidate_questioning, see below) covers the reverse-Q&A tail of the interview, where the interviewer has finished their questions and explicitly hands the floor over ("any questions for me?") and the candidate now asks substantive questions about the team/role/process.

When in doubt about a non-question utterance, return state = "chitchat" so no question card is created.

== STATES ==
- "chitchat": nothing to surface. Small talk, greetings, intros, audio test, screen sharing chatter, administrative interviewer asks (see above), and isolated candidate-initiated clarifications mid-answer. NOT this if the candidate is delivering a substantive self-introduction in response to a "tell me about yourself" prompt.
- "interviewer_speaking": the interviewer is mid-question. Started but not finished. Any of these signal NOT YET DONE:
    • silence < 3 seconds
    • the latest interviewer utterance ends with "so", "and", "um", "uh", "let me think", "actually", "wait", or any other transition word
    • the accumulated interviewer text doesn't yet form a complete question (no clear interrogative or imperative request for information)
    • restarts or self-corrections ("so what I mean is...")
- "question_finalized": all of the following are true:
    1. msSinceLastTranscript >= 3000 OR the candidate has substantively started answering (>= 20 chars of first-person speech in the most recent turn), AND
    2. the accumulated interviewer text forms a complete, coherent question (interrogative or clear imperative ask), AND
    3. the question does NOT trail off into a transition word.
- "candidate_questioning": the reverse Q&A near the end of the interview. ALL of these must hold:
    1. The interviewer has clearly handed the floor over — explicit cue like "do you have any questions for me?", "any questions for us?", "anything you want to ask?", or "we have time for your questions" within the last few turns. OR the candidate has asked TWO consecutive substantive questions about the team/role/process and the interviewer has been answering them.
    2. The candidate's most recent utterance IS a substantive question to the interviewer about the role / team / company / process — NOT a one-off clarification embedded in their own answer. Examples: "What does the team look like?", "How does the team measure success?", "What's the day-to-day for this role?", "What are the biggest challenges the team is facing?", "How is the on-call rotation set up?", "What's the next step after this interview?".
    3. NOT a clarification of an interview question they're trying to answer ("Can you give me an example of what you mean by scale?" while mid-answer — that's chitchat).

Once in candidate_questioning, STAY in it across multiple back-and-forths (interviewer answers, candidate asks another) until ONE of:
    • the interviewer signals wrap-up: "well, that's about all the time we have", "thanks for your time", "we'll be in touch", "do you have any other questions?" followed by the candidate declining ("no, that's all", "no further questions"),
    • or the candidate stops asking questions and says goodbye / thanks.
At that wrap-up, return state = "chitchat".

Compound questions ("Can you tell me about X, and also Y?") count as ONE question still being formed until the interviewer clearly stops.

== ANCHORING (most important rule) ==
If currentMainQuestionText (the current Lead Question) is non-empty, be VERY conservative about disrupting it:

1. Interviewer probing on the same topic — clarification ("by X I mean Y"), drilling deeper ("can you give a specific example?", "what was the architecture?"), or a sub-question on the same story → questionRelation = "follow_up" (this is a Probe Question). This does NOT archive the Lead Question.
2. Candidate asking the interviewer a clarifying question mid-answer, going off-topic, or chatting → DON'T transition. Return state = "chitchat", questionRelation = null. Do NOT place the candidate's question into the Probe Question slot.
3. ONLY when the interviewer pivots to a clearly DIFFERENT topic / story / area set questionRelation = "new_topic":
   - Q1 was about Project A → interviewer asks about Project B → new_topic
   - Q1 was about technical decisions → interviewer asks about team management → new_topic
   - Q1 was about background → interviewer asks "let's do a case study" → new_topic
4. If a Probe Question has finalized (currentFollowUpText non-empty) and the interviewer drills further into the SAME sub-area, that's still "follow_up" (replacing the previous Probe Question).
5. When state transitions to candidate_questioning, questionRelation = null. The prior Lead is archived implicitly by the orchestrator (do NOT set "new_topic" for the candidate's question — that field is reserved for interviewer-asked Lead/Probe pivots).

== OUTPUT (JSON only, no prose) ==
{
  "state": "chitchat" | "interviewer_speaking" | "question_finalized" | "candidate_questioning",
  "summary": "<one short human-readable line for the UI top bar>",
  "question": "<cleaned question text — only when state=question_finalized, otherwise empty>",
  "candidateQuestion": "<cleaned candidate question text — only when state=candidate_questioning, otherwise empty>",
  "questionRelation": "new_topic" | "follow_up" | null
}

questionRelation guidance:
- When currentMainQuestionText is empty: this is the very first Lead Question, set questionRelation = "new_topic" (or null — both treated as a new Lead).
- When state is question_finalized + the new question text is identical/near-identical to currentMainQuestionText OR currentFollowUpText: questionRelation = null (it's the same question, no-op).
- When state is interviewer_speaking and you can already tell it's a topic shift, set questionRelation = "new_topic" so the orchestrator can move display state proactively. Otherwise null or "follow_up".
- When state is candidate_questioning: questionRelation = null always.

Summary writing style:
- chitchat: "Greeting and audio check"
- interviewer_speaking: short topic phrase, e.g. "asking about the recommendation model goal"
- question_finalized: omit or echo the question
- candidate_questioning: short topic phrase, e.g. "asking about team structure", "asking about next steps"

The "question" / "candidateQuestion" field, when present:
- Clean filler ("so uh", "okay so", "alright")
- Preserve the speaker's wording — don't paraphrase meaning
- Combine compound clauses into one coherent question
- FIX obvious speech-recognition errors where a word is clearly nonsensical in context and has a near-homophone that makes sense. Examples: "soft process" → "thought process", "sift system" → "system design", "hire ability" → "hireability", "sink about" → "think about", "resonating model" → "recommendation model". Only fix when the wrong word is genuinely meaningless in the sentence AND the intended word is a close phonetic match — when in doubt, preserve the original.
- For the interviewer "question" field: REPHRASE collaborative / statement-style prompts into direct question form addressed to the candidate. Examples: "Let's start with the data" → "Can you start with the data?". Keep already-well-formed imperatives as-is.
- For the candidate "candidateQuestion" field: keep the candidate's own phrasing — they're asking, so it's already a direct ask. Just clean filler and combine clauses.`;

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

  // Retry-with-exponential-backoff wrapper. classify-moment fires
  // every 2-3s, so even a 1% transient error rate produces visible
  // gaps in the state machine; 3 attempts with 500ms / 1500ms delays
  // catch the typical rate-limit / socket-blip / brief upstream outage
  // cases. 4xx (except 429) are NOT retried — they're parameter
  // problems that won't succeed a second time.
  async function callHaikuWithRetry() {
    const doCall = () =>
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }],
      });
    const BACKOFFS_MS = [500, 1500]; // delay before retry #1 and retry #2
    const MAX_ATTEMPTS = BACKOFFS_MS.length + 1; // 3
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
        const errBody = (e as { error?: unknown })?.error;
        console.warn(
          `[classify-moment] attempt ${attempt + 1}/${MAX_ATTEMPTS} failed:`,
          status,
          typeof errBody === "object"
            ? JSON.stringify(errBody).slice(0, 300)
            : String(errBody ?? e)
        );
        if (attempt < BACKOFFS_MS.length) {
          await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt]));
          continue;
        }
      }
    }
    // All attempts exhausted. Re-throw the last error so the outer
    // catch can log it + return a 500 to the client.
    throw lastErr;
  }

  try {
    const resp = await callHaikuWithRetry();

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: {
      state?: string;
      summary?: string;
      question?: string;
      candidateQuestion?: string;
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
      parsed.state === "question_finalized" ||
      parsed.state === "candidate_questioning"
        ? parsed.state
        : "chitchat";
    const summary = (parsed.summary || "").trim();
    const question =
      state === "question_finalized" ? (parsed.question || "").trim() : "";
    const respCandidateQuestion =
      state === "candidate_questioning"
        ? (parsed.candidateQuestion || "").trim()
        : "";
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
      candidateQuestion: respCandidateQuestion,
      questionRelation,
      raw: text,
    });

    return NextResponse.json({
      state,
      summary,
      question,
      candidateQuestion: respCandidateQuestion,
      questionRelation,
    });
  } catch (e) {
    // Log the full error body (not just status) so we can diagnose why
    // classify-moment fails. Previously the client log showed only
    // {"status":500}, which hid rate-limit reasons / prompt-length
    // errors / Anthropic outages behind a generic code.
    const status = (e as { status?: number })?.status;
    const errBody = (e as { error?: unknown })?.error;
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(
      "[classify-moment] call failed after retry:",
      status,
      msg,
      typeof errBody === "object"
        ? JSON.stringify(errBody).slice(0, 400)
        : String(errBody ?? "")
    );
    return NextResponse.json(
      {
        error: msg,
        status,
        body:
          typeof errBody === "object"
            ? JSON.stringify(errBody).slice(0, 400)
            : String(errBody ?? ""),
        state: "chitchat",
        summary: "",
        question: "",
        candidateQuestion: "",
        questionRelation: null,
      },
      { status: 500 }
    );
  }
}
