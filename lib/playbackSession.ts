import type { AudioSessionCallbacks } from "./audioSession";
import { useStore } from "./store";

/**
 * File-playback session. Feeds pre-transcribed utterances into the
 * orchestrator as an uploaded recording plays — producing the same Live
 * Commentary experience as a live mic session, except the source is a
 * user-supplied audio file.
 *
 * Flow:
 *   1) constructor takes a File (the recording) + the pre-computed
 *      utterances from /api/transcribe-file (timestamps relative to the
 *      start of the file).
 *   2) start() creates an HTMLAudioElement, begins playback, and pumps
 *      utterances whose `end` timestamp has just been crossed into the
 *      orchestrator's `onFinalTranscript` callback.
 *   3) pause() / resume() forward to the audio element.
 *   4) stop() pauses audio, calls onAudioReady with the blob URL.
 *
 * The shape matches AudioSession so orchestrator.ts can treat it as the
 * same abstraction. Notable differences:
 *   - No interim transcripts (pre-recorded Deepgram gives us finals only).
 *   - Timestamps come from Deepgram's utterance offsets, not wall-clock.
 *   - We don't own the microphone.
 */
export interface TranscribedUtterance {
  text: string;
  speaker?: number;
  start: number;
  end: number;
  duration: number;
}

export interface PlaybackSessionOptions {
  /** When true, the session plays the audio but does NOT emit
   *  utterances through `onFinalTranscript` as playback crosses their
   *  timestamps. Use this when the caller has already pre-loaded the
   *  full transcript into the store — emitting again would duplicate.
   *  Defaults to false (legacy streaming behavior). */
  skipEmit?: boolean;
}

export class PlaybackSession {
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private utterances: TranscribedUtterance[] = [];
  private nextIdx = 0;
  private stopped = false;
  private skipEmit = false;
  /** Total duration of the uploaded file — filled in when metadata loads. */
  private fileDurationSec = 0;

  constructor(
    private file: File,
    utterances: TranscribedUtterance[],
    private callbacks: AudioSessionCallbacks,
    options: PlaybackSessionOptions = {}
  ) {
    this.utterances = [...utterances].sort((a, b) => a.start - b.start);
    this.skipEmit = options.skipEmit ?? false;
  }

  async start() {
    this.audioUrl = URL.createObjectURL(this.file);
    const audio = new Audio(this.audioUrl);
    audio.preload = "auto";
    this.audio = audio;

    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onErr);
        this.fileDurationSec = isFinite(audio.duration) ? audio.duration : 0;
        resolve();
      };
      const onErr = () => {
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onErr);
        reject(new Error("Failed to load audio file"));
      };
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("error", onErr);
    });

    audio.addEventListener("timeupdate", this.onTimeUpdate);
    audio.addEventListener("ended", this.onEnded);
    // Mirror native audio element play/pause into the global live.status
    // so the Dock's Pause/Resume button reflects the actual playback
    // state regardless of who initiated the change (Dock button, player
    // strip, keyboard media keys, etc.). Single source of truth.
    audio.addEventListener("play", this.onPlay);
    audio.addEventListener("pause", this.onPause);

    // Announce the audio element to the UI so it can mount a progress
    // bar / seek control. Detail is the element itself — listeners keep
    // a ref and attach their own timeupdate/pause listeners.
    window.dispatchEvent(
      new CustomEvent("ic:playback-started", { detail: audio })
    );

    try {
      await audio.play();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Playback failed to start";
      this.callbacks.onError(msg);
    }
  }

  private onPlay = () => {
    if (this.stopped) return;
    useStore.getState().setLiveStatus("recording");
  };
  private onPause = () => {
    if (this.stopped) return;
    useStore.getState().setLiveStatus("paused");
  };

  /** Called whenever the audio element's currentTime advances. Emits any
   *  utterance whose end timestamp has been crossed since last tick.
   *  In skipEmit mode this is a no-op — the transcript is already in
   *  the store and time-indexed UI reads directly from playbackTime. */
  private onTimeUpdate = () => {
    if (!this.audio || this.stopped || this.skipEmit) return;
    const t = this.audio.currentTime;
    while (this.nextIdx < this.utterances.length) {
      const u = this.utterances[this.nextIdx];
      if (u.end > t) break;
      this.callbacks.onFinalTranscript(u.text, u.speaker, u.duration);
      this.nextIdx++;
    }
  };

  private onEnded = () => {
    if (!this.skipEmit) {
      // Flush any utterances whose end is at/after file duration but
      // never triggered (rare — happens when utterance.end > audio.duration
      // due to Deepgram's trailing padding).
      while (this.nextIdx < this.utterances.length) {
        const u = this.utterances[this.nextIdx];
        this.callbacks.onFinalTranscript(u.text, u.speaker, u.duration);
        this.nextIdx++;
      }
    }
    // Notify the page so it can show "recording complete → view scoring".
    this.callbacks.onPlaybackEnded?.();
  };

  /**
   * Flush every remaining utterance into the orchestrator immediately,
   * regardless of audio time. Called when the user hits End & Save early
   * — we want scoring to see the ENTIRE transcript, not just the portion
   * that happened to have played by the time they stopped.
   * In skipEmit mode this is a no-op — the transcript is already present.
   */
  flushAllRemaining() {
    if (this.skipEmit) return;
    while (this.nextIdx < this.utterances.length) {
      const u = this.utterances[this.nextIdx];
      this.callbacks.onFinalTranscript(u.text, u.speaker, u.duration);
      this.nextIdx++;
    }
  }

  pause() {
    this.audio?.pause();
  }

  resume() {
    void this.audio?.play();
  }

  async stop() {
    this.stopped = true;
    window.dispatchEvent(new CustomEvent("ic:playback-stopped"));
    if (this.audio) {
      // Full teardown. pause() alone isn't reliable — if a play() promise
      // is in flight (we await one on start, and seeks can queue more) the
      // element can resume briefly after a bare pause. Detach listeners,
      // pause, clear src, and call load() to abort any pending buffering.
      this.audio.removeEventListener("timeupdate", this.onTimeUpdate);
      this.audio.removeEventListener("ended", this.onEnded);
      this.audio.removeEventListener("play", this.onPlay);
      this.audio.removeEventListener("pause", this.onPause);
      try {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.audio.removeAttribute("src");
        this.audio.load();
      } catch {
        /* defensive — element already detached on some browsers */
      }
      this.audio = null;
    }
    // Hand back the blob URL so the past-session AudioPlayer can replay.
    // The URL is still valid here — we don't revoke it because PastView
    // mounts a fresh <audio> element against it. It'll be revoked
    // implicitly when the user navigates away or clears past sessions.
    if (this.audioUrl) {
      this.callbacks.onAudioReady(this.audioUrl, this.fileDurationSec);
    }
  }
}
