/**
 * Web Speech API version of AudioSession.
 *
 * Uses the browser's built-in speech recognition (free, no API key). Same
 * interface as the Deepgram version so the orchestrator doesn't need to
 * change.
 *
 * Caveats vs Deepgram:
 *   - Chrome/Edge only (Safari is too unreliable here)
 *   - Engine disconnects every ~60s; we auto-reconnect and may lose a word
 *   - Accuracy varies by language/accent
 *   - Records audio SEPARATELY with MediaRecorder (because Web Speech API
 *     doesn't expose the raw audio stream)
 *
 * For production, switch to a streaming ASR API like Deepgram.
 */

export interface AudioSessionCallbacks {
  onFinalTranscript: (text: string) => void;
  onInterimTranscript: (text: string) => void;
  onAudioReady: (audioUrl: string, duration: number) => void;
  onError: (msg: string) => void;
}

// Minimal typing for the Web Speech API (not in lib.dom by default)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  [index: number]: { transcript: string; confidence: number };
}
interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
interface SpeechRecognitionCtor {
  new (): SpeechRecognition;
}
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

export class AudioSession {
  private recognition: SpeechRecognition | null = null;
  private mediaStream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private startTime = 0;
  private stopped = false;
  private paused = false;
  /** After 15 chars of speech we lock the detected language so the engine
   *  stops thrashing between en/zh mid-session. */
  private detectedLang: string | null = null;
  private langBuffer = "";

  constructor(private callbacks: AudioSessionCallbacks) {}

  async start() {
    // Browser support check
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this.callbacks.onError(
        "Your browser doesn't support speech recognition. Please use Chrome or Edge."
      );
      return;
    }

    // 1) Get mic permission + stream (for recording playback later)
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
    } catch {
      this.callbacks.onError("Microphone permission denied");
      return;
    }

    // 2) Start recording in parallel (separate from speech recognition)
    this.startRecording();

    // 3) Start speech recognition
    this.recognition = new SR();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    // Start with browser locale; we may switch after detecting CJK chars.
    this.recognition.lang = navigator.language?.startsWith("zh")
      ? "zh-CN"
      : "en-US";

    this.startTime = Date.now();

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) final += text;
        else interim += text;
      }

      if (interim) this.callbacks.onInterimTranscript(interim);
      if (final) {
        const clean = final.trim();
        this.callbacks.onFinalTranscript(clean);
        this.callbacks.onInterimTranscript("");
        this.maybeDetectLang(clean);
      }
    };

    this.recognition.onerror = (e) => {
      if (e.error === "not-allowed") {
        this.callbacks.onError("Microphone permission denied");
        this.stop();
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        // Most errors are recoverable via auto-reconnect in onend
        console.warn("SpeechRecognition error:", e.error);
      }
    };

    // Chrome disconnects the recognition engine every ~60s, even with
    // continuous=true. Auto-reconnect unless we asked to stop.
    this.recognition.onend = () => {
      if (!this.stopped && !this.paused && this.recognition) {
        try {
          this.recognition.start();
        } catch {
          /* race: engine wasn't fully closed yet — ignore */
        }
      }
    };

    try {
      this.recognition.start();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Failed to start recognition";
      this.callbacks.onError(msg);
    }
  }

  private startRecording() {
    if (!this.mediaStream) return;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    this.recorder = new MediaRecorder(this.mediaStream, { mimeType: mime });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };
    this.recorder.start(1000);
  }

  /** After we see enough text, snap the recognition language and stop
   *  letting the browser guess on every utterance. */
  private maybeDetectLang(text: string) {
    if (this.detectedLang) return;
    this.langBuffer += text;
    if (this.langBuffer.length < 15) return;

    const cjk = (this.langBuffer.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (this.langBuffer.match(/[A-Za-z]/g) || []).length;
    const target = cjk > latin ? "zh-CN" : "en-US";

    this.detectedLang = target;
    if (this.recognition && this.recognition.lang !== target) {
      this.recognition.lang = target;
      // Restarting picks up the new language; onend auto-reconnects.
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
    }
  }

  pause() {
    this.paused = true;
    if (this.recorder?.state === "recording") this.recorder.pause();
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
    }
  }

  resume() {
    this.paused = false;
    if (this.recorder?.state === "paused") this.recorder.resume();
    if (this.recognition && !this.stopped) {
      try {
        this.recognition.start();
      } catch {
        /* engine may still be closing */
      }
    }
  }

  async stop() {
    this.stopped = true;
    const duration = (Date.now() - this.startTime) / 1000;

    // Stop recognition
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* ignore */
      }
      this.recognition = null;
    }

    // Stop recorder, wait for final data chunk
    if (this.recorder && this.recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        this.recorder!.onstop = () => resolve();
        this.recorder!.stop();
      });
    }

    // Release mic
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;

    // Hand back the recorded audio
    const blob = new Blob(this.audioChunks, { type: "audio/webm" });
    const url = URL.createObjectURL(blob);
    this.callbacks.onAudioReady(url, duration);
  }
}
