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
  | "interviewer_speaking"
  | "question_finalized"
  | "candidate_questioning"
  | "closing";

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
  /** For mode=confirm: true when the moment-state machine recently exited
   *  candidate_questioning (interviewer is mid-answer to the candidate's
   *  reverse Q). When set, the L2 verifier biases stricter — it knows
   *  the interviewer's syntactic-question fragments are likely rhetorical
   *  narration ("what are the default drivers?") rather than directed
   *  questions to the candidate. Set by the orchestrator within
   *  REVERSE_QA_LEAD_COOLDOWN_MS of the candidate_questioning exit. */
  priorWasCandidateQuestioning?: boolean;
  /** For mode=confirm: how long the live session has been running, in
   *  seconds. Used by the L2 verifier to relax the "still_setting_up"
   *  rejection in mature sessions — by minute 20+ of a real interview,
   *  the interviewer has been past the warm-up phase for a long time,
   *  and a clean "Where are you located?" / "How many years of X?"
   *  type question shouldn't be rejected as "still mid-setup". */
  sessionElapsedSec?: number;
  /** For mode=confirm: how many Lead questions have already locked in
   *  this session. ≥ 2 means the session is firmly past introductions —
   *  the L2 verifier should not be looking for setup-phase signals. */
  priorLeadCount?: number;
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
      state: "interviewer_speaking",
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
  const priorWasCandidateQuestioning =
    body.priorWasCandidateQuestioning === true;
  const sessionElapsedSec = Number(body.sessionElapsedSec) || 0;
  const priorLeadCount = Number(body.priorLeadCount) || 0;
  // "Mature" session: >20 min in AND ≥2 Leads have already locked.
  // Both conditions are required so brand-new sessions that just had
  // long monologues don't accidentally trigger this relaxation.
  // Maturity threshold: relaxes the L2 "still_setting_up" check
  // once the session is past the typical warm-up phase. Lowered
  // from `20 min + 2 leads` to `5 min + 1 lead` after observing
  // false rejections on classic mid-session questions:
  //   - Session ran 9 min, 1 lead locked (interviewer's role intro
  //     monologue covered minutes 1-9)
  //   - Interviewer pivoted: "Who are you? What drives you?
  //     But more importantly, what questions can I answer for you?"
  //   - Multi-sentence question with multiple "?" + trailing
  //     framing → L2 conservatively returned "still_setting_up"
  //   - Question got dropped, candidate's "tell me about yourself"
  //     answer was attached to the wrong (earlier) Q in scoring
  // After 5 min + 1 lead, the interviewer is firmly past
  // mic-check / role-intro and any complete short-form question
  // is genuinely a question, not setup.
  const sessionIsMature =
    sessionElapsedSec >= 5 * 60 && priorLeadCount >= 1;

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
    // We DELIBERATELY strip speaker tags ([Interviewer]/[Candidate]) from
    // the transcript here. Deepgram diarization mis-attributes routinely
    // (back-channel overlap, short utterances, accent variation). The L2
    // verifier was previously rejecting real interviewer questions just
    // because the question text happened to land on a [Candidate] line —
    // even with explicit prompt instructions to ignore the tag, the model
    // kept anchoring on it. Easier to remove the temptation entirely:
    // judge purely on question SHAPE + position in the transcript window.
    // (Primary classifier already considered speaker labels before
    // proposing the question, so no information is genuinely lost.)
    const formatted = utterances.map((u) => `- ${u.text}`).join("\n");
    const confirmSystem = `You are a second-opinion verifier for an interview-assistant state machine. The primary classifier has proposed that the interviewer just finished asking the candidate a specific question. Your ONE job is to double-check that claim against the raw transcript.

Return ONE of these verdicts:
- "done" — the interviewer has genuinely finished asking this question, it's coherent, and the candidate can now answer.
- "still_setting_up" — the interviewer is mid-thought, trailing off, or still adding context. They are NOT done yet.
- "not_a_question" — the proposed text isn't a real interview question (e.g. administrative "can you hear me", meta-chatter, a declarative statement, or the candidate asking for clarification that was misattributed).

Be strict. A fragment that ends with "and", "so", "um", "uh", "let me think", "actually", or any transition word is NOT done. If the proposed question text does not match something the interviewer literally said in the transcript, return "not_a_question".

CANONICAL OPENING / TRANSITION QUESTIONS — always "done" if the proposed text matches one of these (or a close paraphrase) AND ends with a question mark:
- "Tell me about yourself"
- "Walk me through your resume" / "Walk me through your background"
- "Who are you?" / "What drives you?" / "What makes you smile/happy?"
- "What do you like to do outside of work?"
- "Why this role?" / "Why are you interested in [Company/Team]?"
These are stock interview prompts — when the interviewer asks one, they're explicitly inviting a candidate response, regardless of what they say AFTER (they may stack additional framing like "and then we'll get to your questions" — that's NOT them still setting up the question, it's them previewing the next agenda item). If the proposed text is one of these, return "done".

CASE-STYLE PROMPTS WITH LONG SETUP — also always "done":
A common interview pattern is a multi-sentence case prompt where most of the volume is hypothetical setup ("Imagine you are X working at Y…", "Consider a scenario where…", "Let's say you're the PM for product Z…", "We've noticed that…", "Your goal is to…") and the actual ask is the LAST sentence ("How would you approach this?", "What would you do?", "Walk me through your analysis", "What's your hypothesis?", "How do you prioritize?"). The bulk-is-setup shape MUST NOT be classified as "still_setting_up" — the setup is the QUESTION, and the trailing interrogative IS the directed ask. As long as the proposed text:
  (a) ends with a clear interrogative clause (verb pattern like "how would you...", "what would you...", "walk me through...", "what's your...", or ends in "?"), AND
  (b) was followed by an audible end-of-thought (interviewer paused, candidate started answering, or msSinceLastTranscript > 1500),
return "done". Examples of case prompts that ARE "done":
- "Imagine you're a strategy analyst for the Postmates team. Order frequency declined 15% over 3 months. Your goal is to analyze and recommend solutions. How would you approach this?"
- "Consider a 2-sided marketplace where supply has dropped. What hypothesis would you test first?"
- "We've launched a new pricing tier. CTR is up but revenue per user is flat. Walk me through your diagnosis."

Distinguish from genuine "still_setting_up": that's when the interviewer is mid-sentence and just trailed off ("...so the question is — what would happen if..." with no closing verb), or stacks multiple competing asks without a final landed one ("...maybe what would happen, or maybe how you'd respond, or...").

TRANSCRIPT FORMAT NOTE — speaker labels are intentionally NOT shown:

The transcript below lists utterances in chronological order, one per line, with NO speaker labels. This is deliberate. The primary classifier has already considered which speaker said what before proposing this question; speaker diarization at the line level is unreliable (Deepgram mis-attributes routinely), so we removed those tags to prevent you from over-anchoring on them.

YOUR JOB: judge on QUESTION SHAPE alone — does the proposed text read as a directed interviewer ask to the candidate ("Tell me about…", "Walk me through…", "How would you…", "What would you…", "Why did you…", "Based on …, what would you …?", "What solutions would you propose…?", "How do we…?"), and is it complete (not trailing off in a transition word)?

You should NOT try to deduce speaker identity from the transcript. Specifically:
- DO NOT return "not_a_question" with a reason like "the proposed text was said by the candidate" — you have no reliable signal for that, and the primary classifier already verified speaker assignment.
- The presence of utterances after the proposed question is EXPECTED (the candidate responding, the interviewer adding a brief follow-up nudge). Don't read too much into who said the surrounding lines.

Return "not_a_question" ONLY when the CONTENT itself isn't a directed interview question — pure narration ("so the way we usually look at this is…"), a declarative summary ("yeah, that makes sense"), an obvious clarification of an active ask ("can you give me an example of what you mean by scale?"), or admin chatter ("can you hear me?").

Output (strict JSON, no prose):
{ "verdict": "done" | "still_setting_up" | "not_a_question", "reason": "<one short line>" }`;

    const reverseQaBias = priorWasCandidateQuestioning
      ? `

CRITICAL CONTEXT — REVERSE-Q&A AFTERMATH:
Just before this turn, the session was in the reverse-Q&A phase (candidate asking the interviewer questions, "any questions for me?"). The interviewer is currently in the middle of answering. Be EXTRA STRICT:

- Mid-answer speakers commonly use rhetorical fragments that are syntactically questions but contextually narration. Examples:
    "...so you have to wonder, what are the default drivers? Well, they're..."
    "...and what makes a loan get approved? It's a mix of..."
    "...the question is — what would they pay? Right? So..."
  These are NOT directed asks to the candidate; they're thinking out loud while answering. → "not_a_question".

- Only return "done" if the proposed text is a CLEAN landed ask (not a fragment embedded in surrounding narration). The transcript line containing the proposed question should look like the END of a turn — not surrounded above and below by sentences continuing the same topic without a clear pivot to "OK, your turn".

- When the proposed question text appears in the MIDDLE of what looks like a continuous monologue (more lines on the same topic follow it without a topic break), default to "not_a_question".`
      : "";

    const matureSessionBias = sessionIsMature
      ? `

CRITICAL CONTEXT — MATURE SESSION:
This session has been running for ${Math.floor(sessionElapsedSec / 60)} minutes and ${priorLeadCount} Lead questions have already locked. By this point in a real interview the interviewer is firmly past the "still setting up" phase — they've been asking and getting answers for a long time. Therefore:

- DO NOT return "still_setting_up" for short, complete questions like "Where are you located?" / "How many years of X?" / "Are you open to relocating?" / "When can you start?". These are typical late-interview wrap-up / logistics questions and they are GENUINELY done — the interviewer asks them and waits for an answer.

- "still_setting_up" should only fire here when the proposed text is itself an obvious fragment ending in a transition word ("and...", "so...", "um..."). A complete short question with a question mark or question word in a mature session is "done", not "still_setting_up".

- "not_a_question" still applies for rhetorical/narrative fragments mid-answer; the maturity bias does NOT relax that check.`
      : "";

    const confirmUser = `Proposed question (from primary classifier):
"""
${candidateQuestion}
"""

Recent transcript:
"""
${formatted}
"""

Milliseconds since last transcript: ${msSinceLastTranscript}${reverseQaBias}${matureSessionBias}

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
        priorWasCandidateQuestioning,
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
- CANDIDATE-initiated clarification mid-answer: "Can you clarify what you mean by scale?", "Is it OK if I sketch this out?", "What kind of data can I use?" — keep state at "interviewer_speaking" (a small clarifying ask doesn't shift the phase). The Probe Question panel is STRICTLY interviewer → candidate.
- Meta-process chatter: "let me switch tabs", "one sec", "got it", "uh-huh".

NOTE: A SEPARATE state (candidate_questioning, see below) covers the reverse-Q&A tail of the interview, where the interviewer has finished their questions and explicitly hands the floor over ("any questions for me?") and the candidate now asks substantive questions about the team/role/process.

When in doubt about a non-question utterance, return state = "interviewer_speaking" so no question card is created. Small talk, greetings, audio checks, brief acknowledgments, and administrative chatter all classify as "interviewer_speaking" — the question field stays empty and the orchestrator simply doesn't lock anything.

== STATES ==
- "interviewer_speaking": the interviewer is mid-question OR engaged in any non-substantive speech that shouldn't surface as a Question card. This is the catch-all for "speech happening, but no Question to lock yet". Includes:
    • Small talk, greetings, intros, audio test, screen sharing chatter
    • Administrative interviewer asks (see above) — "ready to begin?", "can you hear me?"
    • Isolated candidate-initiated clarifications mid-answer
    • Brief mutual acknowledgments ("yeah", "got it", "right") that don't rise to closing
    • The interviewer is genuinely mid-question but not yet done — any of these signal NOT YET FINALIZED:
    • silence < 3 seconds
    • the latest interviewer utterance ends with "so", "and", "um", "uh", "let me think", "actually", "wait", or any other transition word
    • the accumulated interviewer text doesn't yet form a complete question (no clear interrogative or imperative request for information)
    • restarts or self-corrections ("so what I mean is...")
- "question_finalized": all of the following are true:
    1. msSinceLastTranscript >= 3000 OR the candidate has substantively started answering (>= 20 chars of first-person speech in the most recent turn), AND
    2. the accumulated interviewer text forms a complete, coherent question (interrogative or clear imperative ask), AND
    3. the question does NOT trail off into a transition word.

  CLOSING-STYLE SUBSTANTIVE QUESTIONS — these ARE question_finalized, do NOT mis-route to interviewer_speaking or candidate_questioning. They appear at the end of an interview but ASK THE CANDIDATE to share something:
    • "Anything in particular that stood out about [Company]?" / "什么让你对我们 First Citizens 感兴趣?"
    • "What attracted you to this role / team?"
    • "What excites you most about this opportunity?"
    • "Any final thoughts you want to share?" / "Is there anything else you want us to know?"
    • "How did you hear about / come across the position?"
    • "What questions do you still have about the role / company?" — note: this is asking the candidate to articulate what they're curious about, which is a substantive ask. Distinguish from the pure hand-off "do you have any questions for me?".

  Critical distinction:
    • "Anything that stood out about us / what attracted you" → question_finalized. The candidate is supposed to ANSWER with their reasons / impressions. (Even if mixed with a hand-off offer like "or anything you want to ask" at the tail — pick the substantive ask, ignore the appended hand-off.)
    • "Do you have any questions for me?" / "Any questions for us?" → hand-off, leads into candidate_questioning when the candidate starts asking back. NOT question_finalized.
    • A monologue containing BOTH ("anything stood out + or any questions") → question_finalized with the "stood out" ask as the question text. The hand-off appendix is just the interviewer giving the candidate freedom to also raise questions.
- "closing": the interview is wrapping up — both sides are saying goodbye, thanking each other, or one side has clearly concluded ("that's about all the time we have", "thanks for your time, we'll be in touch", "have a good day"). Triggers when ANY of these patterns appear in the last few turns:
    • Mutual goodbye / thanks: interviewer says "thank you for your time" or "great conversation" or "we'll be in touch" or "have a good day" AND candidate says "thank you" / "have a good week" / "goodbye" / "talk to you later".
    • Explicit conclusion from interviewer: "that's all the time we have", "we're at time", "I'll let you go", "we have your contact info, we'll follow up".
    • Candidate signals end + interviewer accepts: candidate says "that's all my questions" / "no more questions from me" and interviewer responds with a closing pleasantry rather than another substantive question.
    • The session has been in candidate_questioning and the candidate just said "no more questions" / "that's all".
  Do NOT enter closing on a single polite "thanks" mid-interview — closing requires BOTH sides to be in the goodbye register, OR a clear "we're done" statement from the interviewer. If only one side is saying goodbye and the other might still continue, stay in the previous state.
- "candidate_questioning": the reverse Q&A near the end of the interview. ALL of these must hold:
    1. The interviewer has clearly handed the floor over — explicit cue like "do you have any questions for me?", "any questions for us?", "anything you want to ask?", or "we have time for your questions" within the last few turns. OR the candidate has asked TWO consecutive substantive questions about the team/role/process and the interviewer has been answering them.
    2. The candidate's most recent utterance IS a substantive question to the interviewer about the role / team / company / process — NOT a one-off clarification embedded in their own answer. Examples: "What does the team look like?", "How does the team measure success?", "What's the day-to-day for this role?", "What are the biggest challenges the team is facing?", "How is the on-call rotation set up?", "What's the next step after this interview?".
    3. NOT a clarification of an interview question they're trying to answer ("Can you give me an example of what you mean by scale?" while mid-answer — that stays interviewer_speaking).

  == ENTRY GATE for candidate_questioning (CRITICAL — read carefully, this rule has TWO opposite failure modes) ==

  **DECISION TREE** (apply in order — first match wins):

  **STEP 1 — Hand-off detected? (this OVERRIDES everything else, including case-style Lead Questions)**
  Scan the recent transcript for an EXPLICIT interviewer hand-off cue:
    - "do you have any questions for me?" / "any questions for me/us?"
    - "anything you want to ask?" / "anything else you want to chat about?"
    - "we have time for your questions" / "we have a few minutes for your questions"
    - "all (the) questions I have" / "I'm done with my questions, do you have any?"
    - "before we wrap up, any questions on your end?"
    - Variants like "or anything you want to chat about?" appended to a substantive question count too.

  If a hand-off cue exists in the recent transcript AND the candidate's most recent substantive utterance is ANY question to the interviewer (about ANY topic — role, team, process, logistics, even something that sounds case-related like "do you travel for work?"), → **state = candidate_questioning**. Populate candidateQuestion with the candidate's question text.

  **CRITICAL**: hand-off detection WINS even when currentMainQuestionText is a case-style Lead. Once the interviewer says "any questions for me?", the case is OVER — it doesn't matter what the prior Lead was. The candidate's questions are now reverse-Q&A. Do NOT apply the CASE-CLARIFICATION GUARD below in this branch.

  Why this matters: a real bug we hit was the interviewer wrapping up the case ("Cool. I think we covered a lot of ground. Do you have any questions for me?"), the candidate then asked 3 substantive role/process questions ("does this involve travel?", "when do you do data analysis?", "how do you handle unfamiliar domains?"), but the classifier stayed locked on the case Lead from 15 minutes earlier and kept returning state=question_finalized for 250 seconds. Hand-off detection MUST short-circuit case-mode immediately.

  **STEP 2 — No hand-off cue? Then apply CASE-CLARIFICATION GUARD.**
  When currentMainQuestionText starts with hypothetical setup like "Imagine you are…", "Consider a scenario…", "Let's say you're…", "We have noticed that…", "We've launched…", "Your goal is to…" or contains "how would you approach this?", the candidate is in case-solving mode. The candidate's playbook: (1) restate problem, (2) ask scoping clarifications ("is it across all users?", "what time horizon?", "specific to one geography?"), (3) frame approach, (4) walk through analysis. Steps (1)-(2) involve candidate questions to interviewer that are PART OF SOLVING THE CASE, not reverse-Q&A. → state = interviewer_speaking, candidateQuestion = "".

  **STEP 3 — No hand-off, not case-mid clarification? Apply general entry conditions.**
  To enter candidate_questioning here, ALL must hold:
    (a) The candidate has asked TWO consecutive substantive questions about role/team/process and the interviewer has been answering them — this implicitly establishes reverse-Q&A even without an explicit hand-off cue.
    (b) The candidate's most recent question is itself substantive about role/team/company/process/next-steps.
    (c) NOT a clarification of an interview question they're trying to answer.

  **STEP 4 — Otherwise stay in current state.**

  Symptoms of getting this wrong:
  - WRONG (case-clarification leak): case-style Lead is locked, candidate asks "is it specific to LA?", classifier transitions to candidate_questioning. → STEP 2 should have caught this (no hand-off → guard applies → stay interviewer_speaking).
  - WRONG (hand-off ignored): interviewer says "any questions for me?", candidate asks "does this involve travel?", classifier stays in question_finalized because the prior Lead was a case prompt. → STEP 1 should have caught this (hand-off cue present → transit to candidate_questioning regardless of case mode).

== STICKINESS RULE for candidate_questioning (CRITICAL) ==
If currentState is "candidate_questioning", the DEFAULT is to STAY in candidate_questioning. The interviewer answering the candidate's question — even at length, even with multiple paragraphs of detail — is the EXPECTED behavior in this phase, NOT a signal to exit. Do not exit just because the interviewer has been speaking for a while.

Only exit candidate_questioning when ONE of these is unambiguous in the recent transcript:

(1) NEW INTERVIEWER QUESTION TO CANDIDATE — interviewer explicitly opens a NEW substantive ask with cues like "let me ask you", "my next question is", "one more thing I want to ask you", "before we wrap up, can you tell me about", "actually one more question about your background", AND the question text is a real interview question (not a clarification or logistics ask). → state = question_finalized, questionRelation = "new_topic", populate the question field with the new ask. Do NOT exit on a vague "and/so/well" — needs an explicit re-asking cue.

(2) CANDIDATE EXPLICITLY ENDS Q&A — candidate says "no more questions" / "that's all from me" / "I think that's it" / "no further questions" / "I'm good, thanks". → state = "interviewer_speaking" (will progress to closing on its own as goodbyes follow).

(3) CANDIDATE ASKS A NEW QUESTION — candidate's most recent substantive utterance is itself a new question to the interviewer (about role / team / process / company). → STAY in candidate_questioning, just update the candidateQuestion field to the new text. This is NOT an exit; it's a refresh inside the same phase.

(4) MUTUAL GOODBYE — both sides are saying "thank you" / "have a good day" / "we'll be in touch". → state = "closing".

OUTSIDE these four cases: regardless of how long the interviewer talks, regardless of disfluency or filler density, regardless of whether the interviewer changes sub-topic mid-answer (e.g. starts talking about loan size after answering remote-work) — the interviewer is STILL answering the candidate's question. Stay in candidate_questioning. Refresh the summary field if useful, keep the candidateQuestion text the same.

Symptom of getting this wrong: a session in candidate_questioning where the interviewer is mid-explanation gets transit'd to "interviewer_speaking" with summary like "Asking about candidate's location" or "Discussing team flexibility" — those are NOT new questions, they're the interviewer continuing to answer.

Compound questions ("Can you tell me about X, and also Y?") count as ONE question still being formed until the interviewer clearly stops.

== ANCHORING (most important rule) ==
If currentMainQuestionText (the current Lead Question) is non-empty, classify the relation between any new interviewer question and the locked Lead. Default to "new_topic" when in doubt — a probe is a TIGHT extension of the SAME story / artifact / decision the candidate is currently answering, NOT a related but distinct topic.

1. "follow_up" — interviewer drilling DEEPER into the EXACT subject the candidate is currently describing. Tight scope. Examples (assume Lead Q = "Tell me about the recommendation model you built"):
   - "Why did you choose collaborative filtering over content-based?" → follow_up (drilling into the same model's design choice)
   - "What was the click-through rate before vs after?" → follow_up (asking for metrics on the same artifact)
   - "Can you walk me through the cold-start handling?" → follow_up (sub-component of the same model)
   - "What dataset did you train it on?" → follow_up (still about the same model)

   Bar: the new question would be NONSENSICAL without the candidate's current answer as context. If the new question still makes sense as a standalone interview question, it's NOT a follow-up.

2. "new_topic" — interviewer pivots to ANY of:
   - a different artifact / project / experience (Lead Q was Model A → asks about Model B → new_topic, even if both are ML models)
   - a different domain (Lead Q was modeling techniques → asks about tech stack / Python / SQL → new_topic, even though both are technical)
   - a different competency (Lead Q was technical work → asks about career goals / motivations / soft skills → new_topic)
   - a different time horizon (Lead Q was "current role" → asks about "past internships" or "school projects" → new_topic)
   - a meta-shift (Lead Q was about candidate's experience → asks "let's do a case study" → new_topic)

   Concrete bad/good calibration (for the kinds of mistakes this prompt has been making):
   - Lead Q = "Can you speak about what techniques were used in the PD model?"
     - Interviewer next: "Is that mostly Python or ML?" → **new_topic** (tech stack is a different domain from modeling techniques). NOT follow_up.
     - Interviewer next: "What made you interested in banking?" → **new_topic** (motivation/career, different competency). NOT follow_up.
     - Interviewer next: "Any particular projects across data science and quant finance you found interesting?" → **new_topic** (different artifacts, broader scan). NOT follow_up.
     - Interviewer next: "What features did you engineer for that PD model?" → follow_up (deeper into the SAME PD model — passes the "nonsensical without context" bar).
     - Interviewer next: "How did you validate the PD model's calibration?" → follow_up (same model, deeper).

3. Candidate asking the interviewer a clarifying question mid-answer, going off-topic, or chatting → DON'T transition. Return state = "interviewer_speaking", questionRelation = null. Do NOT place the candidate's question into the Probe Question slot.

4. If a Probe Question has finalized (currentFollowUpText non-empty) and the interviewer drills further into the SAME sub-area, that's still "follow_up" (replacing the previous Probe Question).

5. When state transitions to candidate_questioning, questionRelation = null. The prior Lead is archived implicitly by the orchestrator (do NOT set "new_topic" for the candidate's question — that field is reserved for interviewer-asked Lead/Probe pivots).

== OUTPUT (JSON only, no prose) ==
{
  "state": "interviewer_speaking" | "question_finalized" | "candidate_questioning" | "closing",
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
- Format: short gerund / verb phrase, max ~8 words. NO pronouns
  ("their", "his", "her", "the candidate's"). When a subject is needed
  for clarity, use "Candidate" or "Interviewer" as a bare noun.
- Bad:  "Candidate introducing their background"
- Good: "Candidate introducing background and credentials"
- Good: "Self-introduction in progress"
- Bad:  "Interviewer asking about his project"
- Good: "Interviewer asking about the project"
- Good: "Asking about the recommendation model goal"
- interviewer_speaking: short topic phrase. Examples: "asking about the recommendation model goal" (mid-question), "Greeting and audio check" (small talk), "Acknowledging response" (brief ack)
- question_finalized: omit or echo the question
- candidate_questioning: short topic phrase, e.g. "asking about team structure", "asking about next steps"

The "question" / "candidateQuestion" field, when present:
- Clean filler ("so uh", "okay so", "alright")
- Combine compound clauses across utterances into one coherent question
- FIX obvious speech-recognition errors where a word is clearly nonsensical in context and has a near-homophone that makes sense. Examples: "soft process" → "thought process", "sift system" → "system design", "hire ability" → "hireability", "sink about" → "think about", "resonating model" → "recommendation model". Only fix when the wrong word is genuinely meaningless in the sentence AND the intended word is a close phonetic match — when in doubt, preserve the original.

== VERBATIM-PHRASING RULE (CRITICAL — read this before writing the question field) ==

The downstream filter REJECTS proposed questions whose tokens don't appear in the
interviewer's actual recent speech. Aggressive paraphrasing into "standard interview
question" form (e.g. "Tell me about yourself", "Design a recommendation system for X")
will be discarded and the question will NEVER be locked, even though the interviewer
clearly asked it. This has caused entire 4-minute self-introductions and 6-minute
case-study setups to fire ZERO commentary.

Therefore:

1. **Use the interviewer's actual content words** (nouns, verbs, named entities) in the
   question text. Do NOT swap in synonyms, do NOT replace casual phrasing with textbook
   form, do NOT compress informal asks into a canonical question they didn't actually say.

2. **Only minimally rephrase** to make the sentence grammatical / standalone. Allowed:
   adding "Can you" / "Could you" in front of an imperative, joining two interviewer
   utterances, dropping fillers. Disallowed: replacing the interviewer's keywords with
   "standard" interview-vocabulary equivalents.

3. **Concrete bad/good calibration** (these match real failure modes — internalize them):

   Interviewer actually said: "Sure. Let's start with yourself intro maybe."
   - BAD:  "Tell me about yourself."  ← "tell"/"about" never said → filter rejects, Q never locks
   - BAD:  "Can you give a self-introduction?"  ← invented "give"/"self-introduction"
   - GOOD: "Can you start with yourself intro?"  ← uses actual words "start"/"yourself"/"intro"
   - GOOD: "Yourself intro maybe?"  ← even closer to verbatim, also fine

   Interviewer actually said (across utterances): "we want to recommend several items
   for the user … design a feature of this. How are you gonna give the results and
   recommendations to a particular user."
   - BAD:  "Design a recommendation system for Walmart."  ← invented "system", "Walmart"
           context comes from JD not transcript → filter rejects
   - BAD:  "How would you build a recommendation engine for Walmart's homepage?"
           ← invented "engine", "homepage"
   - GOOD: "How are you gonna give the results and recommendations to a particular user?"
           ← uses interviewer's actual phrasing
   - GOOD: "Design a feature to recommend several items for the user — how are you going
           to give the results?"  ← combines two of the interviewer's utterances verbatim

   Interviewer actually said: "Let's discuss a little bit on that. So for feature
   engineering, how are we gonna deal with the all the data we have right now."
   - GOOD: "For feature engineering, how are we going to deal with all the data we have?"
   - BAD:  "Walk me through your feature engineering pipeline."  ← invented standard phrasing

4. **Imperative → question conversion** still allowed when the interviewer used a clear
   imperative ("Let's start with the data" → "Can you start with the data?"). But preserve
   the noun phrase the interviewer used ("the data") — do NOT inflate it into a fuller
   "data sources" / "data schema" / etc.

5. **Compound questions across multiple utterances**: combining is fine and often
   necessary, but the combined sentence's content words must come from the interviewer's
   own utterances. Do NOT bridge with new vocabulary the interviewer never used.

6. **For the candidate "candidateQuestion" field**: keep the candidate's own phrasing
   — they're asking, so it's already a direct ask. Just clean filler and combine clauses.
   Same verbatim-phrasing rule applies.

== CANDQ-ATTRIBUTION RULE (CRITICAL — read this before populating candidateQuestion) ==

candidateQuestion MUST be text that the CANDIDATE actually spoke in the recent
transcript. NEVER paraphrase or pull text from interviewer turns.

The most common failure mode: when the interviewer hands the floor over with
"Any questions for me?" / "What questions do you have?" / "Fire away.", the
state should transition to candidate_questioning, but candidateQuestion MUST
be left empty UNTIL the candidate has actually asked their first question. Do
NOT echo the interviewer's hand-off line into candidateQuestion. The phase bar
in the UI displays this field as the candidate's question — putting the
interviewer's words there is a visible attribution bug.

Concrete examples (these match real failure modes — internalize them):

  Interviewer actually said: "What questions do you have for me?"
  Candidate has not yet spoken anything substantive.
  → state: "candidate_questioning"
  → candidateQuestion: ""  ← LEAVE EMPTY. Do NOT write "What questions do you have for me?"

  Interviewer said: "Fire away."
  Candidate said (next turn): "I read the JD. Huntington emphasized balance
  sheet management — what's the biggest ALM challenge facing the bank?"
  → state: "candidate_questioning"
  → candidateQuestion: "What's the biggest ALM challenge facing the bank?"
    ← Use the candidate's words.

  Interviewer is mid-answer to a candidate question. Candidate hasn't started a
  new question yet.
  → state: "candidate_questioning" (sticky)
  → candidateQuestion: <unchanged from last commit — keep the prior candidate
    question text, don't replace with anything from the interviewer's answer>

If the [speaker] tags in the transcript don't make speaker attribution
unambiguous (rare but possible after diarization noise), prefer leaving
candidateQuestion empty over guessing — the UI will show a generic "candidate
preparing question" placeholder, which is better than displaying the
interviewer's words as if the candidate said them.

When you're tempted to "tidy up" the interviewer's wording into a more polished interview
question, RESIST. The filter doesn't care about polish; it cares about token overlap with
what was actually said. Preserve the speaker's words.`;

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

    // Backward-compat: accept legacy "chitchat" output from any
    // pre-merge classifier responses still in flight; map it to
    // "interviewer_speaking" (the merge target — see types/session.ts
    // MomentStateKind comment). Fallback default is also interviewer_speaking.
    const rawState =
      parsed.state === "chitchat" ? "interviewer_speaking" : parsed.state;
    const state: MomentStateKind =
      rawState === "interviewer_speaking" ||
      rawState === "question_finalized" ||
      rawState === "candidate_questioning" ||
      rawState === "closing"
        ? rawState
        : "interviewer_speaking";
    const summary = (parsed.summary || "").trim();
    const question =
      state === "question_finalized" ? (parsed.question || "").trim() : "";
    let respCandidateQuestion =
      state === "candidate_questioning"
        ? (parsed.candidateQuestion || "").trim()
        : "";
    // Server-side guard against the model echoing interviewer hand-off
    // lines into candidateQuestion. Even with the explicit
    // CANDQ-ATTRIBUTION rule in the prompt, Haiku occasionally fills
    // candQ with the interviewer's "what questions do you have" text
    // when the candidate hasn't asked yet. Compare candQ against the
    // recent interviewer utterances; if there's clear text overlap,
    // clear it — the UI is better off showing a placeholder than
    // mis-attributing speech.
    if (respCandidateQuestion) {
      const norm = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim();
      const candNorm = norm(respCandidateQuestion);
      // Pull recent interviewer utterances from the input transcript.
      // `utterances` is the full sample the classifier saw; entries
      // with role "interviewer" are the ones to check against.
      const interviewerSpeech = utterances
        .filter((u) => u.speaker === "interviewer")
        .map((u) => norm(u.text))
        .join(" ");
      // Any 5+ word verbatim chunk of candQ appearing inside
      // interviewer speech is enough to flag attribution as wrong.
      const candTokens = candNorm.split(/\s+/).filter(Boolean);
      if (candTokens.length >= 5) {
        const window = 5;
        let matched = false;
        for (let i = 0; i <= candTokens.length - window; i++) {
          const chunk = candTokens.slice(i, i + window).join(" ");
          if (chunk && interviewerSpeech.includes(chunk)) {
            matched = true;
            break;
          }
        }
        if (matched) {
          console.warn(
            "[classify-moment] candidateQuestion overlaps interviewer speech; clearing",
            { candQ: respCandidateQuestion }
          );
          respCandidateQuestion = "";
        }
      }
    }
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
        state: "interviewer_speaking",
        summary: "",
        question: "",
        candidateQuestion: "",
        questionRelation: null,
      },
      { status: 500 }
    );
  }
}
