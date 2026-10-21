/**
 * Per-call LLM token metering (#1122).
 *
 * LKC's daily「LLM Token 花费日报」pulls every service's previous-day spend
 * from GET /internal/llm-usage/daily. This module is the write side: one
 * `llm_call_usage` row per text-model call.
 *
 * **Everything here is best-effort and never throws into its caller.**
 * Metering is accounting, not product behaviour — a failed insert, or no
 * DATABASE_URL at all (local dev short-circuits, see lib/db.ts), must cost us
 * a row and never the feature. Callers therefore do not await it for
 * correctness, only to keep the write inside the request's lifetime.
 */

import { isDbConfigured, ensureMigrated, query } from "@/lib/db";

/** Stable snake_case keys. Never a display label — see the migration comment. */
export type UsageFeature =
  | "commentary"
  | "detect_question"
  | "score_session"
  | "session_title"
  | "summarize_context"
  | "summarize_interviewer"
  | "mock_interviewer"
  | "retake_plan"
  | "expand_suggestions"
  | "identify_speakers"
  | "analyze_session"
  | "classify_moment";

import { normalizeUsage, type UsageBlock } from "./usage-tokens";

/**
 * Persist one row from a chat-completions response (or a stream's final
 * usage chunk).
 *
 * OpenAI reports cache reads and writes in prompt_tokens_details. Both
 * are included in prompt_tokens and must be subtracted from ordinary input
 * before pricing. Historical DeepSeek accounting remains supported.
 */
export async function recordUsage(
  feature: UsageFeature,
  usage: UsageBlock | null | undefined,
  model: string,
): Promise<void> {
  try {
    if (!usage || !isDbConfigured()) return;

    const tokens = normalizeUsage(usage, model);
    if (!tokens.total && !tokens.input && !tokens.output) return;

    await ensureMigrated();
    await query(
      `INSERT INTO llm_call_usage
         (feature, provider, model, calls, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, cache_split_missing)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
      [feature, tokens.provider, model, tokens.input, tokens.output,
        tokens.cached, tokens.written, tokens.total, tokens.splitMissing],
    );
  } catch (err) {
    // Deliberately swallowed. Logged at warn so a permanently silent meter is
    // still discoverable in the EB logs.
    console.warn(`[usage] persist failed feature=${feature}:`, err);
  }
}
