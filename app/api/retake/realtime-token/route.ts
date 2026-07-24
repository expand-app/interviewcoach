import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * POST /api/retake/realtime-token — mint a short-lived OpenAI Realtime
 * ephemeral client secret so the browser can open a WebRTC voice
 * connection DIRECTLY to OpenAI without ever seeing OPENAI_API_KEY.
 *
 * This mirrors the existing /api/deepgram-token pattern: the master
 * key stays server-side; the browser gets a single-use `ek_...` secret
 * scoped to one realtime session, then POSTs its SDP offer to
 * https://api.openai.com/v1/realtime/calls with that secret.
 *
 * Used ONLY by the Retake (mock interview) flow when the OpenAI
 * realtime engine is selected. The live-interview path is untouched.
 *
 * Body: { instructions: string; voice?: string; language?: "en"|"zh" }
 * Response: { value: string }  // the ek_... ephemeral secret
 *
 * API shape verified against the GA Realtime docs (July 2026):
 *   POST https://api.openai.com/v1/realtime/client_secrets
 *   { session: { type: "realtime", model, instructions, audio:{ input, output } } }
 *   → response.value starts with "ek_"
 * If OpenAI iterates the schema again, this route is the single place
 * to adjust — the browser side only consumes `value`.
 */

// gpt-realtime-2.1 is the current low-latency GA voice model.
const REALTIME_MODEL = "gpt-realtime-2.1";
// Natural GA voices: "marin" / "cedar". Marin reads as a warm,
// professional interviewer.
const DEFAULT_VOICE = "marin";
// Guard: the plan + persona instructions are the only large field; cap
// it so a runaway caller can't stuff the session.
const MAX_INSTRUCTIONS_CHARS = 12_000;

export async function POST(req: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY not set on server" },
      { status: 500 }
    );
  }

  let body: { instructions?: string; voice?: string; language?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const instructions = (body.instructions ?? "").trim();
  if (!instructions) {
    return NextResponse.json(
      { error: "instructions required" },
      { status: 400 }
    );
  }
  if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    return NextResponse.json(
      { error: `instructions too long (max ${MAX_INSTRUCTIONS_CHARS})` },
      { status: 400 }
    );
  }

  // Restrict voice to a known set so the field can't be repurposed.
  const voice =
    body.voice && /^[a-z]+$/.test(body.voice) ? body.voice : DEFAULT_VOICE;
  // Pin the input-transcription language to the interview language.
  // Auto-detect on short/noisy utterances routinely hallucinates other
  // languages (field report: a breath transcribed as Japanese
  // 「はい、失礼します」 in an English interview), which then poisons
  // the answer text and the coaching.
  const sttLanguage = body.language === "zh" ? "zh" : "en";

  try {
    const upstream = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // Recommended when minting client secrets so abuse can be
          // traced back to the app rather than an end user.
          "OpenAI-Safety-Identifier": "puebulo-retake",
        },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: REALTIME_MODEL,
            instructions,
            audio: {
              input: {
                // Whisper transcription of the CANDIDATE's speech — the
                // realtime path uses these transcripts (not Deepgram)
                // to fill Question.answerText and drive coaching.
                transcription: {
                  model: "gpt-4o-mini-transcribe",
                  language: sttLanguage,
                },
                // near_field: laptop/headset close-mic profile. We
                // briefly shipped far_field (a conference-room distant
                // -mic profile) as echo defense, but stacked with the
                // 0.75 VAD threshold and uplink ducking it suppressed
                // NORMAL candidate speech below detection — "the AI
                // can't hear me". Echo is handled by AEC + ducking +
                // the text echo-guard instead.
                noise_reduction: { type: "near_field" },
                // Model-driven conversation (ChatGPT-voice style):
                // create_response:true → the model runs the whole
                // interview autonomously (turn-taking, follow-ups,
                // acknowledgments) guided by the plan in `instructions`.
                // interrupt_response:true → the candidate can barge in.
                // threshold 0.55: slightly above the 0.5 default (echo
                // margin) but low enough that normal speech through a
                // ducked uplink still registers — 0.75 proved deaf.
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.55,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 600,
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: { voice },
            },
            // The model calls this when it has covered the whole plan
            // and finished its closing — the client then ends the call.
            tools: [
              {
                type: "function",
                name: "end_interview",
                description:
                  "Call this ONCE, only after you have asked all the planned questions and delivered your closing remarks, to end the interview.",
                parameters: { type: "object", properties: {}, required: [] },
              },
            ],
            tool_choice: "auto",
          },
        }),
      }
    );

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.warn(
        `[realtime-token] mint failed (${upstream.status}): ${detail.slice(0, 400)}`
      );
      return NextResponse.json(
        { error: `realtime token upstream ${upstream.status}` },
        { status: 502 }
      );
    }

    const data = (await upstream.json()) as {
      value?: string;
      client_secret?: { value?: string };
    };
    // GA returns the secret at top-level `value`; older shapes nested it
    // under client_secret.value — accept either.
    const value = data.value ?? data.client_secret?.value;
    if (!value) {
      console.warn("[realtime-token] no secret in response:", data);
      return NextResponse.json(
        { error: "no ephemeral secret in response" },
        { status: 502 }
      );
    }

    return NextResponse.json({ value });
  } catch (e) {
    console.warn("[realtime-token] threw:", e);
    return NextResponse.json(
      { error: "realtime token request failed" },
      { status: 502 }
    );
  }
}
