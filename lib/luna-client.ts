import OpenAI from "openai";
import nodeFetch, { type RequestInit as NodeFetchInit } from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { Agent as HttpAgent } from "http";
import { recordUsage, type UsageFeature } from "@/lib/usage";
import { prepareLunaRequest } from "./luna-request";

export const LUNA_MODEL = "gpt-6-luna";
export const LUNA_BASE_URL = "https://api.openai.com/v1";

let cachedAgent: HttpAgent | null | undefined;
function getProxyAgent(): HttpAgent | null {
  if (cachedAgent !== undefined) return cachedAgent;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  cachedAgent = proxy ? new HttpsProxyAgent(proxy) : null;
  return cachedAgent;
}

// Keep support for the existing development/corporate proxy. No DeepSeek
// transport parameters (notably `thinking`) are sent to OpenAI.
async function proxyAwareFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const options: NodeFetchInit = {
    ...(init as unknown as NodeFetchInit),
    agent: getProxyAgent() ?? undefined,
  };
  return await nodeFetch(input.toString(), options) as unknown as Response;
}

export function getLunaClient(feature?: UsageFeature): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const client = new OpenAI({
    apiKey,
    baseURL: LUNA_BASE_URL,
    fetch: proxyAwareFetch as unknown as typeof fetch,
  });
  const completions = client.chat.completions;
  const original = completions.create.bind(completions);
  // The application awaits create() and does not use APIPromise helpers.
  // Streams retain their async iterator; commentary records their final usage.
  completions.create = (async (params: any, options?: any) => {
    const request = prepareLunaRequest(params, feature);
    const response = await original(request, options);
    if (!params.stream && "choices" in response) {
      if (response.usage?.completion_tokens_details?.reasoning_tokens) {
        console.warn("[luna-client] unexpected reasoning tokens with reasoning_effort=none");
      }
      if (feature) await recordUsage(feature, response.usage, response.model || LUNA_MODEL);
    }
    return response;
  }) as typeof completions.create;
  return client;
}
