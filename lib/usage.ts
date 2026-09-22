/**
 * Per-call LLM token metering (#1122).
 *
 * LKC's daily「LLM Token 花费日报」pulls every service's previous-day spend
 * from GET /internal/llm-usage/daily. This module is the write side: one
 * `llm_call_usage` row per DeepSeek call.
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

/**
 * An OpenAI-compatible usage block. DeepSeek's cache-split fields are not in
 * the OpenAI schema, so depending on SDK version they arrive as real
 * properties or only inside an untyped bag — hence the index signature rather
 * than a narrow type.
 */
type UsageBlock = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
  [k: string]: unknown;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Persist one row from a chat-completions response (or a stream's final
 * usage chunk).
 *
 * The cache split is the reason this is not a two-line insert. DeepSeek's
 * `prompt_tokens` INCLUDES cache hits, which bill at roughly a tenth of the
 * uncached rate, so booking the whole prompt as input overstates the bill.
 * When only one leg is present the other is derived, so hit+miss always
 * reconciles back to `prompt_tokens`; when neither is present we take the
 * conservative reading (all uncached) and flag the row rather than reporting
 * a number nobody can reconcile.
 */
export async function recordUsage(
  feature: UsageFeature,
  usage: UsageBlock | null | undefined,
  model: string,
): Promise<void> {
  try {
    if (!usage || !isDbConfigured()) return;

    const prompt = num(usage.prompt_tokens) ?? 0;
    const completion = num(usage.completion_tokens) ?? 0;
    if (!prompt && !completion) return; // nothing billable

    const total = num(usage.total_tokens) ?? prompt + completion;
    const hit = num(usage.prompt_cache_hit_tokens);
    const miss = num(usage.prompt_cache_miss_tokens);
    const splitMissing = hit === null && miss === null;

    let cached: number;
    let uncached: number;
    if (splitMissing) {
      uncached = prompt;
      cached = 0;
    } else {
      cached = hit ?? Math.max(prompt - (miss ?? 0), 0);
      uncached = miss ?? Math.max(prompt - cached, 0);
    }

    await ensureMigrated();
    await query(
      `INSERT INTO llm_call_usage
         (feature, provider, model, calls, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, cache_split_missing)
       VALUES ($1, 'deepseek', $2, 1, $3, $4, $5, 0, $6, $7)`,
      [feature, model, uncached, completion, cached, total, splitMissing],
    );
  } catch (err) {
    // Deliberately swallowed. Logged at warn so a permanently silent meter is
    // still discoverable in the EB logs.
    console.warn(`[usage] persist failed feature=${feature}:`, err);
  }
}
