import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient } from "@/lib/anthropic-client";
import { logSessionEvent, logSessionEvents } from "@/lib/session-event-log";

export const runtime = "nodejs";
// Bump the per-request server timeout. The end-of-session expand kicks
// off N parallel Sonnet calls; even with concurrency=8 a 30-question
// session may need ~25-40s if the slowest item lags. Default Next.js
// route timeout in production is 30s on EB — without this directive
// the gateway 504's before the route can respond.
export const maxDuration = 120;

interface CommentInput {
  /** Stable comment id from Session.questions[].comments[].id — used
   *  by the client to merge results back onto the right comment. */
  id: string;
  /** Original commentary text including the `---SAY---` marker and
   *  short `Try:` block. The expander uses the brief Try as the
   *  starting point and extends it. */
  text: string;
}

interface QuestionInput {
  id: string;
  text: string;
  /** What the candidate actually said in answer (may be empty if no
   *  answer text was captured). Helps the expander pick a fuller
   *  reply that BUILDS on the candidate's framing rather than
   *  contradicting it. */
  answerText?: string;
  /** Comments that have a brief `Try:` block we can expand. Comments
   *  without one are silently skipped. */
  comments: CommentInput[];
}

interface Body {
  jd: string;
  resume?: string;
  questions: QuestionInput[];
  /** Optional. When supplied, the route emits session_events
   *  breadcrumbs (begin / item-failed / complete) so a future "stuck"
   *  complaint can be diagnosed from the events log. Older clients
   *  that don't pass this still work — the events are simply skipped. */
  sessionId?: string;
}

/**
 * Post-session helper. The Live Commentary `Try:` block is
 * intentionally short (one line) so the candidate can glance at it
 * mid-answer; this route generates a FULLER, deliverable version of
 * each Try suggestion for the Past Session review screen — a complete
 * paragraph the candidate can rehearse from.
 *
 * Input: a session's JD + optional resume + every question with its
 * candidate-answer-text and existing brief Try blocks.
 *
 * Output: `{ expansions: Array<{commentId, text}> }`. Comments
 * without a Try block (e.g. listening hints) are simply not in the
 * output. Failed expansions are also omitted (silent partial success).
 *
 * Architecture: N Sonnet calls FAN OUT in parallel (concurrency 8),
 * one per Try item. Each call is small (one item's worth of context)
 * so wall-clock is bounded by the slowest single call (~5-15s) plus
 * concurrency-bucket waits. Replaces the old "single Sonnet call for
 * all items" path which sequentialized inside the model — total
 * generation time scaled linearly with item count and could top 50s
 * on long sessions. Per-item parallel keeps wall-clock roughly
 * constant in the 10-25s range regardless of session length.
 */

function splitTryFrom(text: string): { commentary: string; brief: string } {
  if (!text) return { commentary: "", brief: "" };
  const marker = /\s*---SAY---\s*/;
  const parts = text.split(marker);
  if (parts.length < 2) return { commentary: text, brief: "" };
  const commentary = parts[0].trim();
  let brief = parts.slice(1).join(" ").trim();
  brief = brief.replace(/^Try[:\s]+/i, "");
  return { commentary, brief };
}

/** Per-item structure carried through the pipeline. */
type Item = {
  commentId: string;
  questionText: string;
  candidateAnswer: string;
  observation: string;
  brief: string;
};

const SYSTEM_PROMPT = `You expand a short interview-coaching "Try:" suggestion into a FULL deliverable answer the candidate can rehearse from. The brief Try block is one line of guidance for live use; YOUR job is to write what the candidate would ACTUALLY SAY end-to-end if they had the chance to redo the answer in a real interview, with proper substance and structure.

You receive ONE item: the question, what the candidate ACTUALLY said, the AI's in-flight observation, and a SHORT one-line Try suggestion.

LENGTH AND STRUCTURE — non-negotiable:
- 140-220 words. This is a COMPLETE answer the candidate would deliver in 60-90 seconds, not a hint. Treat shorter than 120 words as a failure mode — go back and add specifics, examples, or a closing bridge.
- ALWAYS structure with this 3-beat shape:
    Beat 1 (≈25-40 words): OPENING — state the answer's headline / direct response to the question. No throat-clearing.
    Beat 2 (≈80-130 words): SUBSTANCE — the concrete content. Pull from the candidate's resume + JD: name specific projects, name technical methods, give numbers, describe one decision and why. If the candidate's actual answer mentioned anything reusable, build on it; if not, write a confident clean-room version that BELIEVABLY fits the candidate's background per the resume.
    Beat 3 (≈25-40 words): CLOSING — bridge to the interviewer. Either name the natural follow-up the interviewer can probe ("happy to walk through the calibration in more detail"), tie back to the JD's responsibilities, or land a clean ending. Don't trail off.
- Separate the three beats with BLANK LINES (\\n\\n inside the JSON string). The renderer splits on blank lines to display each beat as its own paragraph — so the structural beats become visible reading rhythm.

VOICE:
- FIRST PERSON, plain spoken English the candidate would actually say aloud. Contractions are fine.
- No bullets, no headers, no markdown except <strong>...</strong>.
- Use <strong> sparingly (3-6 per expansion) on the 1-2 keywords per beat the candidate should land confidently — typically the named technique, the metric, the named project, or the closing-bridge anchor.
- Don't invent facts. If you need a number and the resume has one, use it; if not, write the answer in a way that doesn't require the number ("we tracked load and voltage features over rolling windows" beats fabricating "we trained on 4.7M samples").

CONTENT:
- BUILD ON the candidate's actual answer when it's salvageable — don't pretend they said something else.
- Use specifics from the JD (company name, tech stack, role context) and the resume (past projects, scale, concrete metrics) wherever they naturally fit. The candidate is selling FIT to THIS role, not reciting a resume.
- The Try block from Live Commentary is a STARTING DIRECTION, not the answer itself. Expand far past it.

Output STRICT JSON, no prose wrapper, no markdown fences:

{ "text": "<the expanded first-person answer, plain prose with optional <strong> tags>" }

If there's nothing useful to expand (the Try was already a full paragraph, or the question is administrative chatter), output:

{ "text": "" }

Better to emit empty than to invent.`;

function buildUserPrompt(item: Item, jd: string, resume: string): string {
  return `Job description:
"""
${jd.slice(0, 3000)}
"""

${
  resume
    ? `Candidate resume (use specifics where relevant):\n"""\n${resume.slice(0, 3000)}\n"""\n`
    : ""
}
Item to expand:
Q: ${item.questionText}
What the candidate said: ${item.candidateAnswer || "(no answer text captured)"}
AI observation: ${item.observation}
Brief Try: ${item.brief}

Write the JSON.`;
}

/** Single-item Sonnet call with 1 retry on transient errors. Returns
 *  the expanded text or null on failure / empty output. */
async function expandSingle(
  item: Item,
  jd: string,
  resume: string
): Promise<string | null> {
  const client = getAnthropicClient();
  const user = buildUserPrompt(item, jd, resume);

  const doCall = () =>
    client.messages.create({
      // Smaller per-item prompt + simpler output shape lets us cap
      // tokens MUCH lower than the batch call's 8000. 800 covers the
      // 220-word target with margin.
      model: "claude-sonnet-4-5",
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
    });

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await doCall();
      const text = resp.content
        .filter((c): c is Anthropic.TextBlock => c.type === "text")
        .map((c) => c.text)
        .join("")
        .trim();

      let parsed: { text?: string } = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {
            /* swallow */
          }
        }
      }
      const out = (parsed.text || "").trim();
      return out.length > 0 ? out : null;
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
      if (!isTransient) {
        console.warn(
          "[expand-suggestions] non-transient err, item",
          item.commentId,
          status,
          e instanceof Error ? e.message : e
        );
        return null;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
    }
  }
  console.warn(
    "[expand-suggestions] exhausted retries for item",
    item.commentId,
    lastErr instanceof Error ? lastErr.message : lastErr
  );
  return null;
}

/** Bounded-concurrency map. Up to `concurrency` workers pull items
 *  off a shared cursor and process them in parallel. Returns results
 *  in the same order as inputs (with null for failed/skipped items). */
async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R | null>,
  concurrency: number
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        results[idx] = await fn(items[idx]);
      } catch (e) {
        console.warn(
          "[expand-suggestions] worker exception at",
          idx,
          e instanceof Error ? e.message : e
        );
        results[idx] = null;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set", fallback: true },
      { status: 200 }
    );
  }

  const body = (await req.json()) as Body;
  const jd = (body.jd || "").trim();
  const resume = (body.resume || "").trim();
  const questions = Array.isArray(body.questions) ? body.questions : [];
  const sessionId = body.sessionId?.trim() || "";

  // Pre-extract the Try briefs we want to expand. Skip questions /
  // comments that have no Try at all — those are pure observations
  // (no suggestion was offered) and there's nothing to expand.
  const items: Item[] = [];
  for (const q of questions) {
    const ans = (q.answerText || "").trim();
    for (const c of q.comments || []) {
      const { commentary, brief } = splitTryFrom(c.text || "");
      if (!brief) continue;
      items.push({
        commentId: c.id,
        questionText: q.text,
        candidateAnswer: ans,
        observation: commentary,
        brief,
      });
    }
  }
  if (items.length === 0) {
    if (sessionId) {
      logSessionEvent(sessionId, {
        source: "expand",
        event: "skip-no-items",
        data: { reason: "no Try blocks found" },
      });
    }
    return NextResponse.json({ expansions: [] });
  }

  // Concurrency tuned to comfortably stay under Anthropic's per-org
  // RPM limit (50 RPM at Tier 1). 8 parallel × ~10s/call → ~12s
  // wall-clock for 8 items, ~25s for 30 items. Higher concurrency
  // saves only marginal time and risks 429 floods that we'd then
  // have to retry.
  const CONCURRENCY = 8;

  if (sessionId) {
    logSessionEvent(sessionId, {
      source: "expand",
      event: "begin",
      data: { items: items.length, concurrency: CONCURRENCY },
    });
  }

  // Per-item failure events accumulated during the fan-out so we can
  // batch-write them at the end (one round-trip vs N).
  const itemFailures: Array<{ commentId: string; reason: string }> = [];

  try {
    const t0 = Date.now();
    const results = await mapWithConcurrency(
      items,
      async (item) => {
        const text = await expandSingle(item, jd, resume);
        if (!text) {
          itemFailures.push({
            commentId: item.commentId,
            reason: "expandSingle returned null",
          });
          return null;
        }
        return { commentId: item.commentId, text };
      },
      CONCURRENCY
    );
    const expansions = results.filter(
      (e): e is { commentId: string; text: string } => e !== null
    );
    const elapsedMs = Date.now() - t0;
    console.log(
      "[expand-suggestions] done in",
      elapsedMs,
      "ms —",
      expansions.length,
      "/",
      items.length,
      "items expanded"
    );

    if (sessionId) {
      // Tail per-item failures + the completion summary in a single
      // batched insert. Two events of interest land:
      //   - expand.item-failed (one per failing item, with reason)
      //   - expand.complete    (totals + wall-clock)
      const tailEvents: Array<{
        source: string;
        event: string;
        data?: unknown;
      }> = itemFailures.map((f) => ({
        source: "expand",
        event: "item-failed",
        data: f,
      }));
      tailEvents.push({
        source: "expand",
        event: "complete",
        data: {
          requested: items.length,
          succeeded: expansions.length,
          failed: itemFailures.length,
          elapsedMs,
        },
      });
      logSessionEvents(sessionId, tailEvents);
    }

    return NextResponse.json({ expansions });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[expand-suggestions] failed:", msg);
    if (sessionId) {
      logSessionEvent(sessionId, {
        source: "expand",
        event: "fatal-error",
        data: { message: msg },
      });
    }
    return NextResponse.json(
      { error: msg, expansions: [] },
      { status: 500 }
    );
  }
}
