export type UsageBlock = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
  } | null;
  // Preserve support for historical DeepSeek response fixtures/reconciliation.
  prompt_cache_hit_tokens?: number | null;
  prompt_cache_miss_tokens?: number | null;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function normalizeUsage(usage: UsageBlock, model: string) {
  const provider = model.startsWith("deepseek") ? "deepseek" : "openai";
  const prompt = num(usage.prompt_tokens) ?? 0;
  const output = num(usage.completion_tokens) ?? 0;
  const details = usage.prompt_tokens_details;
  const hit = provider === "openai"
    ? num(details?.cached_tokens)
    : num(usage.prompt_cache_hit_tokens);
  const miss = provider === "deepseek" ? num(usage.prompt_cache_miss_tokens) : null;
  const write = provider === "openai" ? num(details?.cache_write_tokens) : 0;
  const cached = Math.min(prompt, hit ?? Math.max(prompt - (miss ?? prompt), 0));
  const written = Math.min(prompt - cached, write ?? 0);
  return {
    provider,
    // Cache-write price replaces ordinary input pricing; do not double count.
    input: Math.max(prompt - cached - written, 0),
    output,
    cached,
    written,
    total: num(usage.total_tokens) ?? prompt + output,
    splitMissing: provider === "openai"
      ? hit === null || write === null
      : hit === null && miss === null,
  };
}
