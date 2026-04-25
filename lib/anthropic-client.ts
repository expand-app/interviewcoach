/**
 * Shared Anthropic client factory.
 *
 * Why this exists: when Node's built-in fetch (undici) makes the
 * Anthropic API call through an HTTP proxy (e.g. a corporate MITM
 * proxy, or Claude Code's own agent proxy at 127.0.0.1:*), the API
 * returns 403 "Request not allowed". The same request issued via
 * Node's classic `https.request` + `HttpsProxyAgent` succeeds with
 * 200. The root cause is some difference in undici's TLS handshake
 * that Anthropic's edge rejects — swapping in a classic-Node-based
 * fetch (node-fetch v2 + https-proxy-agent) is the simplest fix.
 *
 * When NO proxy is configured, we still use node-fetch v2 — it's a
 * drop-in fetch that uses Node's classic http(s) stack instead of
 * undici, which is marginally slower but adds zero behavioral risk.
 *
 * Usage in API routes:
 *   import { getAnthropicClient } from "@/lib/anthropic-client";
 *   const client = getAnthropicClient();
 *   const resp = await client.messages.create({ ... });
 */

import Anthropic from "@anthropic-ai/sdk";
import nodeFetch, { type RequestInit as NodeFetchInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent as HttpAgent } from "http";

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
 * Custom fetch shim. The SDK calls this like a standard web fetch. We
 * route it through node-fetch v2 with an HttpsProxyAgent when a proxy
 * is set, which avoids the undici + Anthropic-edge incompatibility.
 *
 * We widen the types to `any` at the boundary because the SDK's types
 * use the lib.dom fetch types while node-fetch has its own types —
 * the runtime shape is compatible (same Request/Response/body surface
 * area the SDK actually uses), just not structurally identical.
 */
async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit
): Promise<Response> {
  const agent = getProxyAgent();
  // node-fetch accepts `agent` in its init; web fetch does not — hence
  // the cast. When there's no proxy, agent stays undefined and
  // node-fetch uses Node's default https agent directly.
  const url = typeof input === "string" ? input : input.toString();
  const nfInit: NodeFetchInit = {
    ...(init as unknown as NodeFetchInit),
    agent: agent ?? undefined,
  };
  const res = await nodeFetch(url, nfInit);
  return res as unknown as Response;
}

/**
 * Create an Anthropic client configured to route API traffic via
 * node-fetch (classic Node TLS), tunneled through HTTPS_PROXY if set.
 *
 * Throws when ANTHROPIC_API_KEY is missing — callers should surface a
 * 500 with that message to the UI so the setup issue is obvious.
 */
export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({
    apiKey,
    // The SDK's `fetch` option is typed as the web-standard fetch;
    // our shim is runtime-compatible for the subset the SDK uses.
    fetch: proxyAwareFetch as unknown as typeof fetch,
  });
}

/** For convenience when a route already checked the key exists. */
export function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
