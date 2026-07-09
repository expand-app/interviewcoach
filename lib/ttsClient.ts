/**
 * Client-side TTS for the Retake (mock interview) flow — speaks the
 * AI interviewer's lines.
 *
 * Two providers behind one interface:
 *
 *  - `aura` (English): fetches MP3 bytes from /api/tts (Deepgram Aura
 *    proxy) and plays them through Web Audio. `canCapture: true` —
 *    the caller may pass a MediaStreamDestination and the AI voice is
 *    mixed into it, which is how the interviewer's speech ends up in
 *    BOTH the session recording and the Deepgram transcription (the
 *    recorder and STT share one mixed stream — see audioSession.ts).
 *
 *  - `webSpeech` (Chinese fallback): browser speechSynthesis. Aura has
 *    no Chinese voice; speechSynthesis output cannot be routed into a
 *    MediaStream, so `canCapture: false` — zh retakes won't have the
 *    AI voice in the recording (known v1 limitation; the questions are
 *    still persisted as Question rows and shown in PastView).
 *
 * Provider choice is by plan language: en → aura, zh → webSpeech.
 */

export interface TtsHandle {
  /** Resolves when playback finishes (or was cancelled / failed). */
  done: Promise<void>;
  /** Stop playback immediately; `done` resolves right after. */
  cancel: () => void;
}

export interface TtsSpeakOptions {
  /** When set (aura only), the decoded audio is ALSO routed into this
   *  node so the recording + STT hear the AI voice. */
  captureInto?: MediaStreamAudioDestinationNode;
  /** AudioContext to decode/play through. Required for aura. Pass the
   *  same context that owns `captureInto`, or a dedicated one. */
  audioContext?: AudioContext;
  /** Aura voice model override. */
  voice?: string;
}

export interface TtsProvider {
  readonly name: "aura" | "webSpeech";
  /** Whether speak() can mix the voice into a MediaStreamDestination. */
  readonly canCapture: boolean;
  speak(text: string, opts?: TtsSpeakOptions): Promise<TtsHandle>;
}

/** Fetch + decode one Aura utterance into a playable AudioBuffer.
 *  Split out from speak() so callers can PREFETCH audio ahead of
 *  when it's needed (ack pool, next-question preload) — the fetch +
 *  decode is the dominant latency (~0.5-1.5s); playback of a decoded
 *  buffer is instant. */
export async function fetchAuraBuffer(
  ctx: AudioContext,
  text: string,
  voice?: string
): Promise<AudioBuffer> {
  // Hard timeout: without it a hung /api/tts leaves the caller's mic
  // gain-zeroed and ttsWindowUntil pinned to MAX (mock interviewer)
  // → permanent silence. 8s is generous for a 1-3 sentence clip.
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    throw new Error(`tts fetch failed: HTTP ${r.status}`);
  }
  const bytes = await r.arrayBuffer();
  // decodeAudioData detaches the buffer — no copy needed.
  return ctx.decodeAudioData(bytes);
}

/** Play an already-decoded buffer. Resumes a suspended context first
 *  (autoplay policy can suspend contexts created outside a user
 *  gesture — the #1 cause of "the AI is silent / the mic mix is
 *  dead"). */
export function playAuraBuffer(
  ctx: AudioContext,
  audioBuffer: AudioBuffer,
  captureInto?: MediaStreamAudioDestinationNode
): TtsHandle {
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  if (captureInto) {
    source.connect(captureInto);
  }

  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
    resolveDone();
  };
  source.onended = finish;
  source.start();

  return {
    done,
    cancel: () => {
      try {
        source.stop();
      } catch {
        /* not started / already stopped */
      }
      finish();
    },
  };
}

/** Deepgram Aura via the /api/tts proxy. English voices only. */
export const auraProvider: TtsProvider = {
  name: "aura",
  canCapture: true,
  async speak(text, opts) {
    const ctx = opts?.audioContext;
    if (!ctx) throw new Error("auraProvider.speak requires audioContext");
    const audioBuffer = await fetchAuraBuffer(ctx, text, opts?.voice);
    return playAuraBuffer(ctx, audioBuffer, opts?.captureInto);
  },
};

/** Browser speechSynthesis — used for Chinese, where Aura has no
 *  voice. Cannot be captured into the recording. */
export const webSpeechProvider: TtsProvider = {
  name: "webSpeech",
  canCapture: false,
  async speak(text, _opts) {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      throw new Error("speechSynthesis unavailable");
    }
    const synth = window.speechSynthesis;
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-CN";
    // Prefer an actual zh voice when one is installed — utter.lang
    // alone falls back to the default (often English) voice on some
    // platforms, which reads Chinese text uselessly.
    const zhVoice = synth
      .getVoices()
      .find((v) => v.lang?.toLowerCase().startsWith("zh"));
    if (zhVoice) utter.voice = zhVoice;

    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolveDone();
    };
    utter.onend = finish;
    utter.onerror = finish;
    synth.speak(utter);

    return {
      done,
      cancel: () => {
        synth.cancel(); // fires onend/onerror → finish()
        finish();
      },
    };
  },
};

/** Pick the provider for a retake plan's language. */
export function providerForLanguage(lang: "en" | "zh"): TtsProvider {
  return lang === "zh" ? webSpeechProvider : auraProvider;
}
