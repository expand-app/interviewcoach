import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";
export const maxDuration = 300;

interface PreanalyzeBody {
  jd: string;
  resume?: string;
  lang: "en" | "zh";
  utterances: Array<{
    /** Role label. "interviewer" | "candidate" when known;
     *  "unknown" when Deepgram couldn't assign or pre-identify skipped. */
    role: "interviewer" | "candidate" | "unknown";
    text: string;
    /** Seconds from start of recording. */
    start: number;
    end: number;
  }>;
}

/**
 * Timeline produced for an uploaded recording — consumed by the live
 * view as the user scrubs through playback. Every entry is anchored to
 * a timestamp (in seconds from file start) so the UI can do a simple
 * "find the latest entry with atSec <= audio.currentTime" lookup.
 *
 * All natural-language output respects the user's selected lang ("en" or
 * "zh"). For "zh", commentary/hints are Chinese-with-English-keywords,
 * matching the Live Commentary style.
 */
interface Timeline {
  /** Questions asked during the recording. Ordered by askedAtSec.
   *  parentId links probe questions (follow-ups) back to their lead. */
  questions: Array<{
    id: string;
    text: string;
    parentId?: string;
    askedAtSec: number;
  }>;
  /** Commentary entries anchored to a moment + a question they apply
   *  to. The UI shows the latest entry where atSec <= currentTime. */
  commentary: Array<{
    id: string;
    questionId: string;
    atSec: number;
    text: string;
  }>;
  /** Listening hints anchored to a moment during interviewer monologues
   *  (setup, describing the team, elaborating). */
  listeningHints: Array<{
    id: string;
    atSec: number;
    text: string;
  }>;
  /** Phase segments. UI finds the one containing currentTime. */
  phases: Array<{
    fromSec: number;
    kind:
      | "chitchat"
      | "interviewer_asking_first"
      | "interviewer_probing"
      | "candidate_answering"
      | "between_questions"
      | "candidate_asking";
    /** Optional — which question this phase relates to (for
     *  interviewer_probing / candidate_answering / between_questions /
     *  candidate_asking). For candidate_asking, questionId points to the
     *  candidate's current question (from the questions array, with
     *  parentId referencing nothing — these are stored on the candidate
     *  side). */
    questionId?: string;
  }>;
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set" },
      { status: 500 }
    );
  }

  const body = (await req.json()) as PreanalyzeBody;
  const { jd, resume, lang, utterances } = body;

  if (!utterances || utterances.length === 0) {
    return NextResponse.json({ error: "No utterances" }, { status: 400 });
  }

  // Format the transcript with timestamps so the model can reference
  // specific moments by second-offset in its output. Using compact form
  // (mm:ss) to keep token count down for long recordings.
  const fmtTime = (s: number) => {
    const mm = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };
  const transcript = utterances
    .map((u, i) => {
      const role =
        u.role === "interviewer"
          ? "I"
          : u.role === "candidate"
          ? "C"
          : "?";
      return `[${i}|${fmtTime(u.start)}|${role}] ${u.text}`;
    })
    .join("\n");

  const langClauseZh = `全部文字输出都用中文为主 + 英文关键词 的风格(和 Live Commentary 一致):
- 产品 / 技术术语(recommendation model, feature store, A/B test, tradeoff, scope 等)→ 保留英文
- JD / 简历里的专有名词 → 保留原文
- 引用候选人原话 → 保留原语言
- 日常评价词(具体, 模糊, 清晰, 空洞, 跑题, 深入, 主动)→ 中文`;

  const langClauseEn = `Output all natural-language fields in English.`;

  const system = `You are an end-to-end interview coaching analyst. Given the FULL transcript of a recorded interview, you produce a structured coaching timeline: questions asked, commentary at each candidate answer, listening hints during interviewer monologues, and phase segments covering the whole recording.

== INPUTS ==
JD, optional resume, and a full transcript. Each line is formatted:
  [index|mm:ss|I|C|?] text
where I = interviewer, C = candidate, ? = unknown speaker. Index is the utterance index; mm:ss is the start time.

== OUTPUT (strict JSON, no prose wrapper) ==
{
  "questions": [
    {"id": "q1", "text": "Walk me through a tough engineering decision you made.", "parentId": null, "askedAtSec": 312}
  ],
  "commentary": [
    {"id": "c1", "questionId": "q1", "atSec": 340, "text": "…short observation…"}
  ],
  "listeningHints": [
    {"id": "h1", "atSec": 18, "text": "…short listening tip…"}
  ],
  "phases": [
    {"fromSec": 0, "kind": "chitchat"},
    {"fromSec": 32, "kind": "interviewer_asking_first"},
    {"fromSec": 58, "kind": "candidate_answering", "questionId": "q1"},
    {"fromSec": 412, "kind": "between_questions", "questionId": "q1"}
  ]
}

== RULES ==

QUESTIONS:
- Include every substantive interview question the interviewer asked the candidate.
- Skip pleasantries ("can you hear me?", "ready to start?", "do you have any questions before we start?") — these are NOT interview questions.
- Skip candidate clarifying questions to the interviewer — those are not Q&A items here.
- A Lead Question opens a topic (parentId: null). A Probe Question drills into the most recent Lead (parentId: lead's id).
- Rephrase collaborative prompts into clear question form ("Let's start with the data" → "Can you start with the data?"). Keep already well-formed imperatives ("Tell me about yourself") as-is.
- Fix obvious ASR homophones (e.g., "soft process" → "thought process") when the error is clear and the phonetic match is close.
- askedAtSec = start time of the interviewer's utterance where the question finalized.

COMMENTARY:
- Write 1–3 short observations per Lead Question (and optionally per Probe), each anchored to a specific moment in the candidate's answer.
- Tone: light, conversational, calibrated — coach sitting next to the candidate, not a panelist writing a debrief. Mix positive + neutral + critical across the session.
- Read the room: factor in interviewer reactions (laughs, "interesting", flat "okay", immediate re-asks, pivots to simpler questions). Don't take polite verbal feedback at face value — cross-check with behavior.
- Pronouns: "he" or "she" (pick one), not singular "they".
- Each comment 3–4 sentences (strict upper bound: ~70 words / ~450 characters, or ~150 Chinese characters — English terms don't count). Must fit in a FIXED display pane — anything longer will be clipped. Use the space to develop a point — name the moment, name the gap or strength, say what to do or watch for next. Don't pad; a single sharp sentence is fine when that's all there is.
- May use <strong>term</strong> to highlight 1–2 key terms. No markdown.
- atSec should be ~15–30 seconds after the moment being referenced, so the comment shows up when the UI reaches that time.

LISTENING HINTS:
- When the interviewer monologues for a meaningful stretch (≥ ~400 chars of continuous interviewer speech without a finalized question) — describing the team / setup / context — produce ONE listening tip coaching the candidate on what to catch, what the interviewer cares about, or how to pick up the thread.
- atSec should be ~mid-way through the monologue, so the tip is useful while the interviewer is still talking.
- Tone: tip, not judgment.

PHASES:
- Cover the ENTIRE recording with non-overlapping segments. First fromSec = 0. Each new phase's fromSec is where the previous one ended.
- "chitchat" — greetings, audio check, administrative talk, or candidate's own clarifying questions to the interviewer.
- "interviewer_asking_first" — interviewer is mid-question, no lead locked yet.
- "interviewer_probing" — interviewer is asking a follow-up to an already-locked lead (populate questionId with the lead's id).
- "candidate_answering" — candidate has the floor, responding to a finalized question (populate questionId).
- "between_questions" — candidate finished answering but no new question has started; small talk, transition, or interviewer elaborating on context (populate questionId with the most recent lead).
- "candidate_asking" — reverse-Q&A tail. Interviewer has finished their questions and explicitly turned the floor over ("any questions for me?", "what questions do you have?", "现在是你提问的时间"). Candidate is now asking the interviewer about the company, team, or role. Early-session candidate clarifications ("can you repeat?") are NOT this — they're "chitchat". Only use this phase once the interviewer has clearly handed off.
- Don't flap too quickly — group by "what is the conversation doing right now" in chunks, not per-utterance.

${lang === "zh" ? langClauseZh : langClauseEn}

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

Produce the coaching timeline as strict JSON.`;

  try {
    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    });

    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: Partial<Timeline> = {};
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

    // Coerce + defensively normalize. Missing fields become empty arrays
    // so the UI can still render without exploding.
    const timeline: Timeline = {
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      commentary: Array.isArray(parsed.commentary) ? parsed.commentary : [],
      listeningHints: Array.isArray(parsed.listeningHints)
        ? parsed.listeningHints
        : [],
      phases: Array.isArray(parsed.phases) ? parsed.phases : [],
    };

    return NextResponse.json({ timeline });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
