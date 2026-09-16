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
 * Proxy-aware fetch shim, which also stamps `thinking: disabled` onto
 * every outgoing chat-completion request body (see above).
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
  if (typeof body === "string" && url.includes("/chat/completions")) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
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
  return res as unknown as Response;
}

/**
 * Create a DeepSeek client.
 *
 * Throws when DEEPSEEK_API_KEY is missing — callers should surface a
 * 500 with that message to the UI so the setup issue is obvious.
 */
export function getDeepseekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not set");
  return new OpenAI({
    apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    // The SDK's `fetch` option is typed as the web-standard fetch;
    // our shim is runtime-compatible for the subset the SDK uses.
    fetch: proxyAwareFetch as unknown as typeof fetch,
  });
}

/** For convenience when a route already checked the key exists. */
export function hasDeepseekKey(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}
