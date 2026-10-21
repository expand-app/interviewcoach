import type { ChatCompletionCreateParams } from "openai/resources/chat/completions";

/** Cache only leading instructions/session context, never changing answers.
 * Explicit mode also avoids paying for writes on one-shot user-only calls.
 * OpenAI ignores prefixes below its 1,024-token eligibility threshold.
 */
export function prepareLunaRequest(
  params: ChatCompletionCreateParams,
  feature = "text",
): ChatCompletionCreateParams {
  let prefix = true;
  let breakpoints = 0;
  const messages = params.messages.map((message) => {
    if (!prefix || (message.role !== "system" && message.role !== "developer")) {
      prefix = false;
      return message;
    }
    if (typeof message.content !== "string" || !message.content || breakpoints >= 4) {
      return message;
    }
    breakpoints++;
    return {
      ...message,
      role: "developer" as const,
      content: [{
        type: "text" as const,
        text: message.content,
        prompt_cache_breakpoint: { mode: "explicit" as const },
      }],
    };
  });
  return {
    ...params,
    messages,
    reasoning_effort: "none",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
    prompt_cache_key: `puebulo:${feature}:v1`,
  };
}
