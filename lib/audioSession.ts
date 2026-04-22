/**
 * Deepgram streaming version of AudioSession.
 *
 * Opens a WebSocket to wss://api.deepgram.com/v1/listen with diarization
 * enabled, pipes MediaRecorder chunks (webm/opus) into it, and surfaces
 * transcripts via the same callback shape the orchestrator already uses.
 *
 * Auth flow:
 *   1) Browser fetches /api/deepgram-token → short-lived JWT
 *   2) Browser opens WS with subprotocol ["token", "<jwt>"]
 *   3) Master DEEPGRAM_API_KEY never leaves the server
 *
 * Why this is better than Web Speech API for our use case:
 *   - True per-speaker diarization (Deepgram returns speaker:0, 1, ... per word)
 *   - Handles multi-speaker recordings played through speakers
 *   - No 60s reconnect dance
 *   - Real word-level timestamps
 */

export interface AudioSessionCallbacks {
  /**
   * `speaker` is Deepgram's diarization label (0, 1, 2, ...).
   * undefined when diarization can't assign a speaker (interim results, music).
   */
  onFinalTranscript: (text: string, speaker?: number) => void;
  onInterimTranscript: (text: string) => void;
  onAudioReady: (audioUrl: string, duration: number) => void;
  onError: (msg: string) => void;
}

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
    punctuated_word?: string;
    speaker?: number;
  }>;
}

interface DeepgramMessage {
  type?: string;
  channel?: { alternatives: DeepgramAlternative[] };
  is_final?: boolean;
  speech_final?: boolean;
}

const DEEPGRAM_QUERY = new URLSearchParams({
  model: "nova-3",
  language: "en",
  smart_format: "true",
  punctuate: "true",
  interim_results: "true",
  endpointing: "300",
  diarize: "true",
  numerals: "true",        // "nine hundred" → "900"
  filler_words: "false",   // drop "um" / "uh" / "like"
  // NOTE: encoding/sample_rate intentionally omitted — MediaRecorder sends
  // opus wrapped in a WebM container, and Deepgram auto-detects from the
  // container header. Setting encoding=opus would tell Deepgram to expect
  // raw opus frames, which would silently fail to parse.
}).toString();

export class AudioSession {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private startTime = 0;
  private stopped = false;
  private paused = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Deepgram closes the socket after 12s of silence; ping it every 8s. */
  private static KEEP_ALIVE_MS = 8000;

  constructor(private callbacks: AudioSessionCallbacks) {}

  async start() {
    // 1) Mic — same constraints as before (EC/NS off so playback comes through cleanly)
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch {
      this.callbacks.onError("Microphone permission denied");
      return;
    }

    // 2) Get a Deepgram credential from our server route. The route returns
    //    either a short-lived JWT (scheme: "bearer") or, if grant tokens
    //    aren't available on this account, the master key (scheme: "token").
    let token: string;
    let scheme: "bearer" | "token";
    try {
      const resp = await fetch("/api/deepgram-token", { method: "POST" });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`token route ${resp.status}: ${body}`);
      }
      const data = (await resp.json()) as {
        token?: string;
        scheme?: "bearer" | "token";
        error?: string;
      };
      if (!data.token) throw new Error(data.error || "No token returned");
      token = data.token;
      scheme = data.scheme === "bearer" ? "bearer" : "token";
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to get Deepgram token";
      this.callbacks.onError(`Deepgram auth failed: ${msg}`);
      return;
    }

    // 3) Open WebSocket. Subprotocol form is [scheme, credential] — Deepgram
    //    accepts ["bearer", "<jwt>"] for grant tokens or ["token", "<key>"]
    //    for raw API keys. Browser WebSockets can't set custom headers.
    const url = `wss://api.deepgram.com/v1/listen?${DEEPGRAM_QUERY}`;
    try {
      this.ws = new WebSocket(url, [scheme, token]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "WS construct failed";
      this.callbacks.onError(`Deepgram socket failed: ${msg}`);
      return;
    }

    this.ws.onopen = () => {
      // Once the socket is open, start feeding audio.
      this.startRecording();
      // Keep the socket alive during silence (Deepgram closes after 12s).
      this.keepAliveTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, AudioSession.KEEP_ALIVE_MS);
    };

    this.ws.onmessage = (event) => this.onWsMessage(event);

    this.ws.onerror = () => {
      // Browser WebSocket onerror gives no useful detail; the close event has more.
      this.callbacks.onError("Deepgram socket error");
    };

    this.ws.onclose = (event) => {
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      if (!this.stopped) {
        this.callbacks.onError(
          `Deepgram socket closed unexpectedly (${event.code} ${event.reason || "no reason"})`
        );
      }
    };

    this.startTime = Date.now();
  }

  private onWsMessage(event: MessageEvent) {
    if (typeof event.data !== "string") return;
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // We only care about Results messages here.
    if (msg.type && msg.type !== "Results") return;

    const alt = msg.channel?.alternatives?.[0];
    if (!alt) return;
    const transcript = alt.transcript?.trim();
    if (!transcript) return;

    if (msg.is_final) {
      // Pick the dominant speaker across the words in this final segment.
      const speaker = pickDominantSpeaker(alt.words);
      this.callbacks.onFinalTranscript(transcript, speaker);
      // Clear interim view.
      this.callbacks.onInterimTranscript("");
    } else {
      this.callbacks.onInterimTranscript(transcript);
    }
  }

  private startRecording() {
    if (!this.mediaStream) return;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    this.recorder = new MediaRecorder(this.mediaStream, { mimeType: mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      // Save for playback.
      this.audioChunks.push(e.data);
      // Forward to Deepgram.
      if (this.ws?.readyState === WebSocket.OPEN && !this.paused) {
        this.ws.send(e.data);
      }
    };
    // 250ms chunks: low enough latency, big enough to be a complete container fragment.
    this.recorder.start(250);
  }

  pause() {
    this.paused = true;
    if (this.recorder?.state === "recording") this.recorder.pause();
  }

  resume() {
    this.paused = false;
    if (this.recorder?.state === "paused") this.recorder.resume();
  }

  async stop() {
    this.stopped = true;
    const duration = (Date.now() - this.startTime) / 1000;

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    // Tell Deepgram we're done so it flushes the final transcript.
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }

    // Stop recorder, wait for the final data chunk.
    if (this.recorder && this.recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        this.recorder!.onstop = () => resolve();
        this.recorder!.stop();
      });
    }

    // Close the socket. Give Deepgram a beat to flush.
    await new Promise((r) => setTimeout(r, 200));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }

    // Release mic.
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    // Hand back the recorded audio.
    const blob = new Blob(this.audioChunks, { type: "audio/webm" });
    const url = URL.createObjectURL(blob);
    this.callbacks.onAudioReady(url, duration);
  }
}

/**
 * Deepgram returns word-level speaker labels. For a multi-word utterance,
 * pick whichever speaker said the most words. Ties → earliest speaker.
 */
function pickDominantSpeaker(
  words: Array<{ speaker?: number }> | undefined
): number | undefined {
  if (!words || words.length === 0) return undefined;
  const counts = new Map<number, number>();
  for (const w of words) {
    if (typeof w.speaker !== "number") continue;
    counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  let best: number | undefined;
  let bestCount = -1;
  for (const [spk, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && spk < best)) {
      best = spk;
      bestCount = count;
    }
  }
  return best;
}
