/**
 * Server-side fire-and-forget expand-suggestions backfill.
 *
 * Mirrors the lib/transcode.ts pattern: when GET /api/sessions/:id sees
 * a session whose comments still have brief Try blocks but no
 * `expanded_suggestion` rows, kick off a background Sonnet call that
 * generates full deliverable answers and writes them back to the
 * comments table. The next time the user opens the session, the
 * expansions are there.
 *
 * Why not rely on the existing /api/expand-suggestions route fired
 * from the client at endLive: that path was unreliable in practice —
 * a slow upsert (Aurora cold start), a transient Sonnet hiccup, or
 * the user navigating away mid-flight all left the session with no
 * expansions and no obvious recovery path. Server-side lazy backfill
 * runs whenever someone opens the past view, with in-memory dedupe
 * so the same session doesn't double-fire if multiple opens hit fast.
 */

import { getAnthropicClient } from "./anthropic-client";
import { query, withTx } from "./db";
import { logSessionEvent, logSessionEvents } from "./session-event-log";

const inProgress = new Set<string>();

interface CommentRow {
  id: string;
  question_id: string;
  text: string;
  expanded_suggestion: string | null;
  question_text: string;
  question_answer: string;
}

interface SessionMeta {
  jd: string;
  resume: string;
}

/** Split a Live Commentary string into the observation + the brief
 *  Try directive. Mirrors the same helper in the public API route. */
function splitTryFrom(text: string): { commentary: string; brief: string } {
  if (!text) return { commentary: "", brief: "" };
  const parts = text.split(/\s*---SAY---\s*/);
  if (parts.length < 2) return { commentary: text, brief: "" };
  return {
    commentary: parts[0].trim(),
    brief: parts.slice(1).join(" ").trim().replace(/^Try[:\s]+/i, ""),
  };
}

/** Fire-and-forget: kick off a backfill if (a) we don't already have
 *  one running for this session, and (b) the session genuinely has
 *  comments missing expansions. */
export function triggerBackgroundExpand(sessionId: string): void {
  if (inProgress.has(sessionId)) return;
  inProgress.add(sessionId);
  void runBackfill(sessionId).finally(() => {
    inProgress.delete(sessionId);
  });
}

async function runBackfill(sessionId: string): Promise<void> {
  const t0 = Date.now();
  try {
    // Pull session meta + every comment that still lacks an expansion.
    const sessR = await query<SessionMeta>(
      `SELECT jd, resume FROM sessions WHERE id = $1`,
      [sessionId]
    );
    if (sessR.rows.length === 0) return;
    const { jd, resume } = sessR.rows[0];
    if (!jd) return;

    const cR = await query<CommentRow>(
      `SELECT c.id, c.question_id, c.text, c.expanded_suggestion,
              q.text AS question_text, q.answer_text AS question_answer
       FROM comments c
       JOIN questions q ON q.id = c.question_id
       WHERE q.session_id = $1
         AND (c.expanded_suggestion IS NULL OR c.expanded_suggestion = '')`,
      [sessionId]
    );
    if (cR.rows.length === 0) return;

    // Build expand items — only those whose comment text contains a
    // brief Try block. Listening hints / observation-only comments
    // have no Try block to expand and are silently skipped.
    type Item = {
      commentId: string;
      questionText: string;
      candidateAnswer: string;
      observation: string;
      brief: string;
    };
    const items: Item[] = [];
    for (const c of cR.rows) {
      const { commentary, brief } = splitTryFrom(c.text);
      if (!brief) continue;
      items.push({
        commentId: c.id,
        questionText: c.question_text,
        candidateAnswer: c.question_answer,
        observation: commentary,
        brief,
      });
    }
    if (items.length === 0) return;

    console.log(
      "[expand-backfill] starting",
      sessionId,
      "items:",
      items.length
    );
    logSessionEvent(sessionId, {
      source: "expand-backfill",
      event: "begin",
      data: { items: items.length, path: "lazy" },
    });

    // Inline the same prompt as /api/expand-suggestions/route.ts.
    // Kept verbatim so behavior matches; if the public route's prompt
    // is updated, mirror the change here.
    const system = `You expand short interview-coaching "Try:" suggestions into FULL deliverable answers the candidate can rehearse from. The brief Try block is one line of guidance for live use; YOUR job is to write what the candidate would ACTUALLY SAY end-to-end if they had the chance to redo the answer in a real interview, with proper substance and structure.

For each input item you get the question, what the candidate ACTUALLY said, the AI's in-flight observation, and a SHORT one-line Try suggestion.

LENGTH AND STRUCTURE — non-negotiable:
- 140-220 words per expansion. This is a COMPLETE answer the candidate would deliver in 60-90 seconds, not a hint. Treat shorter than 120 words as a failure mode — go back and add specifics, examples, or a closing bridge.
- ALWAYS structure with this 3-beat shape:
    Beat 1 (≈25-40 words): OPENING — state the answer's headline / direct response to the question. No throat-clearing.
    Beat 2 (≈80-130 words): SUBSTANCE — the concrete content. Pull from the candidate's resume + JD: name specific projects, name technical methods, give numbers, describe one decision and why. If the candidate's actual answer mentioned anything reusable, build on it; if not, write a confident clean-room version that BELIEVABLY fits the candidate's background per the resume.
    Beat 3 (≈25-40 words): CLOSING — bridge to the interviewer. Either name the natural follow-up the interviewer can probe ("happy to walk through the calibration in more detail"), tie back to the JD's responsibilities, or land a clean ending. Don't trail off.
- Separate the three beats with BLANK LINES (\\n\\n inside the JSON string). The renderer splits on blank lines to display each beat as its own paragraph — so the structural beats become visible reading rhythm.

VOICE:
- FIRST PERSON, plain spoken English the candidate would actually say aloud. Contractions are fine.
- No bullets, no headers, no markdown except <strong>...</strong>.
- Use <strong> sparingly (3-6 per expansion) on the 1-2 keywords per beat the candidate should land confidently — typically the named technique, the metric, the named project, or the closing-bridge anchor.
- Don't invent facts. If you need a number and the resume has one, use it; if not, write the answer in a way that doesn't require the number.

CONTENT:
- BUILD ON the candidate's actual answer when it's salvageable — don't pretend they said something else.
- Use specifics from the JD (company name, tech stack, role context) and the resume (past projects, scale, concrete metrics) wherever they naturally fit.
- The Try block from Live Commentary is a STARTING DIRECTION, not the answer itself. Expand far past it.

Output STRICT JSON, no prose wrapper, no markdown fences:

{
  "expansions": [
    { "commentId": "<id>", "text": "<the expanded first-person answer with \\n\\n paragraph breaks and optional <strong> tags>" },
    ...
  ]
}

Skip an item entirely (omit it from the array) if there's nothing useful to expand.`;

    const itemsBlock = items
      .map(
        (it, i) =>
          `--- Item ${i + 1} ---
commentId: ${it.commentId}
Q: ${it.questionText}
What the candidate said: ${it.candidateAnswer || "(no answer text captured)"}
AI observation: ${it.observation}
Brief Try: ${it.brief}`
      )
      .join("\n\n");

    const user = `Job description:
"""
${jd.slice(0, 3000)}
"""

${
  resume
    ? `Candidate resume (use specifics where relevant):\n"""\n${resume.slice(0, 3000)}\n"""\n`
    : ""
}Items to expand (${items.length}):

${itemsBlock}

Write the JSON.`;

    const client = getAnthropicClient();
    const resp = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join("")
      .trim();

    let parsed: { expansions?: Array<{ commentId: string; text: string }> };
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : {};
    }

    const expansions = (parsed.expansions || []).filter(
      (e) =>
        e &&
        typeof e.commentId === "string" &&
        typeof e.text === "string" &&
        e.text.trim().length > 0
    );
    if (expansions.length === 0) {
      console.warn("[expand-backfill] sonnet returned 0 expansions for", sessionId);
      logSessionEvent(sessionId, {
        source: "expand-backfill",
        event: "no-expansions-returned",
        data: { requested: items.length, elapsedMs: Date.now() - t0 },
      });
      return;
    }

    // Bulk update comments. Single transaction so a partial failure
    // doesn't leave the session in a half-state.
    await withTx(async (q) => {
      for (const e of expansions) {
        await q(
          `UPDATE comments SET expanded_suggestion = $1 WHERE id = $2`,
          [e.text, e.commentId]
        );
      }
    });

    const elapsedMs = Date.now() - t0;
    console.log("[expand-backfill] done", {
      sessionId,
      requested: items.length,
      written: expansions.length,
      elapsedMs,
    });

    // Per-item failures vs successes. The Sonnet single-batch call may
    // omit some items entirely (it's instructed to skip when there's
    // nothing useful to expand) — capture which commentIds DIDN'T
    // come back so a future debug session can tell silent-skip from
    // never-tried.
    const succeededIds = new Set(expansions.map((e) => e.commentId));
    const skipped = items
      .filter((it) => !succeededIds.has(it.commentId))
      .map((it) => ({ commentId: it.commentId, reason: "omitted-by-model" }));
    const tailEvents: Array<{
      source: string;
      event: string;
      data?: unknown;
    }> = skipped.map((s) => ({
      source: "expand-backfill",
      event: "item-skipped",
      data: s,
    }));
    tailEvents.push({
      source: "expand-backfill",
      event: "complete",
      data: {
        requested: items.length,
        written: expansions.length,
        skipped: skipped.length,
        elapsedMs,
      },
    });
    logSessionEvents(sessionId, tailEvents);
  } catch (e) {
    console.warn("[expand-backfill] failed", {
      sessionId,
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: Date.now() - t0,
    });
    logSessionEvent(sessionId, {
      source: "expand-backfill",
      event: "fatal-error",
      data: {
        message: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - t0,
      },
    });
  }
}
