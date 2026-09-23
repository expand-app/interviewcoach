/**
 * Shared DeepSeek client factory.
 *
 * DeepSeek's API is OpenAI-compatible, so we drive it with the
 * official `openai` SDK pointed at https://api.deepseek.com (note:
 * NO /v1 suffix — DeepSeek serves /chat/completions off the root).
 *
 * Why the custom fetch: Node's built-in fetch (undici) ignores the
 * HTTPS_PROXY / HTTP_PROXY environment variables entirely, so behind
 * a corporate MITM proxy — or Claude Code's own agent proxy at
 * 127.0.0.1:* — every request fails to connect. node-fetch v2 uses
 * Node's classic http(s) stack, which honors an explicit
 * HttpsProxyAgent. When no proxy is configured the agent stays
 * undefined and node-fetch falls back to Node's default https agent.
 *
 * Usage in API routes:
 *   import { getDeepseekClient, DEEPSEEK_MODEL } from "@/lib/deepseek-client";
 *   const client = getDeepseekClient();
 *   const resp = await client.chat.completions.create({
 *     model: DEEPSEEK_MODEL,
 *     ...
 *   });
 */

import OpenAI from "openai";

import { recordUsage, type UsageFeature } from "@/lib/usage";
import nodeFetch, { type RequestInit as NodeFetchInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent as HttpAgent } from "http";

/**
 * The one model id the whole app talks to. DeepSeek-V4.1-Flash:
 * 1M context, 8K default output. Every call site imports this rather
 * than hardcoding a string, so a future model bump is a one-line edit.
 */
export const DEEPSEEK_MODEL = "deepseek-flash";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

// Cached between calls to avoid recreating the agent per request.
let cachedAgent: HttpAgent | null | undefined = undefined;

function getProxyAgent(): HttpAgent | null {
  if (cachedAgent !== undefined) return cachedAgent;
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!proxy) {
    cachedAgent = null;
    return null;
  }
  cachedAgent = new HttpsProxyAgent(proxy);
  return cachedAgent;
}

/**
 * deepseek-flash ships with thinking mode ENABLED by default, at
 * `reasoning_effort: high`. In that mode the model emits a chain of
 * thought into `reasoning_content` BEFORE it writes a single token of
 * `content` — and both draw from the same `max_tokens` budget.
 *
 * Every max_tokens value in this app (40 for session-title, 200 for
 * the classifiers, 600 for live commentary, …) was sized for a
 * non-reasoning model. Left on, the reasoning pass silently eats the
 * whole budget on any prompt it finds non-trivial and the route gets
 * back an empty string — no exception, no error status, full billing,
 * and `finish_reason: "stop"`. It is prompt-dependent, so it presents
 * as routes randomly returning nothing.
 *
 * Disabling it restores the behavior contract the call sites were
 * written against, and keeps first-token latency low for the streamed
 * commentary path. This is injected here, in the transport, rather
 * than at the ~15 call sites on purpose: a call site that forgets the
 * flag reintroduces a silent, intermittent, billable bug.
 */
const THINKING_DISABLED = { type: "disabled" } as const;

/**
 * The `thinking` flag is stamped onto a JSON body by hand, outside the
 * SDK's type system — DeepSeek's API accepts it, the OpenAI SDK knows
 * nothing about it. That makes the whole defense above a silent
 * single point of failure: if DeepSeek renames the parameter, or
 * starts ignoring unknown fields instead of rejecting them, the
 * injection degrades into a no-op and the empty-response bug returns
 * with no error, no status code, and no signal of any kind.
 *
 * So verify the flag by its effects rather than trusting it:
 *
 *  - `reasoning_content` present, or reasoning_tokens > 0, means the
 *    flag did NOT take. That is the failure this module exists to
 *    prevent, so it is an error.
 *  - `finish_reason: "length"` with empty content is the shape the
 *    bug actually presents as. It can also mean a genuinely
 *    over-long completion, so it is a warning, not an error.
 *
 * Both go to the server log, which is where someone debugging
 * "scores come back blank sometimes" will actually be looking.
 */
function auditCompletion(payload: string): void {
  let body: {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null; reasoning_content?: string | null };
    }>;
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  };
  try {
    body = JSON.parse(payload);
  } catch {
    return;
  }

  const choice = body.choices?.[0];
  if (!choice) return;

  const reasoningTokens =
    body.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (choice.message?.reasoning_content || reasoningTokens > 0) {
    console.error(
      "[deepseek-client] thinking mode is ACTIVE despite " +
        `thinking:${JSON.stringify(THINKING_DISABLED)} — the injection in ` +
        "proxyAwareFetch is no longer working. Responses will " +
        "intermittently come back empty as reasoning consumes max_tokens. " +
        `(reasoning_tokens=${reasoningTokens}) See lib/deepseek-client.ts.`
    );
    return;
  }

  if (choice.finish_reason === "length" && !choice.message?.content?.trim()) {
    console.warn(
      "[deepseek-client] empty content with finish_reason=length — the " +
        "call's max_tokens budget was exhausted before any output. Raise " +
        "max_tokens at the call site, or check whether thinking mode was " +
        "re-enabled."
    );
  }
}

/**
 * Proxy-aware fetch shim, which also stamps `thinking: disabled` onto
 * every outgoing chat-completion request body (see above) and audits
 * the response to confirm the flag is still doing its job.
 *
 * We widen the types at the boundary because the SDK's types use the
 * lib.dom fetch types while node-fetch has its own — the runtime
 * shape is compatible for the subset the SDK actually uses.
 */
async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  const agent = getProxyAgent();
  const url = typeof input === "string" ? input : input.toString();

  let body = init?.body;
  let isCompletion = false;
  let isStreaming = false;
  if (typeof body === "string" && url.includes("/chat/completions")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      isCompletion = true;
      isStreaming = parsed.stream === true;
      // Respect an explicit per-call override; only default it.
      if (parsed.thinking === undefined) {
        parsed.thinking = THINKING_DISABLED;
        body = JSON.stringify(parsed);
      }
    } catch {
      /* non-JSON body — pass through untouched */
    }
  }

  const nfInit: NodeFetchInit = {
    ...(init as unknown as NodeFetchInit),
    body: body as NodeFetchInit["body"],
    agent: agent ?? undefined,
  };
  const res = await nodeFetch(url, nfInit);

  // Audit non-streamed completions only. A streamed body must not be
  // buffered here — commentary is the streaming caller and it is the
  // one path where first-token latency is the whole point. The audit
  // reads a CLONE so the SDK still gets an untouched, unconsumed body,
  // and it is deliberately not awaited: a diagnostic must never add
  // latency to, or be able to fail, the actual request.
  if (isCompletion && !isStreaming && res.ok) {
    void res
      .clone()
      .text()
      .then(auditCompletion)
      .catch(() => {
        /* diagnostics must never break the request */
      });
  }

  return res as unknown as Response;
}

/**
 * Create a DeepSeek client.
 *
 * Throws when DEEPSEEK_API_KEY is missing — callers should surface a
 * 500 with that message to the UI so the setup issue is obvious.
 */
export function getDeepseekClient(feature?: UsageFeature): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");
  const client = new OpenAI({
    apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    // The SDK's `fetch` option is typed as the web-standard fetch;
    // our shim is runtime-compatible for the subset the SDK uses.
    fetch: proxyAwareFetch as unknown as typeof fetch,
  });
  return feature ? withUsageMetering(client, feature) : client;
}

/**
 * Wrap `chat.completions.create` so every non-streaming call lands one
 * `llm_call_usage` row (#1122 — LKC's token digest pulls those rows).
 *
 * Metering at the factory rather than at each call site is deliberate: there
 * are a dozen routes, several of them retry inside a closure or race the
 * promise against a timeout, and rewriting those invocations to thread a
 * recorder through would be a far larger diff than passing one string. Each
 * route changes from `getDeepseekClient()` to `getDeepseekClient("<feature>")`
 * and is covered.
 *
 * A retry loop meters every attempt that came back with a usage block, which
 * is correct — each attempt was billed.
 *
 * **Streams are skipped here.** With `stream: true` the SDK resolves to an
 * async iterable, and its usage only arrives in a final chunk when the request
 * asked for `stream_options: { include_usage: true }`. Tapping the iterator
 * from in here would mean buffering somebody else's stream, so the one
 * streaming route (/api/commentary) records from its own final chunk instead.
 * The `params.stream` check is what keeps this wrapper from reporting a bogus
 * zero-token row for those calls.
 *
 * Nothing here can reject: `recordUsage` swallows its own failures, and the
 * response is returned before metering is awaited only in the sense that the
 * await cannot change it.
 */
function withUsageMetering(client: OpenAI, feature: UsageFeature): OpenAI {
  const completions = client.chat.completions;
  const original = completions.create.bind(completions);

  // The SDK's `create` is heavily overloaded (streaming vs not) and its
  // APIPromise carries extra methods; nothing in this app uses those
  // (`withResponse` / `asResponse` appear nowhere), so a plain async wrapper
  // is safe here. Revisit if a call site ever reaches for them.
  completions.create = (async (params: any, options?: any) => {
    const resp = await original(params, options);
    if (!params?.stream) {
      await recordUsage(feature, (resp as any)?.usage, params?.model ?? "");
    }
    return resp;
  }) as typeof completions.create;

  return client;
}
