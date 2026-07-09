import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/tts — server-side proxy to Deepgram Aura text-to-speech.
 *
 * The mock-interview (Retake) flow uses this to speak the AI
 * interviewer's questions. The browser can't call Deepgram directly
 * because DEEPGRAM_API_KEY is server-only (same key the STT token
 * route uses).
 *
 * Body: { text: string; voice?: string }
 * Response: raw MP3 bytes (audio/mpeg) on success; JSON {error} on
 * failure. The client (lib/ttsClient.ts) decodes the bytes via Web
 * Audio so the AI voice can be routed BOTH to the speakers and into
 * the session recording's MediaStreamDestination.
 *
 * Aura has no Chinese voice today — zh retakes fall back to the
 * browser's speechSynthesis on the client side and never hit this
 * route.
 */

// Hard cap on the text length. Aura's own limit is 2000 chars; we cap
// below it so a runaway prompt can't burn quota. Interview questions
// are 1-3 sentences — anything near this cap indicates a caller bug.
const MAX_TEXT_CHARS = 1500;

const DEFAULT_VOICE = "aura-2-thalia-en";

export async function POST(req: Request) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY not set on server" },
      { status: 500 }
    );
  }

  let body: { text?: string; voice?: string };
  try {
    body = (await req.json()) as { text?: string; voice?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const text = (body.text ?? "").trim();
  if (!text) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      { error: `text too long (max ${MAX_TEXT_CHARS} chars)` },
      { status: 400 }
    );
  }

  // Voice is restricted to the aura model namespace so this route
  // can't be repurposed to hit arbitrary Deepgram endpoints/models.
  const voice =
    body.voice && /^aura-[a-z0-9-]+$/.test(body.voice)
      ? body.voice
      : DEFAULT_VOICE;

  try {
    const upstream = await fetch(
      `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice)}&encoding=mp3`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      }
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.warn(
        `[tts] Aura failed (${upstream.status}): ${detail.slice(0, 300)}`
      );
      return NextResponse.json(
        { error: `tts upstream ${upstream.status}` },
        { status: 502 }
      );
    }

    const bytes = await upstream.arrayBuffer();
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        // Same text → same audio; let the browser cache repeated
        // prompts (e.g. the re-ask of a question) for the session.
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    console.warn("[tts] Aura request threw:", e);
    return NextResponse.json({ error: "tts request failed" }, { status: 502 });
  }
}
