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
   * `duration` is the length of audio this segment covers, in seconds, from
   * Deepgram's per-Results `duration` field.
   */
  onFinalTranscript: (text: string, speaker?: number, duration?: number) => void;
  onInterimTranscript: (text: string) => void;
  onAudioReady: (audioUrl: string, duration: number) => void;
  /** Fired alongside onAudioReady when captureVideo was enabled and the
   *  user successfully shared a tab/window. The blob is a WebM with
   *  video (vp9) + the same mixed audio track Deepgram saw, so playback
   *  matches the transcript. Not fired when captureVideo was off, when
   *  the share dialog was declined, or when the share had no video
   *  track (audio-only share). The URL is a browser blob URL — only
   *  valid for the lifetime of the page tab. */
  onVideoReady?: (videoUrl: string, duration: number) => void;
  onError: (msg: string) => void;
  /** Fired when playback-driven capture reaches the end of the file.
   *  Live mic capture never calls this. Used to show a "recording complete —
   *  view your scoring" prompt and to flush remaining utterances. */
  onPlaybackEnded?: () => void;
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
  /** Length of audio in this segment, in seconds. */
  duration?: number;
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

/**
 * Options that control how the session captures audio. `captureTabAudio`:
 *   - "auto" (default): after mic grant, look at the system's default audio
 *     output device. If its label looks like headphones / earphones /
 *     AirPods, automatically attempt tab audio capture — the interviewer's
 *     voice won't reach the mic through the room in that case.
 *   - "on": always attempt tab audio capture.
 *   - "off": never.
 * Failures in tab audio capture (user cancels the share dialog, browser
 * unsupported, no audio track in share) fall back to mic-only without
 * failing the session.
 */
export interface AudioSessionOptions {
  captureTabAudio?: "auto" | "on" | "off";
  /** When true AND the user accepts the tab/window share prompt with a
   *  video track, retain the video track and record a parallel WebM
   *  with video + mixed audio. Calls onVideoReady on stop().
   *  No-op when captureTabAudio is "off" or the user declined the share. */
  captureVideo?: boolean;
}

/** Check whether the current default audio output is likely an earphone /
 *  headset / earbud. Relies on device labels, which are only exposed after
 *  mic permission has been granted. Conservative on "bluetooth" alone
 *  since it could be a speaker. */
async function defaultOutputLooksLikeHeadphones(): Promise<boolean> {
  if (!navigator.mediaDevices?.enumerateDevices) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === "audiooutput");
    if (outputs.length === 0) return false;
    // Prefer the explicit "default" deviceId on Chromium; fall back to first.
    const def = outputs.find((d) => d.deviceId === "default") ?? outputs[0];
    const label = (def.label || "").toLowerCase();
    return (
      label.includes("headphone") ||
      label.includes("headset") ||
      label.includes("earphone") ||
      label.includes("earbud") ||
      label.includes("airpod")
    );
  } catch {
    return false;
  }
}

export class AudioSession {
  private ws: WebSocket | null = null;
  private mediaStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private tabStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  /** Optional second recorder for video+audio output. Only spun up when
   *  options.captureVideo is true AND tab share included a video track. */
  private videoRecorder: MediaRecorder | null = null;
  private videoChunks: Blob[] = [];
  /** Combined stream fed to videoRecorder: video track from tab share +
   *  the same mixed audio destination Deepgram receives. Held so we
   *  can release it cleanly on stop. */
  private videoStream: MediaStream | null = null;
  private startTime = 0;
  private stopped = false;
  private paused = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Deepgram closes the socket after 12s of silence; ping it every 8s. */
  private static KEEP_ALIVE_MS = 8000;

  constructor(
    private callbacks: AudioSessionCallbacks,
    private options: AudioSessionOptions = {}
  ) {}

  async start() {
    // 1) Mic — EC/NS off so playback from the room still reaches Deepgram
    //    cleanly in the speakers-on case.
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
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

    // 1a) Decide whether to ALSO capture tab/system audio. If earphones are
    //     plugged in, the mic can't pick up the interviewer's voice (it goes
    //     straight into the ear), so Deepgram would only see the candidate.
    //     In "auto" mode (default) we inspect the default audio output's
    //     label; if it looks like headphones we kick off getDisplayMedia
    //     automatically. The user still has to pick a tab in the native
    //     share dialog and tick "Share tab audio".
    const captureMode = this.options.captureTabAudio ?? "auto";
    let shouldCaptureTab = captureMode === "on";
    if (captureMode === "auto") {
      shouldCaptureTab = await defaultOutputLooksLikeHeadphones();
      if (shouldCaptureTab) {
        // Tell the user why the share dialog is about to appear. Uses the
        // existing error-toast channel — harmless; this is informational.
        this.callbacks.onError(
          "Earphones detected — in the next dialog, pick your interview tab and check \"Share tab audio\" so the interviewer's voice is transcribed."
        );
      }
    }
    if (shouldCaptureTab) {
      try {
        this.tabStream = await navigator.mediaDevices.getDisplayMedia({
          // video:true is required by Chrome for the audio track to exist.
          // We stop the video tracks immediately below UNLESS the caller
          // wants the screen recording (captureVideo option), in which
          // case we keep them alive and feed them into a parallel WebM
          // recorder.
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        if (!this.options.captureVideo) {
          for (const t of this.tabStream.getVideoTracks()) t.stop();
        }
        if (this.tabStream.getAudioTracks().length === 0) {
          // User didn't check "Share audio" — useless without it.
          for (const t of this.tabStream.getTracks()) t.stop();
          this.tabStream = null;
          this.callbacks.onError(
            "Tab audio share had no audio track — re-enable \"Share tab audio\" in the browser prompt. Continuing with mic-only."
          );
        }
      } catch {
        // User cancelled or not supported — keep going with mic only.
        this.tabStream = null;
        this.callbacks.onError(
          "Tab audio capture declined — continuing with mic-only. Interviewer voice won't be transcribed unless laptop speakers are on."
        );
      }
    }

    // 1b) Build the stream we actually hand to MediaRecorder. If we have
    //     tab audio, mix mic + tab via Web Audio; otherwise the mic stream
    //     is used directly.
    if (this.tabStream && this.tabStream.getAudioTracks().length > 0) {
      this.audioContext = new AudioContext();
      const dest = this.audioContext.createMediaStreamDestination();
      this.audioContext
        .createMediaStreamSource(this.micStream)
        .connect(dest);
      this.audioContext
        .createMediaStreamSource(
          new MediaStream(this.tabStream.getAudioTracks())
        )
        .connect(dest);
      this.mediaStream = dest.stream;
    } else {
      this.mediaStream = this.micStream;
    }

    // 1c) Build the parallel video+audio stream IF caller requested
    //     captureVideo AND tab share included a video track. We use the
    //     EXACT same mixed audio destination as Deepgram + the recording
    //     blob, so video playback audio matches the transcript exactly.
    //     If captureVideo was requested but no video track survived
    //     (audio-only share, or share declined), we silently skip — the
    //     audio recording is still produced.
    if (
      this.options.captureVideo &&
      this.tabStream &&
      this.tabStream.getVideoTracks().length > 0
    ) {
      const videoTracks = this.tabStream.getVideoTracks();
      // Pull audio from this.mediaStream (the mic+tab mix when tab audio
      // is present, or just the mic stream when not). This way the
      // recording always has both sides of the conversation regardless
      // of which path the audio path took.
      const audioTracks = this.mediaStream.getAudioTracks();
      this.videoStream = new MediaStream([...videoTracks, ...audioTracks]);
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
      // If the words in this final utterance span multiple speakers
      // (diarization transition mid-utterance), split into per-speaker
      // segments rather than attributing the whole text to the dominant
      // speaker. Without this, the minority-speaker's words "belong to"
      // the wrong lane until a later final corrects it — ~5s of misattributed
      // captions during every speaker hand-off.
      const segments = splitByContinuousSpeaker(alt.words, transcript);
      // Prefer Deepgram's segment duration; fall back to word timings if missing.
      const totalDuration =
        typeof msg.duration === "number"
          ? msg.duration
          : computeWordsDuration(alt.words);
      if (segments.length <= 1) {
        const speaker = segments[0]?.speaker ?? pickDominantSpeaker(alt.words);
        this.callbacks.onFinalTranscript(transcript, speaker, totalDuration);
      } else {
        // Multi-segment final. Apportion duration across segments by
        // word count if we have one; otherwise each segment carries
        // undefined and the consumer falls back to defaults.
        const wordCount = alt.words?.length ?? 0;
        for (const seg of segments) {
          const segDur =
            totalDuration !== undefined && wordCount > 0
              ? totalDuration * (seg.wordCount / wordCount)
              : undefined;
          this.callbacks.onFinalTranscript(seg.text, seg.speaker, segDur);
        }
      }
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

    // Parallel video+audio recorder for the screen recording, when
    // captureVideo was requested and we have a video stream. Larger
    // chunks here (1s) — no Deepgram latency requirement, just a
    // playable artifact at the end. VP9 + Opus is the broadly-supported
    // WebM combo; we fall back to default WebM if VP9 isn't available
    // (older browsers).
    if (this.videoStream) {
      const videoMime = MediaRecorder.isTypeSupported(
        "video/webm;codecs=vp9,opus"
      )
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm";
      try {
        this.videoRecorder = new MediaRecorder(this.videoStream, {
          mimeType: videoMime,
        });
        this.videoRecorder.ondataavailable = (e) => {
          if (e.data.size === 0) return;
          this.videoChunks.push(e.data);
        };
        this.videoRecorder.start(1000);
      } catch {
        // If MediaRecorder construction fails (rare — codec mismatch
        // or some headless context), don't fail the session — just skip
        // the video recording. Audio path is unaffected.
        this.videoRecorder = null;
      }
    }
  }

  pause() {
    this.paused = true;
    if (this.recorder?.state === "recording") this.recorder.pause();
    if (this.videoRecorder?.state === "recording") this.videoRecorder.pause();
  }

  resume() {
    this.paused = false;
    if (this.recorder?.state === "paused") this.recorder.resume();
    if (this.videoRecorder?.state === "paused") this.videoRecorder.resume();
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

    // Stop the parallel video recorder if we started one. Independent
    // promise — failure here doesn't block the audio path.
    if (this.videoRecorder && this.videoRecorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        this.videoRecorder!.onstop = () => resolve();
        try {
          this.videoRecorder!.stop();
        } catch {
          resolve();
        }
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

    // Release all capture resources: the mic, the tab-share stream if we
    // started one, and the Web Audio graph that mixed them.
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.tabStream?.getTracks().forEach((t) => t.stop());
    this.tabStream = null;
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        await this.audioContext.close();
      } catch {
        /* ignore */
      }
    }
    this.audioContext = null;
    // The mediaStream reference either was the mic stream (already stopped)
    // or a mixed stream whose sources we just released — drop it either way.
    this.mediaStream = null;
    // videoStream's underlying tracks were all owned by tabStream and
    // mediaStream above, both already stopped. Just drop the wrapper.
    this.videoStream = null;

    // Hand back the recorded audio.
    const blob = new Blob(this.audioChunks, { type: "audio/webm" });
    const url = URL.createObjectURL(blob);
    this.callbacks.onAudioReady(url, duration);

    // Hand back the recorded video, if any. Skip when nothing was
    // captured (captureVideo off, or share declined / no video track).
    if (this.videoChunks.length > 0 && this.callbacks.onVideoReady) {
      const videoBlob = new Blob(this.videoChunks, { type: "video/webm" });
      const videoUrl = URL.createObjectURL(videoBlob);
      this.callbacks.onVideoReady(videoUrl, duration);
    }
  }
}

/** Sum (last_word.end - first_word.start) as a fallback when Deepgram's
 *  per-segment `duration` field isn't on the message. */
function computeWordsDuration(
  words: Array<{ start: number; end: number }> | undefined
): number | undefined {
  if (!words || words.length === 0) return undefined;
  const first = words[0]?.start;
  const last = words[words.length - 1]?.end;
  if (typeof first !== "number" || typeof last !== "number") return undefined;
  const d = last - first;
  return d > 0 ? d : undefined;
}

/**
 * Split a final utterance's words into contiguous same-speaker runs,
 * reconstructing each run's text from the words. Used when Deepgram's
 * diarization shifts mid-utterance (end of one speaker's turn bleeds
 * into the start of the next speaker's turn inside a single final).
 * Without this, the minority-speaker's words get attributed to the
 * dominant-speaker's lane for the duration of that utterance.
 *
 * Returns one segment per contiguous speaker run. `fullTranscript` is
 * used as a fallback when the words array is empty or lacks speaker
 * labels (single-segment case).
 */
function splitByContinuousSpeaker(
  words: Array<{ word: string; punctuated_word?: string; speaker?: number }> | undefined,
  fullTranscript: string
): Array<{ speaker: number | undefined; text: string; wordCount: number }> {
  if (!words || words.length === 0) {
    return [{ speaker: undefined, text: fullTranscript, wordCount: 0 }];
  }
  // Group consecutive words whose speaker label is the same.
  const segments: Array<{ speaker: number | undefined; text: string; wordCount: number }> = [];
  let cur: { speaker: number | undefined; parts: string[]; wordCount: number } | null = null;
  for (const w of words) {
    const s = typeof w.speaker === "number" ? w.speaker : undefined;
    const piece = w.punctuated_word || w.word;
    if (!piece) continue;
    if (cur && cur.speaker === s) {
      cur.parts.push(piece);
      cur.wordCount++;
    } else {
      if (cur) {
        segments.push({
          speaker: cur.speaker,
          text: cur.parts.join(" "),
          wordCount: cur.wordCount,
        });
      }
      cur = { speaker: s, parts: [piece], wordCount: 1 };
    }
  }
  if (cur) {
    segments.push({
      speaker: cur.speaker,
      text: cur.parts.join(" "),
      wordCount: cur.wordCount,
    });
  }
  // Guard against pathological cases (no valid words).
  if (segments.length === 0) {
    return [{ speaker: undefined, text: fullTranscript, wordCount: 0 }];
  }
  return segments;
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
