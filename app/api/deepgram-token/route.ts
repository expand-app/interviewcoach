import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Returns a Deepgram credential the browser can use to open a WebSocket
 * directly to wss://api.deepgram.com/v1/listen.
 *
 * Strategy:
 *   1) Try POST /v1/auth/grant to mint a short-lived JWT (preferred — the
 *      master key never reaches the browser). Browser then uses the JWT via
 *      the ["bearer", "<jwt>"] subprotocol.
 *   2) If grant fails (account doesn't have grant access, endpoint disabled,
 *      etc.), fall back to returning the master key. Browser uses it via
 *      the ["token", "<key>"] subprotocol.
 *
 * The fallback is acceptable for local dev (key stays on localhost). For
 * production deployment, get grant tokens working — otherwise every visitor's
 * browser sees the master key.
 */
export async function POST() {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY not set on server" },
      { status: 500 }
    );
  }

  // 1) Try grant token first.
  try {
    const resp = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (resp.ok) {
      const data = (await resp.json()) as {
        access_token: string;
        expires_in: number;
      };
      return NextResponse.json({
        token: data.access_token,
        scheme: "bearer",
        expiresIn: data.expires_in,
      });
    }

    // Log so we know WHY grant failed — common causes: account plan doesn't
    // include grant tokens, key lacks the required scope, endpoint disabled.
    const body = await resp.text();
    console.warn(
      `[deepgram-token] grant failed (${resp.status}): ${body.slice(0, 300)} — falling back to master key`
    );
  } catch (e) {
    console.warn("[deepgram-token] grant threw:", e);
  }

  // 2) Fallback — hand back the master key. Dev-only path; not safe for prod.
  return NextResponse.json({ token: apiKey, scheme: "token" });
}
