import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";

export const runtime = "nodejs";
// Analysis is a single Opus call with a large context (full log +
// transcript). 3 minutes is plenty; requests have timed out at 60s
// on Vercel free, so we bump the ceiling.
export const maxDuration = 300;

interface AnalyzeBody {
  log?: string;
  transcript?: string;
  /** Optional user comments pinned to timestamps — give the analyzer
   *  the context of what the human reviewer already flagged. */
  userComments?: Array<{ time: string; text: string }>;
}

interface Finding {
  severity: "high" | "medium" | "low";
  category:
    | "classify"
    | "commentary"
    | "listening-hint"
    | "warmup"
    | "filter"
    | "roles"
    | "ui"
    | "prompts"
    | "other";
  at: string;           // mm:ss timestamp
  title: string;        // one-line summary
  what: string;         // what went wrong
  why: string;          // root-cause diagnosis
  suggested_fix: string; // concrete code-level or config-level suggestion
}

/**
 * Auto-diagnose an Interview Coach session.
 *
 * Given the debug log (events + timestamps) and the transcript (what
 * was actually said), an Opus-4.7 pass identifies behavioral bugs and
 * coaching-quality issues in the orchestrator. Returns a structured
 * list the user can review and selectively export to Claude Code for
 * implementation.
 *
 * This is the "auto-improvement" feedback loop the user asked for:
 * each session can be auto-analyzed → findings reviewed → approved
 * fixes get implemented. Over many sessions, the diagnosed patterns
 * accumulate into measurable improvements.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as AnalyzeBody;
  const log = (body.log || "").trim();
  const transcript = (body.transcript || "").trim();
  if (!log) {
    return NextResponse.json({ error: "missing log" }, { status: 400 });
  }

  const client = getAnthropicClient();

  const system = `You are an expert QA engineer for "Interview Coach", a live
coaching app that listens to interviews and overlays real-time AI
commentary. Your job is to REVIEW A SESSION and identify APP BUGS
and COACHING-QUALITY ISSUES — not critique the candidate or
interviewer, critique THE APP.

== APP ARCHITECTURE (context) ==

Speech pipeline:
- Deepgram nova-3 live streaming with diarize=true, language=multi.
- Utterances come in with a raw dgSpeaker number (0/1/2).
- Users manually tag one speaker via popup → the other is auto-
  assigned the opposite role.

State machine (per-utterance):
- classify-moment (Haiku) decides: chitchat / interviewer_speaking /
  question_finalized, with a questionRelation (new_topic / follow_up / null).
- When question_finalized fires, a 4-layer filter gates the commit:
  L0: reject-cache for repeat hallucinations
  L1: text grounding — Q tokens must appear in recent interviewer
      transcript (≥50% overlap)
  L2: parallel Haiku "is this really a question or still setup?" verdict
  L3: 3-second continuation gate — interviewer must go silent for 3s
- Restatement gate: within 10s of a Lead commit, similar Qs are dropped
  to avoid double-locking (Jaccard ≥ 0.5).

Coaching outputs:
- Q-A Commentary: fires when candidate accumulates 450+ chars of answer
  on a locked Q. Escalating threshold per Q, cap at 5 commentaries.
- Listening Hint: fires when interviewer monologues 250+ chars with no
  locked Q, or during interviewer_speaking transitions. Only shown when
  Q-A minMs expired AND state is interviewer_speaking.
- Warm-up Commentary: fires when candidate talks before any Lead has
  ever locked (self-intro phase only — one-time, never re-enters).
- All three update a shared reading-protection state: new coaching is
  gated by computeReadingTimeMs(prev) so users have time to read.

== INPUTS YOU'LL RECEIVE ==

A session transcript (interviewer/candidate utterances, timestamps)
and the full debug event log (classify requests/responses, moment
transits, filter decisions, commentary / listening-hint / warmup fires,
role assignments, API errors). If the human reviewer pinned comments
to specific timestamps, those are included too.

== WHAT TO LOOK FOR ==

App-level issues, not content critique:

1. MISCLASSIFICATIONS: Q locked with wrong text / wrong question; phase
   stuck on chitchat when a clear Q was asked; classifier wobbling
   between states without real change; listening hint firing when
   candidate is actually answering.
2. DUPLICATE / OVERLAPPING Qs: same Q committed twice (restatement
   gate missed it); probe committed as new Lead; new Lead committed
   while previous is still active and relevant.
3. MISSED COACHING: candidate talked at length about something
   important and NO commentary fired; interviewer revealed a key
   detail (team size, tech stack, red flag) and NO listening hint
   fired; warm-up phase passed without warmup commentary.
4. WRONG-CONTEXT COACHING: commentary attached to wrong Q / stale Q;
   commentary addressing something the candidate didn't say; hint
   referencing content from a previous session phase.
5. API / STREAMING FAILURES: classify 500s not recovered; listening
   hint ECONNRESET not retried (if it shows, the retry should have
   covered it); commentary half-streamed then died.
6. ROLE / TRANSCRIPTION: candidate tagged as interviewer or vice versa
   for extended stretches; dg speaker split into duplicate IDs without
   the auto-merge catching it.
7. UI / TIMING ISSUES: reading-protection gate firing too aggressively
   (user couldn't read content before it got replaced) or too loosely
   (content flashed by too fast); commentary fired 3s after answer
   ended (too slow to be useful).

If you see zero issues of substance, say so — don't manufacture
findings to pad the list.

== SEVERITY GUIDANCE ==
- high: directly produces wrong coaching or wrong UI state (commentary
  against wrong Q, silent when obvious Q was asked, duplicate Lead).
- medium: suboptimal timing / threshold choices that degrade UX but
  don't produce wrong content.
- low: minor polish (wording, edge-case handling, defensive checks).

== OUTPUT ==

Strict JSON, no prose wrapper:

{
  "summary": "<1-2 sentence overall assessment>",
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "category": "classify" | "commentary" | "listening-hint" |
                  "warmup" | "filter" | "roles" | "ui" | "prompts" | "other",
      "at": "mm:ss",
      "title": "<short, imperative: 'Duplicate Lead Q committed at ...'>",
      "what": "<1-2 sentences on what the app did wrong>",
      "why": "<root-cause diagnosis: which code path + why it mis-fired>",
      "suggested_fix": "<concrete proposal — file/function, threshold/logic change, new check, etc.>"
    },
    ...
  ]
}

Rank findings by severity, then by timestamp. Max 10 findings unless
absolutely necessary. Be specific: cite the exact timestamp, exact
Q text, exact event name. Generic observations without evidence are
not useful.`;

  const userCommentsBlock =
    body.userComments && body.userComments.length > 0
      ? "\n=== USER-PINNED COMMENTS ===\n" +
        body.userComments
          .map((c) => `- [${c.time}] ${c.text}`)
          .join("\n") +
        "\n=== END USER COMMENTS ===\n"
      : "";

  const user = `Analyze the following Interview Coach session.

=== TRANSCRIPT ===
${transcript || "(no transcript captured)"}
=== END TRANSCRIPT ===

=== DEBUG LOG ===
${log}
=== END DEBUG LOG ===
${userCommentsBlock}
Produce JSON with your findings.`;

  try {
    const resp = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    let parsed: { summary?: string; findings?: Finding[] } = {};
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
    const findings: Finding[] = Array.isArray(parsed.findings)
      ? parsed.findings.filter(
          (f): f is Finding =>
            typeof f === "object" &&
            f !== null &&
            typeof (f as Finding).title === "string"
        )
      : [];

    return NextResponse.json({
      summary: parsed.summary ?? "",
      findings,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
