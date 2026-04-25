import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300; // Deepgram pre-recorded can take a while for long files.

interface DeepgramPrerecordedResponse {
  results?: {
    utterances?: Array<{
      start: number;
      end: number;
      transcript: string;
      speaker?: number;
    }>;
    channels?: Array<{
      alternatives?: Array<{
        transcript?: string;
        words?: Array<{
          word: string;
          start: number;
          end: number;
          speaker?: number;
          punctuated_word?: string;
        }>;
      }>;
    }>;
  };
}

/**
 * Forwards an uploaded audio file to Deepgram's pre-recorded /v1/listen
 * endpoint and returns diarized utterances with timestamps. The frontend
 * then plays the audio locally and emits these utterances into the
 * orchestrator in sync with the playback cursor — so Live Commentary
 * streams as the audio plays, exactly like a mic session.
 *
 * We use `utterances=true` so Deepgram does the speaker segmentation for
 * us (grouping consecutive same-speaker words into a single turn). If the
 * response somehow lacks an utterances array (smaller models/languages),
 * we fall back to assembling turns from the word-level stream.
 */
export async function POST(req: Request) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPGRAM_API_KEY not set" },
      { status: 500 }
    );
  }

  // Accept both multipart uploads and raw body. Multipart is the common
  // case from the browser; raw body would come from, e.g., a CLI.
  let audio: ArrayBuffer;
  let mime = "audio/webm";
  try {
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { error: "No file field in form data" },
          { status: 400 }
        );
      }
      audio = await file.arrayBuffer();
      mime = file.type || mime;
    } else {
      audio = await req.arrayBuffer();
      if (ct) mime = ct;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to read file";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const query = new URLSearchParams({
    model: "nova-3",
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
    numerals: "true",
    filler_words: "false",
    // IMPORTANT: do NOT pass `detect_language=true` here. On Deepgram's
    // pre-recorded API, enabling language auto-detection silently falls
    // back to a transcription model that does NOT support diarization —
    // the response comes back with every utterance tagged speaker=0, and
    // our lane logic collapses to a single lane even when the recording
    // clearly has both sides. Use `language=multi` instead, which keeps
    // Nova-3's diarizer fully active while still accepting English + CJK
    // mixed speech (the common interview case).
    language: "multi",
  });

  let dg: DeepgramPrerecordedResponse;
  try {
    const resp = await fetch(
      `https://api.deepgram.com/v1/listen?${query.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": mime,
        },
        body: audio,
      }
    );
    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json(
        { error: `Deepgram ${resp.status}: ${text}` },
        { status: 502 }
      );
    }
    dg = (await resp.json()) as DeepgramPrerecordedResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Deepgram request failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const out: Array<{
    text: string;
    speaker?: number;
    start: number;
    end: number;
    duration: number;
  }> = [];

  if (dg.results?.utterances && dg.results.utterances.length > 0) {
    for (const u of dg.results.utterances) {
      const text = (u.transcript || "").trim();
      if (!text) continue;
      out.push({
        text,
        speaker: typeof u.speaker === "number" ? u.speaker : undefined,
        start: u.start,
        end: u.end,
        duration: Math.max(0, u.end - u.start),
      });
    }
  } else {
    // Fallback: group words into same-speaker runs.
    const words = dg.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    let runStart = 0;
    let runSpeaker: number | undefined;
    let runWords: string[] = [];
    let runEnd = 0;
    const flush = () => {
      const text = runWords.join(" ").trim();
      if (text) {
        out.push({
          text,
          speaker: runSpeaker,
          start: runStart,
          end: runEnd,
          duration: Math.max(0, runEnd - runStart),
        });
      }
      runWords = [];
    };
    for (const w of words) {
      const speaker = typeof w.speaker === "number" ? w.speaker : undefined;
      if (runWords.length === 0) {
        runSpeaker = speaker;
        runStart = w.start;
      } else if (speaker !== runSpeaker) {
        flush();
        runSpeaker = speaker;
        runStart = w.start;
      }
      runWords.push(w.punctuated_word || w.word);
      runEnd = w.end;
    }
    flush();
  }

  // Diagnostics: counts of distinct speakers seen in Deepgram's response.
  // When diarization silently fails (wrong model picked, unsupported
  // language, old API plan), we'll see distinctSpeakers === 1 here even
  // for a clearly-two-voice recording — that's the failure mode we just
  // locked down by switching from detect_language=true to language=multi.
  const distinctSpeakers = new Set(
    out.map((u) => u.speaker).filter((s): s is number => typeof s === "number")
  );
  console.log(
    `[transcribe-file] utterances=${out.length} distinctSpeakers=${distinctSpeakers.size} speakerSet=${[...distinctSpeakers].join(",")}`
  );

  return NextResponse.json({ utterances: out });
}
