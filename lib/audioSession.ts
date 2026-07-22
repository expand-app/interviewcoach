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
   *  user accepted the "share this tab" prompt.
   *
   *  Each pause/resume cycle produces a SEPARATE recording segment —
   *  the orchestrator-level pause() tears the MediaRecorder down so
   *  the mic indicator + screen-share badge actually go off, and on
   *  resume() a brand-new MediaRecorder is constructed. We give the
   *  caller the per-segment Blobs so it can upload each as its own
   *  S3 object and have the server ffmpeg-concat them with `-c copy`
   *  (no re-encoding, ~1s) into a single MP4 for download.
   *
   *  - segmentUrls: blob: URLs (one per segment) — useful for in-tab
   *    playback of a SINGLE-segment recording. For multi-segment
   *    recordings, the in-tab player should wait for the server to
   *    finish concatenating (`videoConcatPending` on the session).
   *  - duration: total session duration in ms (sum of all segments).
   *  - mime: container/codec MIME, e.g. "video/mp4" or "video/webm".
   *
   *  NOT fired when captureVideo was off, the share dialog was
   *  declined, or the user picked something other than a tab with a
   *  video track. */
  onVideoReady?: (
    segmentUrls: string[],
    duration: number,
    mime: string
  ) => void;
  onError: (msg: string) => void;
  /** Diagnostic hook — fires every time the Deepgram WebSocket closes,
   *  including clean closes triggered by stop()/pause(). Lets the
   *  orchestrator log code/reason/reconnect-attempt to the debug log so
   *  silent socket deaths (e.g. the 27-min stall) are diagnosable
   *  after the fact rather than invisible. Optional — sessions that
   *  don't care just skip wiring this. */
  onWsClose?: (info: {
    code: number;
    reason: string;
    wasClean: boolean;
    /** 0 on the initial close after a fresh start; increments per
     *  reconnect attempt while the socket is being recovered. */
    reconnectAttempt: number;
    willReconnect: boolean;
  }) => void;
  /** Diagnostic-only — fires at key lifecycle moments (share grant/decline,
   *  recorder start, video chunk count at stop, etc.). NOT shown to the
   *  user; the orchestrator funnels these into the debug log so failures
   *  of the captureVideo path are visible in test debriefs (the
   *  "no video saved" report that prompted this hook had no log lines
   *  to localize where the failure happened). */
  onLog?: (event: string, data?: Record<string, unknown>) => void;
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
  /** When true (default), getUserMedia is called for the candidate's
   *  microphone and the mic + tab audio are mixed for both Deepgram
   *  and the saved recording. When false, the mic is NEVER acquired —
   *  the session uses ONLY the tab share's audio. Useful when the
   *  shared tab already contains both sides of the conversation
   *  (playback of a recorded interview, mock-interview YouTube video,
   *  etc.) and the candidate's mic would only add room noise / mouse
   *  clicks. Requires captureTabAudio !== "off" — without tab audio,
   *  setting useMic=false would leave no audio source at all (the
   *  orchestrator should validate this before passing the option). */
  useMic?: boolean;
  /** When true, prompt the user (after the optional tab-audio share) to
   *  share THIS interview-coach tab — `preferCurrentTab: true` makes
   *  the current tab the highlighted default in the picker. The captured
   *  video is OUR own UI (Phase chip, Live Commentary, Live Captions,
   *  etc. as they update during the session), recorded into a parallel
   *  WebM with the same mixed audio Deepgram receives. Fires
   *  onVideoReady on stop().
   *
   *  We deliberately do NOT reuse the tab-audio share's video track
   *  anymore (older approach) — that recorded the interviewer's Zoom
   *  tab, which was the wrong artifact for review. The user wants a
   *  recording of OUR commentary stream, not theirs.
   *
   *  Costs: one extra share dialog at session start (and again on
   *  resume() if the session is paused). User-declined silently falls
   *  back to no video — audio path is unaffected. */
  captureVideo?: boolean;
  /** What captureVideo records. "screen" (default) is the existing
   *  share-this-tab + Region Capture path. "camera" records the
   *  user's webcam via getUserMedia instead — used by the Retake
   *  (mock interview) flow, where the artifact to review is the
   *  candidate on camera, not our UI. Camera mode skips ALL of the
   *  screen-path machinery (crop, zoom-lock transitions, share-ended
   *  watchdog) and, unlike the screen path, camera denial is
   *  NON-fatal: the session continues audio-only. */
  videoSource?: "screen" | "camera";
  /** Extra audio stream mixed into the recording + STT feed alongside
   *  the mic. The Retake flow passes the TTS output's
   *  MediaStreamDestination stream here so the AI interviewer's voice
   *  is (a) audible in the saved recording and (b) transcribed by
   *  Deepgram — giving interviewer utterances in the transcript with
   *  zero extra plumbing. Forces the Web-Audio mixing path even when
   *  tab audio is absent. */
  auxAudioStream?: MediaStream;
  /** Per-instance overrides merged over the default Deepgram query
   *  (model/language/etc). The Retake flow uses this for
   *  Chinese-language sessions ({ language: "zh", model: "nova-2" })
   *  since the default is pinned to nova-3/en. */
  sttQueryOverrides?: Record<string, string>;
  /** Skip the Deepgram WebSocket entirely — capture + mix + record the
   *  audio, but produce NO transcripts from AudioSession. Used by the
   *  Retake OpenAI-realtime engine, where the candidate's and AI's
   *  transcripts come from OpenAI's realtime events instead. The
   *  MediaRecorder still runs (recording/download unaffected) and the
   *  aux mixing still applies (AI voice → recording). Default false —
   *  the live path and the Aura-TTS Retake path keep Deepgram STT. */
  disableStt?: boolean;
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
  /** Separate getDisplayMedia stream for the SELF-tab (interview-coach)
   *  video capture. Acquired with `preferCurrentTab: true` after the
   *  optional tab-audio share, only when options.captureVideo is true.
   *  Held so tearDown() can release it. Tracks here are NEVER fed to
   *  Deepgram — video only, audio comes from the existing mediaStream. */
  private selfTabStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  /** Diagnostic audio-level analyzer. Independent AudioContext that
   *  taps the same MediaStream the recorder + Deepgram see, runs a
   *  Web Audio AnalyserNode, and samples RMS energy. Lets us
   *  distinguish "no audio coming in" (mediaStream went silent — tab
   *  audio source disappeared, both speakers paused) from "audio
   *  coming in but no transcripts" (Deepgram WS dead or broken)
   *  in postmortems. Without this, both failure modes look identical
   *  in session_events: utterances simply stop arriving. Set up in
   *  startAudioRmsSampling(), torn down in tearDown(). */
  private audioAnalyserCtx: AudioContext | null = null;
  private audioAnalyserSource: MediaStreamAudioSourceNode | null = null;
  private audioAnalyserNode: AnalyserNode | null = null;
  private audioRmsSamplerTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks whether the most recent RMS sample was below the silence
   *  threshold. State is needed to emit one-off "audio:silence" /
   *  "audio:resumed" transition events instead of per-sample logs. */
  private audioInSilence: boolean = false;
  private audioSilenceStartedAt: number = 0;
  private audioRmsLastHeartbeatAt: number = 0;
  private recorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  /** Cap on accumulated audio chunks. 250ms each, so 4 hours = 57,600
   *  chunks (~250 MB at opus). Beyond that we drop oldest with a one-
   *  shot warning — saves the page from OOM if the inactivity auto-
   *  pause somehow doesn't fire (e.g. trickle of background noise
   *  keeping `lastTranscriptAt` fresh while no real interview is
   *  happening). The user gets a recording of the LAST 4 hours; the
   *  beginning is sacrificed. Better than the page becoming
   *  unresponsive and losing everything. */
  private static MAX_AUDIO_CHUNKS = 4 * 60 * 60 * 4; // 4h × 60min × 4chunks/sec
  private audioChunksDroppedWarned = false;
  /** Optional second recorder for video+audio output. Only spun up when
   *  options.captureVideo is true AND the user accepted the
   *  share-this-tab prompt with a video track. */
  private videoRecorder: MediaRecorder | null = null;
  /** Per-segment chunk store. Each top-level entry corresponds to ONE
   *  pause/resume cycle (or just the single full recording if the
   *  user never paused). The orchestrator-level pause() tears the
   *  MediaRecorder down — we can't keep a single MediaRecorder alive
   *  across pause without leaking the mic indicator and screen-share
   *  badge — so each resume produces a NEW recorder whose chunks
   *  belong to a new top-level array.
   *
   *  This shape is critical for MP4 recording: naively concatenating
   *  multiple MP4 segments into one Blob produces an invalid file
   *  (each segment carries its own ftyp+moov boxes, and demuxers
   *  reject the duplicates with MediaError code 4). By keeping
   *  segments distinct we can upload each separately and let the
   *  server ffmpeg-concat them with `-c copy` — a non-re-encoding
   *  remux that takes ~1s and produces a single valid MP4.
   *
   *  Always at least 1 entry while recording (the current segment).
   *  The last entry is the segment currently being filled by
   *  ondataavailable; pause() / stop() flush it then push a fresh
   *  empty array on next start(). */
  private videoSegments: Blob[][] = [];
  /** First-share video track that has Region Capture cropTo applied.
   *  Held so we can re-prime the crop after layout-changing events
   *  (fullscreen toggle, viewport resize) — the cropTarget is bound
   *  to the element by reference, but Chrome's tracking of the
   *  element's bounds during dramatic reflows is unreliable in
   *  practice and produces garbled frames at the transition. Calling
   *  refreshVideoCrop() after the layout settles re-locks the crop
   *  to current element bounds and recovers a clean recording. */
  private croppedVideoTrack: MediaStreamTrack | null = null;
  /** ResizeObserver on the cropTarget element. Fires whenever the
   *  element's bounding box changes — most notably from browser
   *  zoom (Ctrl+/-) and window resize. Chrome's Region Capture is
   *  meant to auto-track size changes but produces garbled frames
   *  at the transition; debounced refreshVideoCrop() re-locks the
   *  bounds and recovers a clean recording. */
  private cropResizeObserver: ResizeObserver | null = null;
  private cropRefreshDebounceTimer: ReturnType<typeof setTimeout> | null =
    null;
  /** Window-level listeners that catch zoom intent BEFORE the browser
   *  starts re-rendering at the new zoom level. ResizeObserver only
   *  fires after the cropTarget's bounds have already changed — at
   *  which point a few garbled frames have already been encoded.
   *  Three signals, all wired to the same pre-emptive pause:
   *    - keydown: Ctrl/Cmd + =/+/-/_/0 (browser keyboard zoom)
   *    - wheel: ctrlKey-modified scroll (trackpad pinch on macOS,
   *      Ctrl+wheel on Windows)
   *    - visualViewport.resize: fires earlier than per-element
   *      ResizeObserver because the viewport-level reflow happens
   *      before child layout settles.
   *  Held so tearDown() can detach them. */
  private cropZoomKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private cropZoomWheelHandler: ((e: WheelEvent) => void) | null = null;
  private cropZoomViewportHandler: (() => void) | null = null;
  /** Window-level resize listener — catches dragging the browser
   *  edge, maximize/minimize, monitor connect/disconnect, and any
   *  OS-driven viewport size change. Each fire calls
   *  handleCropTransition (debounced 500ms) so the videoRecorder
   *  pauses through the resize and resumes after layout settles.
   *  Held so tearDown() can detach. */
  private cropWindowResizeHandler: (() => void) | null = null;
  /** `fullscreenchange` listener — catches F11 / native macOS green-
   *  button fullscreen, separate from the in-app Fullscreen toggle
   *  (which has its own orchestrator.triggerCropTransition call).
   *  These OS-level fullscreens change the viewport without firing
   *  any of the keyboard / wheel / window-resize listeners reliably,
   *  so they need their own hook. Held so tearDown() can detach. */
  private cropFullscreenHandler: (() => void) | null = null;
  /** Zoom-LOCK listeners (separate from the zoom-pause/resume
   *  mitigation listeners above). These actively block the browser's
   *  zoom-in/-out shortcuts during a recording session — keyboard
   *  Ctrl/Cmd + =/+/-/_/0 and trackpad pinch (wheel + ctrlKey) — so
   *  the cropTarget bounds never change mid-recording, which is the
   *  root cause of the garbled-frame issue. The pause/resume
   *  mitigation above stays in place as defense-in-depth for window
   *  resize and any zoom paths we can't lock (browser menu, OS-level
   *  Accessibility zoom).
   *
   *  Attached at start() entry, detached in abortSession()/tearDown().
   *  Outside of an active session, zoom works normally — users can
   *  pre-zoom to their preferred view size before clicking Start. */
  private zoomLockKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private zoomLockWheelHandler: ((e: WheelEvent) => void) | null = null;
  /** Window scroll listener that re-primes cropTo against the
   *  cropTarget element. Region Capture is supposed to follow the
   *  element as it scrolls within the captured tab, but in practice
   *  Chrome's compositor sometimes lags — stale frames bleed
   *  whatever was previously above the element (e.g. the page
   *  title) into the recorded region. Refreshing cropTo on scroll
   *  forces Chrome to re-acquire the element's current bounds.
   *  Throttled so a continuous scroll doesn't fire dozens of
   *  cropTo() calls per second. */
  private cropScrollHandler: (() => void) | null = null;
  private cropScrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cap on accumulated video chunks. 1s each, so 4 hours = 14,400
   *  chunks. At ~50-200 KB per chunk (5-15 Mbps), 4 hours can exceed
   *  4 GB. Beyond cap, drop oldest with one-shot warning. */
  private static MAX_VIDEO_CHUNKS = 4 * 60 * 60; // 4h × 60min × 1chunk/sec
  private videoChunksDroppedWarned = false;
  /** Set to true the moment the screen-share track ends mid-session
   *  (Chrome's "Stop sharing" button OR a window-display move that
   *  invalidates the share). Lets resumeScreenShare() distinguish a
   *  legit recovery request from a spurious double-click. Reset back
   *  to false on successful re-acquisition. */
  private shareEnded = false;
  /** Watchdog interval for catching the case where Chrome ends the
   *  capture track but doesn't fire the `ended` event reliably (a
   *  known Chromium quirk on some macOS / multi-display configs).
   *  Polls track.readyState every 2s and triggers the share-ended
   *  flow if the track is "ended" but our listener never fired. */
  private shareTrackWatchdog: ReturnType<typeof setInterval> | null = null;
  /** MIME type the videoRecorder actually used. Captured at recorder
   *  construction time so the final Blob can be tagged correctly and
   *  downstream code (download filename extension) knows mp4 vs webm
   *  without re-sniffing bytes. Empty until the first recorder starts. */
  private videoMime: string = "";
  /** Combined stream fed to videoRecorder: video track from selfTabStream
   *  + the same mixed audio destination Deepgram receives. Held so we
   *  can release it cleanly on stop. */
  private videoStream: MediaStream | null = null;
  /** Webcam stream when options.videoSource === "camera". Held both
   *  for teardown and so the call UI can render a live self-view tile
   *  (via getCameraStream()). Video track feeds videoRecorder; the
   *  camera's own audio is never used (mic is captured separately). */
  private cameraStream: MediaStream | null = null;
  /** Gain node between the mic source and the mixed destination.
   *  Only exists on the Web-Audio mixing path (tab audio or
   *  auxAudioStream present). setMicGain() drives it: the Retake flow
   *  zeroes it while TTS plays (echo guard) and the call UI's mute
   *  button toggles it. */
  private micGainNode: GainNode | null = null;

  /** Live webcam stream for the self-view tile, or null when camera
   *  capture is off / was denied. */
  public getCameraStream(): MediaStream | null {
    return this.cameraStream;
  }

  /** Set the mic's contribution to the recording + STT mix. 0 = muted,
   *  1 = normal. No-op when the session isn't on the mixing path
   *  (plain mic-only live sessions don't need it). */
  public setMicGain(v: number): void {
    if (this.micGainNode) {
      this.micGainNode.gain.value = v;
    }
  }

  /** Gesture-driven backstop for the autoplay policy: if the mixing
   *  AudioContext is stuck "suspended" (created outside a user
   *  gesture), call this from any pointerdown/keydown handler to
   *  bring the graph — and with it the mic → Deepgram feed — back
   *  to life. Safe to call repeatedly. */
  public resumeAudioGraph(): void {
    if (this.audioContext && this.audioContext.state === "suspended") {
      void this.audioContext.resume().catch(() => {});
    }
  }
  /** Wall-clock when the CURRENT run-segment started (i.e. last
   *  start() / resume() call). Reset on each resume, so it only
   *  measures the active recording slice. Pause/resume cycles
   *  accumulate into accumulatedDurationMs. */
  private startTime = 0;
  /** Total recording duration across all pause/resume cycles, in ms.
   *  On pause, we add (now - startTime) into this accumulator and
   *  tear down. On stop, we add the final segment too and report
   *  the sum. Without this, a paused-then-resumed session would
   *  report only the duration of the last segment. */
  private accumulatedDurationMs = 0;
  private stopped = false;
  /** Public readonly view of the `stopped` flag. The orchestrator
   *  checks this in start() so that a re-Start AFTER an abort
   *  (abortSession() flips stopped=true without nulling the
   *  orchestrator's `this.audio` ref) can detect "the prior session
   *  is dead — clear the ref and spin up a new one" instead of
   *  early-returning on the stale instance. */
  public get isStopped(): boolean {
    return this.stopped;
  }
  private paused = false;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Deepgram closes the socket after 12s of silence; ping it every 8s. */
  private static KEEP_ALIVE_MS = 8000;
  /** Reconnect bookkeeping. The user's 27-min session went silent for
   *  3 min then ended — diagnosis pointed at an unrecovered Deepgram
   *  socket close. The fix: detect unexpected close events and re-open
   *  the WS with a fresh token, while the existing MediaRecorder keeps
   *  buffering. ondataavailable's `readyState === OPEN` check means
   *  chunks during the gap are dropped (their transcripts are lost) —
   *  acceptable cost vs. silently losing the rest of the session. */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cap on consecutive reconnect attempts before giving up and surfacing
   *  a hard error to the user (who can then Pause + Resume to fully
   *  rebuild the pipeline including mic / tab streams).
   *
   *  Set generously (15) because users on the China side of the GFW
   *  routinely see 6-10 transient connection resets in a row before the
   *  link stabilizes — a tighter cap would surface a hard error during
   *  what is in fact a recoverable jitter event. The exponential backoff
   *  is bounded at 3s (see scheduleReconnect), so 15 attempts cover at
   *  most ~30s of total reconnect time. */
  private static MAX_RECONNECTS = 15;

  /** Audio chunks captured while the Deepgram WebSocket is reconnecting.
   *  Without this buffer, ondataavailable's `readyState === OPEN` guard
   *  silently drops every 250ms chunk during the gap → those words are
   *  permanently lost from the live captions. We keep a bounded ring
   *  (latest N chunks, oldest evicted) and flush it the moment the WS
   *  comes back so transcription catches up to the recorded audio. */
  private pendingChunks: Blob[] = [];
  /** Max chunks held while reconnecting. 60 × 250ms = 15s of audio,
   *  which comfortably covers the worst case of MAX_RECONNECTS × 3s
   *  backoff. Capped to bound memory in case reconnect never succeeds. */
  private static MAX_PENDING_CHUNKS = 60;

  constructor(
    private callbacks: AudioSessionCallbacks,
    private options: AudioSessionOptions = {}
  ) {}

  async start() {
    // start() is called both for fresh sessions AND for resume() after
    // a pause(). Reset the per-run flags so subsequent calls work.
    // audioChunks / videoChunks / accumulatedDurationMs intentionally
    // persist across resume so the saved recording covers the full
    // session — see pause() for the duration accumulation.
    this.stopped = false;
    this.paused = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 0) Lock browser zoom for the entire session. Block keyboard
    //    Ctrl/Cmd + =/+/-/_/0 and trackpad pinch (wheel with ctrlKey)
    //    so the user can't accidentally trigger a zoom mid-recording
    //    — that's the root cause of the garbled-frame artifacts at
    //    the cropTarget bounds. Pre-Start zoom is fine; users can set
    //    their preferred view size before clicking Start (StartModal
    //    has copy explaining this). Listeners are attached BEFORE the
    //    share dialogs because the dialogs themselves don't care
    //    about zoom and we want symmetry: locked the whole time
    //    AudioSession is alive.
    //
    //    Browser-menu zoom (View → Zoom In, three-dot menu) and
    //    OS-level zoom (macOS Accessibility) cannot be intercepted
    //    from JS — those are still possible escape hatches but
    //    require deliberate user action that's vanishingly unlikely
    //    during a real interview. The pause/resume mitigation
    //    listeners attached later in this method serve as defense-
    //    in-depth for those edge cases.
    if (typeof window !== "undefined") {
      this.zoomLockKeyHandler = (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (
          e.key === "=" ||
          e.key === "+" ||
          e.key === "-" ||
          e.key === "_" ||
          e.key === "0"
        ) {
          e.preventDefault();
        }
      };
      window.addEventListener("keydown", this.zoomLockKeyHandler, {
        capture: true,
      });
      this.zoomLockWheelHandler = (e: WheelEvent) => {
        // Trackpad pinch on macOS / Ctrl+wheel on Windows — both
        // arrive as wheel events with ctrlKey set. Non-passive
        // listener required so preventDefault() actually takes
        // effect (default wheel listeners are passive in modern
        // Chromium).
        if (e.ctrlKey || e.metaKey) e.preventDefault();
      };
      window.addEventListener("wheel", this.zoomLockWheelHandler, {
        passive: false,
        capture: true,
      });
      this.callbacks.onLog?.("zoom:locked", {});
    }
    // 1) Mic.
    //
    //    Skipped entirely when options.useMic === false — the user
    //    has elected to record only the shared tab's audio (e.g.
    //    they're playing back a recorded interview where both sides
    //    are already in the audio stream). In that mode the session
    //    has no mic noise, no click-sound issues, and consumes one
    //    less permission grant.
    //
    //    Otherwise, two profiles depending on whether tab/system
    //    audio is also being captured:
    //
    //    System-audio path (the common case):
    //      - The interviewer's voice arrives through the tab share,
    //        so the mic ONLY needs the candidate's voice.
    //      - echoCancellation: ON — broadband suppression that helps
    //        attenuate trackpad/keyboard click transients (the cheap
    //        noiseSuppression profile alone misses these because it's
    //        tuned for stationary noise, not impulses).
    //      - noiseSuppression: ON — same reasoning.
    //      - autoGainControl: OFF — AGC AMPLIFIES quiet transients
    //        (mouse clicks!) when the candidate is silent, making
    //        them louder in the recording.
    //
    //    Mic-only fallback (no system audio):
    //      - The interviewer's voice may be reaching the mic via room
    //        speakers. EC + NS would attenuate it; AGC helps with
    //        varied mic distance. So all three flip to legacy config.
    const wantsTabAudio =
      (this.options.captureTabAudio ?? "auto") !== "off";
    // Mock-interview mode (Retake): the AI interviewer's voice plays
    // through the candidate's SPEAKERS and would otherwise bleed into
    // the mic. We already gain-zero the mic during TTS windows, but
    // echoCancellation ON is the real defense for residual bleed
    // (and for candidates on speakers generally). auxAudioStream is
    // the reliable signal that this is mock mode. Force the EC/NS-on,
    // AGC-off profile even though captureTabAudio is "off" here.
    const isMockMode = !!this.options.auxAudioStream;
    const wantEcNs = wantsTabAudio || isMockMode;
    const useMic = this.options.useMic !== false; // default true
    if (useMic) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: wantEcNs,
            noiseSuppression: wantEcNs,
            autoGainControl: !wantEcNs,
            channelCount: 1,
          },
        });
      } catch {
        this.callbacks.onError("Microphone permission denied");
        return;
      }
    } else {
      this.callbacks.onLog?.("mic:skipped", { reason: "useMic-disabled" });
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
          // The video tracks here are throwaway — we always stop them
          // immediately. The screen recording uses a SEPARATE
          // getDisplayMedia call below targeting THIS interview-coach tab.
          video: true,
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          // Hint to Chrome 114+ that we genuinely want the audio half of
          // the share. Effect on the picker:
          //   - "Chrome Tab" tab: pre-checks the "Also share tab audio"
          //     toggle in the dialog (vs. the default unchecked).
          //   - "Window" / "Entire Screen" tabs: pre-checks "Also share
          //     system audio" on platforms that support it (Windows /
          //     ChromeOS — macOS doesn't expose system audio at all).
          // It's a hint, not a force — the user can still toggle it
          // off, in which case our `getAudioTracks().length === 0`
          // branch below catches it and surfaces the warn-toast.
          // @ts-expect-error systemAudio not in TS lib.dom yet
          systemAudio: "include",
        });
        for (const t of this.tabStream.getVideoTracks()) t.stop();
        if (this.tabStream.getAudioTracks().length === 0) {
          // User didn't check "Share audio" — useless without it.
          for (const t of this.tabStream.getTracks()) t.stop();
          this.tabStream = null;
          this.callbacks.onError(
            "Tab audio share had no audio track — re-enable \"Share tab audio\" in the browser prompt. Continuing with mic-only."
          );
        } else {
          // Diagnostic — wire `ended` listeners on the tab audio
          // track(s) so we know when the user closes the source tab,
          // navigates away, or the tab capture ends for any other
          // reason. Without this hook, tab-audio death looks identical
          // to "real silence" in postmortems: utterances simply stop
          // arriving with no other signal. The `ended` event is the
          // canonical browser signal that a MediaStreamTrack is
          // terminally done — once it fires, no more audio frames
          // will flow even if the MediaStream object is still alive.
          for (const t of this.tabStream.getAudioTracks()) {
            t.addEventListener("ended", () => {
              this.callbacks.onLog?.("tab-audio:track-ended", {
                label: t.label || "(no-label)",
                readyState: t.readyState,
                muted: t.muted,
              });
            });
            // Some browsers fire `mute` instead of `ended` when the
            // source goes silent (esp. system-audio capture with no
            // active producer). Less terminal than `ended` but worth
            // logging — if mute lasts and is followed by silence,
            // that's the same operational failure.
            t.addEventListener("mute", () => {
              this.callbacks.onLog?.("tab-audio:track-mute", {
                label: t.label || "(no-label)",
                readyState: t.readyState,
              });
            });
            t.addEventListener("unmute", () => {
              this.callbacks.onLog?.("tab-audio:track-unmute", {
                label: t.label || "(no-label)",
                readyState: t.readyState,
              });
            });
          }
        }
      } catch {
        // User cancelled or not supported — keep going with mic only.
        this.tabStream = null;
        this.callbacks.onError(
          "Tab audio capture declined — continuing with mic-only. Interviewer voice won't be transcribed unless laptop speakers are on."
        );
      }
    }

    // 1b) Build the stream handed to MediaRecorder + Deepgram. Four
    //     branches:
    //       (a) mic + (tab and/or aux) → mix via Web Audio
    //       (b) mic only  → use mic directly
    //       (c) tab only  → use tab audio directly (useMic === false)
    //       (d) neither   → no audio source, abort
    //
    //     The aux stream (Retake TTS output) forces the mixing path
    //     so the AI voice reaches both the recording and Deepgram.
    //     The mic goes through a GainNode on this path so the Retake
    //     controller can zero it while TTS plays (echo guard) and the
    //     call UI can implement mute.
    const hasTabAudio =
      !!this.tabStream && this.tabStream.getAudioTracks().length > 0;
    const auxStream = this.options.auxAudioStream ?? null;
    if (this.micStream && (hasTabAudio || auxStream)) {
      this.audioContext = new AudioContext();
      // Autoplay policy: a context created OUTSIDE a user-gesture
      // window starts "suspended" — the whole mixing graph then
      // produces silence (mic never reaches Deepgram or the
      // recorder, TTS never reaches the mix). This bit the Retake
      // flow, whose start runs several seconds after the click
      // (plan generation in between). Resume defensively and log
      // the state so a still-suspended context is visible in
      // diagnostics; resumeAudioGraph() is the gesture-driven
      // backstop.
      if (this.audioContext.state === "suspended") {
        void this.audioContext.resume().catch(() => {});
      }
      this.callbacks.onLog?.("audio:context-state", {
        state: this.audioContext.state,
      });
      const dest = this.audioContext.createMediaStreamDestination();
      this.micGainNode = this.audioContext.createGain();
      this.audioContext
        .createMediaStreamSource(this.micStream)
        .connect(this.micGainNode);
      this.micGainNode.connect(dest);
      if (hasTabAudio) {
        this.audioContext
          .createMediaStreamSource(
            new MediaStream(this.tabStream!.getAudioTracks())
          )
          .connect(dest);
      }
      if (auxStream) {
        this.audioContext.createMediaStreamSource(auxStream).connect(dest);
        this.callbacks.onLog?.("audio:aux-mixed", {
          auxTracks: auxStream.getAudioTracks().length,
        });
      }
      this.mediaStream = dest.stream;
    } else if (this.micStream) {
      this.mediaStream = this.micStream;
    } else if (hasTabAudio) {
      // Mic-skipped path. Use the tab audio as the sole source.
      this.mediaStream = new MediaStream(this.tabStream!.getAudioTracks());
    } else {
      // Both sources absent — hard requirement violated. Either the
      // user turned off Microphone in Start AND declined "Share tab
      // audio" in the picker, or both shares failed. Either way the
      // session has no sound to transcribe → must abort.
      this.abortSession(
        "No audio source — turn on Microphone in Start, OR check \"Share tab audio\" when picking the interview tab. At least one is required."
      );
      return;
    }

    // 1b.5) Start the diagnostic RMS sampler. Non-destructive tap on
    //       the same MediaStream the recorder + Deepgram see. Safe
    //       failure — if AudioContext init throws (older browsers,
    //       low-resource hosts), we log and skip; no impact on
    //       recording or transcription.
    this.startAudioRmsSampling();

    // 1c) Screen recording — a SECOND getDisplayMedia targeting THIS
    //     interview-coach tab. Records the LiveView UI itself (Phase
    //     chip, Live Commentary stream, Live Captions) so the user can
    //     review the AI's reactions afterwards. Audio is the same mic
    //     +tab mix Deepgram sees, so the recording is on the same clock
    //     as the transcript.
    //
    //     `preferCurrentTab` is Chromium-only — it makes "this tab" the
    //     highlighted default in the picker. On Firefox/Safari the flag
    //     is ignored and the user picks manually. Either way the user
    //     has to confirm — browser security model doesn't let us
    //     auto-grant.
    //
    //     If they decline / pick the wrong source / browser doesn't
    //     support it, we log a soft error and continue without video.
    //     Audio path is unaffected.
    if (this.options.captureVideo && this.options.videoSource === "camera") {
      // ============================================================
      // Camera path (Retake / mock interview). Records the user's
      // webcam instead of a screen share. Deliberately skips ALL of
      // the screen machinery below: no Region Capture crop, no
      // zoom-lock transition listeners, no share-ended watchdog —
      // none of it applies to a camera track. Camera denial is
      // NON-fatal: the retake continues audio-only and the call UI
      // shows an avatar in the self-view tile.
      // ============================================================
      this.callbacks.onLog?.("video:begin", { source: "camera" });
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        });
        const camTracks = this.cameraStream.getVideoTracks();
        if (camTracks.length === 0) {
          for (const t of this.cameraStream.getTracks()) t.stop();
          this.cameraStream = null;
          this.callbacks.onLog?.("video:camera-no-tracks");
        } else {
          const audioTracks = this.mediaStream.getAudioTracks();
          this.videoStream = new MediaStream([
            ...camTracks,
            ...audioTracks,
          ]);
          this.callbacks.onLog?.("video:camera-stream-built", {
            videoTracks: camTracks.length,
            audioTracks: audioTracks.length,
          });
          camTracks[0].addEventListener("ended", () => {
            // Camera unplugged / OS revoked permission mid-call.
            // Finalize the current segment; audio keeps going.
            this.callbacks.onLog?.("video:camera-track-ended", {});
            if (
              this.videoRecorder &&
              this.videoRecorder.state !== "inactive"
            ) {
              try {
                this.videoRecorder.stop();
              } catch {
                /* already stopping */
              }
            }
          });
        }
      } catch (e) {
        const err = e as { name?: string; message?: string };
        this.cameraStream = null;
        this.callbacks.onLog?.("video:camera-denied", {
          name: err?.name ?? "unknown",
          message: err?.message ?? String(e),
        });
        this.callbacks.onError(
          "Camera unavailable — continuing with audio only."
        );
      }
    } else if (this.options.captureVideo) {
      this.callbacks.onLog?.("video:begin", {
        hadTabAudio: !!this.tabStream,
      });
      // Tell the user the second share is intentional — the StartModal
      // copy mentions it but a mid-flow toast removes any confusion
      // about "why is another share dialog appearing?". Especially
      // important since the gap between dialogs can be ~1-2 seconds.
      this.callbacks.onError(
        "Next: pick THIS interview-coach tab so we can record the live commentary alongside the audio."
      );
      try {
        // Constraints rationale:
        // - frameRate ideal=30 keeps the encoder on a steady cadence;
        //   with `video: true` alone the browser may deliver wildly
        //   variable framerates under CPU pressure, which fights the
        //   encoder's GOP layout and produces visible blocking when
        //   the UI changes fast (text streaming in, list jumping).
        // - width/height: ideal AND max set to 1920x1080. Chrome's
        //   getDisplayMedia historically ignores `max` alone — adding
        //   `ideal` makes the spec-compliant path more likely to honor
        //   the cap on first acquisition. We also call applyConstraints
        //   on the resulting track as a hard fallback (see below).
        //   This matters on HiDPI laptops (Retina, Windows 125-150%
        //   scaling) where the native captured surface is 2880x1800
        //   or higher — at our 10Mbps target, the encoder runs out of
        //   bits per pixel on text-heavy frames and produces blocking
        //   artifacts ("花屏"). Downscaling to 1080p before encode
        //   gives ~5x more bits/pixel which solves the artifact.
        this.selfTabStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
          },
          audio: false,
          // @ts-expect-error preferCurrentTab is Chromium-specific (not in spec yet)
          preferCurrentTab: true,
        });
        const videoTracks = this.selfTabStream.getVideoTracks();
        // Hard fallback: try to renegotiate the track to 1920x1080@30
        // if the initial constraints didn't take. Chrome's
        // getDisplayMedia silently captures at native resolution on
        // some HiDPI configs even when constraints are passed at
        // acquisition; applyConstraints on the resulting
        // BrowserCaptureMediaStreamTrack is honored more reliably.
        // Failure here is non-fatal — we just record at whatever
        // resolution the browser gave us.
        if (videoTracks[0]) {
          try {
            await videoTracks[0].applyConstraints({
              frameRate: { ideal: 30, max: 30 },
              width: { ideal: 1920, max: 1920 },
              height: { ideal: 1080, max: 1080 },
            });
          } catch (e) {
            this.callbacks.onLog?.("video:apply-constraints-failed", {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        const settings = videoTracks[0]?.getSettings?.() ?? {};
        this.callbacks.onLog?.("video:share-granted", {
          videoTrackCount: videoTracks.length,
          // displaySurface is "browser" / "window" / "monitor" — useful
          // to know whether the user picked a tab vs the whole screen.
          displaySurface:
            (settings as { displaySurface?: string }).displaySurface ?? null,
          // Effective width/height AFTER applyConstraints — diagnoses
          // the HiDPI blocking case: if these come back >1920 the
          // browser ignored both constraint passes and we know to push
          // bitrate up further or switch codec.
          width: (settings as { width?: number }).width ?? null,
          height: (settings as { height?: number }).height ?? null,
          frameRate: (settings as { frameRate?: number }).frameRate ?? null,
          // Browser's reported devicePixelRatio explains discrepancies:
          // a 2880x1800 share on a 2x DPR laptop comes from a 1440x900
          // logical surface. If logged width/height >> 1920, this is
          // why.
          devicePixelRatio:
            typeof window !== "undefined" ? window.devicePixelRatio : null,
        });
        if (videoTracks.length === 0) {
          for (const t of this.selfTabStream.getTracks()) t.stop();
          this.selfTabStream = null;
          this.callbacks.onLog?.("video:no-tracks");
          // Hard requirement: screen recording must succeed. A share
          // dialog with no video track means the user picked something
          // that didn't expose video (rare). Abort cleanly so the
          // user can re-Start.
          this.abortSession(
            "Screen share had no video track. Click Start again and pick the puebulo tab when prompted."
          );
          return;
        } else {
          // If user picked something OTHER than the current tab, the
          // recording will still work — it'll capture whatever they
          // picked. We don't fight that; some users may want to record
          // a different layout. The label/displaySurface is logged for
          // diagnosis but not enforced.
          const audioTracks = this.mediaStream.getAudioTracks();
          this.videoStream = new MediaStream([
            ...videoTracks,
            ...audioTracks,
          ]);
          this.callbacks.onLog?.("video:stream-built", {
            videoTracks: videoTracks.length,
            audioTracks: audioTracks.length,
          });

          // Region Capture: crop the captured tab down to just the
          // LiveView card (#ic-capture-region) so the recording
          // contains only the Lead Question + Live Commentary + Live
          // Captions panel, not the surrounding sidebar / topbar /
          // right-rail debug pane. Chromium 104+ via CropTarget.
          //
          // The crop is dynamic — as the card's bounding box changes
          // (Lead Question wraps to two lines, etc.) the recording
          // updates. When the element unmounts (e.g. user navigates
          // to Past view mid-recording), the recording goes black;
          // acceptable since recording is meant to span a live session
          // where Live view is always mounted.
          //
          // Silent fallback paths:
          //   - API not available (old Chrome / non-Chromium) → full
          //     tab capture continues, just uncropped.
          //   - Element not in DOM → same fallback.
          //   - User picked a DIFFERENT tab in the share dialog →
          //     cropTo throws (target not in captured surface), we
          //     keep the full uncropped capture of whatever they
          //     shared. Better to record everything than fail.
          try {
            const Ctor = (
              globalThis as {
                CropTarget?: {
                  fromElement?: (el: Element) => Promise<unknown>;
                };
              }
            ).CropTarget;
            if (Ctor && typeof Ctor.fromElement === "function") {
              const target = document.getElementById("ic-capture-region");
              if (target) {
                const cropTarget = await Ctor.fromElement(target);
                // @ts-expect-error cropTo only exists on BrowserCaptureMediaStreamTrack
                await videoTracks[0].cropTo(cropTarget);
                // Save the track ref so refreshVideoCrop() can
                // re-prime the crop after layout-changing events
                // (fullscreen toggle, etc.).
                this.croppedVideoTrack = videoTracks[0];
                this.callbacks.onLog?.("video:cropped", {
                  targetId: "ic-capture-region",
                });
                // Auto-recover from browser zoom / window resize.
                // FOUR signals feed the same handler — see
                // handleCropTransition() for the full pause/resume
                // cycle. Layered redundancy because no single signal
                // is both early enough AND reliable across input
                // modes:
                //   - keydown (pre-emptive, Ctrl+/-/0 keyboard zoom)
                //   - wheel + ctrlKey (pre-emptive, trackpad pinch)
                //   - visualViewport.resize (semi-pre-emptive,
                //     fires before per-element ResizeObserver)
                //   - ResizeObserver on cropTarget (reactive
                //     fallback for other layout sources, e.g.
                //     window resize, devtools toggle)
                // Phase-3 follow-up: ResizeObserver-driven refresh
                // disabled.
                //
                // The original design re-primed cropTo() on every
                // bound change to "recover from Chrome's auto-tracking
                // glitches". In production it turned out the refresh
                // itself is what corrupts frames — every cropTo() is
                // a soft resolution change to the encoder, h264 loses
                // its reference frame chain, and we get blocky output.
                //
                // The LiveView card resizes constantly during a
                // session (commentary appearing under a question
                // grows the card; new captions arrive; etc.), so the
                // observer fires 6+ times per minute and every one
                // produces ~1s of garbled video. The recording was
                // worse with the observer than without it.
                //
                // Without it, the initial cropTo() at acquisition
                // time stays in effect for the whole session. Chrome
                // tracks the element's bounds itself; if the card
                // grows beyond initial bounds, content past the
                // bottom edge will be cropped from the recording —
                // an acceptable trade for clean playback.
                // Pre-emptive zoom triggers — fire BEFORE the browser
                // has re-rendered, so we pause the recorder ahead of
                // any garbled frame reaching the encoder. Without
                // these, ResizeObserver alone is reactive (fires after
                // the cropTarget bounds have already changed) and the
                // first ~1-2 frames at the new zoom are corrupt.
                this.cropZoomKeyHandler = (e: KeyboardEvent) => {
                  // Browser zoom shortcuts:
                  //   Ctrl/Cmd + "=" or "+"  → zoom in
                  //   Ctrl/Cmd + "-" or "_"  → zoom out
                  //   Ctrl/Cmd + "0"         → reset zoom
                  if (!(e.ctrlKey || e.metaKey)) return;
                  if (
                    e.key === "=" ||
                    e.key === "+" ||
                    e.key === "-" ||
                    e.key === "_" ||
                    e.key === "0"
                  ) {
                    this.handleCropTransition("keydown");
                  }
                };
                window.addEventListener("keydown", this.cropZoomKeyHandler, true);
                this.cropZoomWheelHandler = (e: WheelEvent) => {
                  // Trackpad pinch-to-zoom on macOS / Ctrl+wheel on
                  // Windows arrives as a wheel event with ctrlKey set.
                  if (e.ctrlKey || e.metaKey) {
                    this.handleCropTransition("wheel");
                  }
                };
                window.addEventListener("wheel", this.cropZoomWheelHandler, {
                  passive: true,
                  capture: true,
                });
                // === B-class layout-transition listeners ===
                // Three additional viewport-changing events that
                // would otherwise produce 花屏:
                //
                //   1) window.resize — drag browser edge, maximize/
                //      restore, external monitor plug/unplug,
                //      browser auto-hide URL bar.
                //   2) visualViewport.resize — software keyboard
                //      pop-up (touch laptops / tablets), browser
                //      mobile address bar hide-on-scroll.
                //   3) fullscreenchange — F11 / macOS green-button
                //      native fullscreen (different code path from
                //      our in-app Fullscreen toggle, which already
                //      calls orchestrator.triggerCropTransition).
                //
                // All three route to handleCropTransition, which:
                //   - pauses the videoRecorder immediately (no
                //     garbled frame reaches the encoder)
                //   - debounces 500ms (so a continuous resize-drag
                //     trigger only one pause/resume cycle)
                //   - re-primes cropTo on the cropTarget element
                //   - waits 2 RAFs for a clean frame
                //   - resumes the recorder
                //
                // Recording shows a brief still frame at the
                // transition instead of the multi-second
                // garbled-frame artifact that propagates through
                // h264's reference-frame chain.
                //
                // Earlier-disabled visualViewport.resize is
                // RE-ENABLED here — the original concern ("each
                // fire kicks cropTo refresh which trashes the
                // encoder") doesn't apply to handleCropTransition,
                // which pauses the encoder BEFORE refreshing and
                // resumes after a clean frame is produced.
                this.cropWindowResizeHandler = () => {
                  this.handleCropTransition("window-resize");
                };
                window.addEventListener(
                  "resize",
                  this.cropWindowResizeHandler
                );
                if (window.visualViewport) {
                  this.cropZoomViewportHandler = () => {
                    this.handleCropTransition("viewport-resize");
                  };
                  window.visualViewport.addEventListener(
                    "resize",
                    this.cropZoomViewportHandler
                  );
                }
                this.cropFullscreenHandler = () => {
                  this.handleCropTransition("native-fullscreen");
                };
                document.addEventListener(
                  "fullscreenchange",
                  this.cropFullscreenHandler
                );
                this.callbacks.onLog?.("video:zoom-listeners-armed", {
                  layoutTransition: true,
                });
                // Scroll listener: refreshes cropTo so the captured
                // region snaps to the element's current bounds when
                // the page scrolls. Without this, scrolling can let
                // content above the cropTarget (e.g. the PageTitle
                // "Treasury Analyst…" heading) bleed into the
                // recorded frame for several seconds before
                // Chrome's auto-tracking catches up.
                //
                // Two-phase throttle to balance latency vs. cost:
                //   - Leading edge: refresh once on the first
                //     scroll event in a burst.
                //   - Trailing edge (150ms after the last scroll):
                //     refresh again to catch the final position.
                // Continuous scroll therefore triggers at most one
                // refresh per ~150ms window plus one settling
                // refresh — cheap, and enough to keep the bounds
                // current. No pause/resume — plain scrolling
                // produces stale-content frames, not garbled ones,
                // so a quick cropTo refresh is sufficient.
                // Scroll handler: NOT attached, deliberately.
                //
                // We tried `window.addEventListener("scroll", …,
                // { capture: true })` calling handleCropTransition.
                // The capture-phase listener fires for scroll events
                // on ANY element in the tree, including PROGRAMMATIC
                // auto-scroll inside the captions / transcript panes
                // when new utterances arrive. Each utterance →
                // captions auto-scroll → scroll event → cropTo refresh
                // → 1-2 garbled frames at the encoder. With utterances
                // streaming in quickly during the first ~10-15s of a
                // session, this produced CONTINUOUS 花屏 for the
                // entire opening — strictly worse than the occasional
                // user-scroll artifact this was supposed to mitigate.
                //
                // There's no clean way to distinguish user-initiated
                // scrolls from programmatic ones in vanilla DOM
                // events; both fire identical `scroll` events. The
                // matching `wheel` / `touchstart` event covers
                // user-initiated scrolls but misses keyboard arrows /
                // Page Down / spacebar.
                //
                // For now: don't auto-mitigate scroll. If the user
                // scrolls hard during recording they may see a brief
                // garbled artifact — but that's local and rare,
                // unlike the every-utterance trigger above. cropZoom
                // listeners stay armed (zoom IS rare AND user-only).
              } else {
                this.callbacks.onLog?.("video:crop-skipped", {
                  reason: "target-not-in-dom",
                });
              }
            } else {
              this.callbacks.onLog?.("video:crop-skipped", {
                reason: "api-unavailable",
              });
            }
          } catch (e) {
            const err = e as { name?: string; message?: string };
            this.callbacks.onLog?.("video:crop-failed", {
              name: err?.name ?? "unknown",
              message: err?.message ?? String(e),
            });
          }

          // The video track ends when EITHER (a) the user clicks
          // Chrome's "Stop sharing" button OR (b) Chrome invalidates
          // the share — most commonly, when the user moves the
          // browser window between displays (especially across DPI
          // boundaries like 1x→Retina). In both cases the track is
          // dead and can't be revived; we have to re-acquire via a
          // fresh getDisplayMedia (which requires a user gesture).
          //
          // Strategy: stop the current videoRecorder so its segment
          // is finalized cleanly, then dispatch `ic:share-ended` so
          // the page can show a "Resume sharing" button. Clicking it
          // calls back into resumeScreenShare() below, which
          // re-acquires the share and starts a NEW MediaRecorder on
          // the new track (creating a new segment in videoSegments;
          // the existing concat path stitches them together).
          //
          // Audio + transcript (this.recorder, separate path) keep
          // running throughout — only the screen-recording video
          // stream is affected.
          videoTracks[0].addEventListener("ended", () => {
            this.notifyShareEnded("ended-event");
          });
          // Watchdog: poll track.readyState in case Chrome doesn't
          // reliably fire the "ended" event. Some Chromium versions
          // on macOS / multi-display configs let the track silently
          // transition to "ended" without firing the event.
          if (this.shareTrackWatchdog) clearInterval(this.shareTrackWatchdog);
          this.shareTrackWatchdog = setInterval(() => {
            if (this.shareEnded) return; // already handled
            if (this.stopped) return;
            const t = this.croppedVideoTrack;
            if (t && t.readyState === "ended") {
              this.notifyShareEnded("watchdog-readystate");
            }
          }, 2000);
        }
      } catch (e) {
        this.selfTabStream = null;
        this.videoStream = null;
        // Capture the error details — NotAllowedError vs aborted vs
        // gesture-trust-expired all look different and matter for
        // diagnosis. Browser API throws DOMException with .name.
        const err = e as { name?: string; message?: string };
        this.callbacks.onLog?.("video:share-failed", {
          name: err?.name ?? "unknown",
          message: err?.message ?? String(e),
        });
        // Hard requirement: the screen-recording share is mandatory
        // (per product spec — coaching review without the visual
        // panel of what the candidate saw is half a session). Decline
        // / picker-cancel / not-supported all funnel to abort.
        this.abortSession(
          "Screen share is required to start. Click Start again and pick the puebulo tab when prompted."
        );
        return;
      }
    } else {
      this.callbacks.onLog?.("video:disabled");
    }

    // 2-3) Open the Deepgram WebSocket and start feeding audio. Extracted
    //      into a helper so the same path is reusable from
    //      scheduleReconnect() when the socket dies mid-session.
    if (this.options.disableStt) {
      // Realtime engine: no Deepgram socket. Start the recorder
      // directly (normally openWs's first-open triggers it) so the
      // mixed mic+AI-voice stream is still captured; transcripts come
      // from OpenAI. The chunk-send path is already guarded by
      // `this.ws?.readyState === OPEN`, so with no socket the recorder
      // simply accumulates audioChunks for the final recording.
      this.callbacks.onLog?.("stt:disabled", {});
      this.startRecording();
    } else {
      await this.openWs(/* isReconnect */ false);
    }

    this.startTime = Date.now();
  }

  /** Open (or re-open) the Deepgram WebSocket. Wired up to start the
   *  MediaRecorder on first open, and to silently take over from the
   *  previous socket on reconnect (recorder keeps running across
   *  reconnects). */
  private async openWs(isReconnect: boolean) {
    // Get a Deepgram credential from our server route. Each reconnect
    // refreshes the token in case the previous JWT expired.
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
      const msg =
        e instanceof Error ? e.message : "Failed to get Deepgram token";
      this.callbacks.onError(`Deepgram auth failed: ${msg}`);
      return;
    }

    // Per-instance query: defaults + caller overrides (e.g. the Retake
    // flow's Chinese sessions pass { language: "zh", model: "nova-2" }).
    const queryParams = new URLSearchParams(DEEPGRAM_QUERY);
    for (const [k, v] of Object.entries(
      this.options.sttQueryOverrides ?? {}
    )) {
      queryParams.set(k, v);
    }
    const url = `wss://api.deepgram.com/v1/listen?${queryParams.toString()}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, [scheme, token]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "WS construct failed";
      this.callbacks.onError(`Deepgram socket failed: ${msg}`);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // Diagnostic — every successful WS open. Pairs with dg-ws:close
      // so a postmortem can reconstruct the full connection timeline.
      this.callbacks.onLog?.("dg-ws:open", {
        isReconnect,
        reconnectAttempt: this.reconnectAttempts,
      });
      if (isReconnect) {
        // Existing recorder is already running. Audio chunks captured
        // during the reconnect window were stashed in pendingChunks —
        // flush them now so transcription catches up with the words
        // the user spoke during the gap. Order matters (webm container
        // frames must be contiguous), so flushPendingChunks drains them
        // in chronological order before fresh chunks resume flowing.
        const buffered = this.pendingChunks.length;
        this.flushPendingChunks();
        this.callbacks.onError(
          buffered > 0
            ? `Deepgram reconnected (attempt ${this.reconnectAttempts}). Replaying ${buffered} buffered chunk(s) — no words lost.`
            : `Deepgram reconnected (attempt ${this.reconnectAttempts}). Resuming transcription.`
        );
        this.reconnectAttempts = 0;
      } else {
        this.startRecording();
      }
      // Keep the socket alive during silence (Deepgram closes after 12s).
      if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, AudioSession.KEEP_ALIVE_MS);
    };

    ws.onmessage = (event) => this.onWsMessage(event);

    ws.onerror = () => {
      // Browser WebSocket onerror gives no useful detail; the close
      // event will have code/reason.
    };

    ws.onclose = (event) => {
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      // Decide whether to reconnect BEFORE firing the diagnostic hook
      // so the log line correctly shows willReconnect.
      const intentional = this.stopped || this.paused;
      const willReconnect =
        !intentional &&
        this.reconnectAttempts < AudioSession.MAX_RECONNECTS;
      // Always fire onWsClose — the orchestrator funnels this into the
      // debug log so silent socket deaths are visible after the fact.
      this.callbacks.onWsClose?.({
        code: event.code,
        reason: event.reason || "",
        wasClean: event.wasClean,
        reconnectAttempt: this.reconnectAttempts,
        willReconnect,
      });
      if (intentional) return;
      if (willReconnect) {
        this.scheduleReconnect();
      } else {
        // Exhausted retries.
        this.callbacks.onError(
          `Deepgram disconnected and couldn't reconnect after ${AudioSession.MAX_RECONNECTS} attempts (last close: ${event.code} ${event.reason || "no reason"}). Click Pause then Resume to fully restart capture.`
        );
      }
    };
  }

  /** Diagnostic — sample audio RMS energy on the active mediaStream
   *  every second, emit periodic "audio:level" heartbeat events and
   *  one-shot "audio:silence" / "audio:resumed" transition events.
   *
   *  The point: distinguish "no audio coming in" vs "audio coming in
   *  but no transcripts" in postmortems. Without this, both look
   *  identical (utterances stop arriving) and the only way to tell
   *  them apart was to download the recording and listen.
   *
   *  Implementation:
   *  - Separate AudioContext to avoid touching the recording pipeline.
   *  - AnalyserNode with fftSize=2048 (~46ms window at 48kHz). RMS
   *    computed from getByteTimeDomainData (centered on 128).
   *  - Sample 1Hz, log heartbeat every 10s + transitions on threshold
   *    crossings. ~180 events per 30-min session — modest.
   *  - SILENCE_RMS=0.005 picked empirically: ambient mic noise floor
   *    is typically 0.001-0.003, normal speech is 0.05-0.3, so 0.005
   *    cleanly separates the two without flapping on quiet speech.
   *  - Failures are swallowed — the diagnostic must NEVER affect
   *    recording or transcription. Worst case: no diagnostic data. */
  private startAudioRmsSampling(): void {
    if (!this.mediaStream) return;
    if (this.audioRmsSamplerTimer) return; // already running
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(this.mediaStream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      // NOTE: we deliberately do NOT connect analyser → ctx.destination.
      // That would route the captured audio to the user's speakers
      // and create an instant feedback loop on mic-only sessions.
      // AnalyserNode samples even when only `connect`'d at the input
      // side — it's a tap, not a passthrough.
      source.connect(analyser);

      this.audioAnalyserCtx = ctx;
      this.audioAnalyserSource = source;
      this.audioAnalyserNode = analyser;
      this.audioInSilence = false;
      this.audioSilenceStartedAt = 0;
      this.audioRmsLastHeartbeatAt = Date.now();

      const SILENCE_RMS = 0.005;
      const HEARTBEAT_MS = 10_000;
      const SILENCE_MIN_MS = 3000; // only log silence transitions > 3s
      const buf = new Uint8Array(analyser.fftSize);

      this.audioRmsSamplerTimer = setInterval(() => {
        if (!this.audioAnalyserNode) return;
        try {
          this.audioAnalyserNode.getByteTimeDomainData(buf);
        } catch {
          return;
        }
        // RMS in [0, 1] from byte time-domain data centered at 128.
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        const now = Date.now();
        const isSilent = rms < SILENCE_RMS;

        if (isSilent && !this.audioInSilence) {
          this.audioInSilence = true;
          this.audioSilenceStartedAt = now;
        } else if (!isSilent && this.audioInSilence) {
          const silentMs = now - this.audioSilenceStartedAt;
          this.audioInSilence = false;
          if (silentMs >= SILENCE_MIN_MS) {
            this.callbacks.onLog?.("audio:resumed", {
              rms: Number(rms.toFixed(4)),
              afterSilentMs: silentMs,
            });
          }
        } else if (
          isSilent &&
          this.audioInSilence &&
          now - this.audioSilenceStartedAt === SILENCE_MIN_MS
        ) {
          // We sample at ~1Hz so the equality check is approximate;
          // the threshold below catches the actual transition.
        }
        // Emit a one-shot "audio:silence" event the FIRST time silence
        // crosses the SILENCE_MIN_MS bar — so postmortems can find
        // "audio went quiet for >= 3s starting at sec=N" without
        // needing to scan all heartbeat samples.
        if (
          isSilent &&
          this.audioInSilence &&
          now - this.audioSilenceStartedAt >= SILENCE_MIN_MS &&
          // Only fire once per silence run — gate on the previous
          // heartbeat: if we last heartbeat'd before silence started,
          // this is the first heartbeat of the silence run.
          this.audioRmsLastHeartbeatAt < this.audioSilenceStartedAt
        ) {
          this.callbacks.onLog?.("audio:silence", {
            rms: Number(rms.toFixed(4)),
            silenceStartedMsAgo: now - this.audioSilenceStartedAt,
          });
        }

        // Periodic heartbeat — gives postmortems a continuous trace of
        // signal energy over time. Useful even when nothing's wrong:
        // confirms the sampler is alive end-to-end.
        if (now - this.audioRmsLastHeartbeatAt >= HEARTBEAT_MS) {
          this.callbacks.onLog?.("audio:level", {
            rms: Number(rms.toFixed(4)),
            silent: isSilent,
          });
          this.audioRmsLastHeartbeatAt = now;
        }
      }, 1000);
    } catch (e) {
      // Diagnostic init failure is swallowed — the session continues
      // recording and transcribing without the RMS tap. Log the error
      // so we know the diagnostic is missing for this session.
      this.callbacks.onLog?.("audio:rms-init-failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Tear down the RMS sampling tap. Called from stop() / tearDown().
   *  Safe to call multiple times — all guards are null-checks. */
  private stopAudioRmsSampling(): void {
    if (this.audioRmsSamplerTimer) {
      clearInterval(this.audioRmsSamplerTimer);
      this.audioRmsSamplerTimer = null;
    }
    if (this.audioAnalyserSource) {
      try {
        this.audioAnalyserSource.disconnect();
      } catch {
        /* ignore */
      }
      this.audioAnalyserSource = null;
    }
    this.audioAnalyserNode = null;
    if (this.audioAnalyserCtx) {
      try {
        void this.audioAnalyserCtx.close();
      } catch {
        /* ignore */
      }
      this.audioAnalyserCtx = null;
    }
    this.audioInSilence = false;
    this.audioSilenceStartedAt = 0;
    this.audioRmsLastHeartbeatAt = 0;
  }

  /** Schedule a reconnect attempt with exponential backoff. Caller has
   *  already verified we're not stopped/paused and we're under the
   *  MAX_RECONNECTS cap.
   *
   *  Backoff: 500ms, 1s, 2s, 3s, 3s, ... — caps at 3s. The cap was
   *  lowered from 5s to 3s because GFW jitter recovery windows are
   *  short; a 5s wait often misses the brief window when the link is
   *  reachable again, forcing another full backoff cycle. 3s is short
   *  enough to ride the recovery and long enough to avoid hammering. */
  private scheduleReconnect() {
    this.reconnectAttempts++;
    const delayMs = Math.min(
      500 * Math.pow(2, this.reconnectAttempts - 1),
      3000
    );
    this.callbacks.onError(
      `Deepgram disconnected — reconnecting (attempt ${this.reconnectAttempts}/${AudioSession.MAX_RECONNECTS})…`
    );
    // Diagnostic — log when a reconnect is queued so we can correlate
    // dg-ws:close → reconnect-scheduled → dg-ws:open in postmortems.
    this.callbacks.onLog?.("dg-ws:reconnect-scheduled", {
      attempt: this.reconnectAttempts,
      delayMs,
      maxAttempts: AudioSession.MAX_RECONNECTS,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openWs(/* isReconnect */ true);
    }, delayMs);
  }

  /** Append a chunk to the reconnect buffer with bounded eviction.
   *  When the buffer is full, drops the OLDEST chunk to make room —
   *  losing the start of a 15s gap is preferable to losing the most
   *  recent words (which connect to whatever the user just said). */
  private pushPendingChunk(chunk: Blob) {
    if (this.pendingChunks.length >= AudioSession.MAX_PENDING_CHUNKS) {
      this.pendingChunks.shift();
    }
    this.pendingChunks.push(chunk);
  }

  /** Send any audio chunks that arrived while the WS was reconnecting.
   *  Called from ws.onopen after the socket is re-established. Drains
   *  the ring buffer in chronological order so Deepgram receives the
   *  webm/opus stream contiguously — out-of-order frames would break
   *  the container. Safe to call when buffer is empty (no-ops). */
  private flushPendingChunks() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pendingChunks.length === 0) return;
    for (const chunk of this.pendingChunks) {
      try {
        this.ws.send(chunk);
      } catch {
        // If a single send throws (closing socket racing the flush),
        // bail — onclose will trigger another reconnect.
        break;
      }
    }
    this.pendingChunks = [];
  }

  private onWsMessage(event: MessageEvent) {
    // Drop any Deepgram messages that arrive after stop() has begun.
    // Even though we close the WS in tearDown, Chrome will deliver
    // already-queued frames to onmessage during the closing handshake
    // — and those would otherwise trigger onFinalTranscript →
    // orchestrator.onUtterance → addUtterance / classify, polluting
    // the debug log AND occasionally re-arming downstream timers
    // after the session is already considered over.
    if (this.stopped || this.paused) return;
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
      // Save for playback (always — independent of WS state, including
      // the final ondataavailable that fires after stop() has already
      // begun. That last chunk is legit pre-stop audio that the user's
      // saved recording wants.).
      this.audioChunks.push(e.data);
      if (this.audioChunks.length > AudioSession.MAX_AUDIO_CHUNKS) {
        this.audioChunks.shift();
        if (!this.audioChunksDroppedWarned) {
          this.audioChunksDroppedWarned = true;
          this.callbacks.onError(
            "Recording exceeded 4 hours — older audio is being dropped to keep the page responsive. Save soon to preserve the rest."
          );
        }
      }
      if (this.paused) return;
      // Don't send post-stop chunks to Deepgram. The chunk is already
      // saved into audioChunks above for the final recording; sending
      // it would trigger transcript replies after stop() that arrive
      // as new utterances — exactly the leak the post-stop
      // onWsMessage guard is meant to catch on the receive side. Two
      // belts on one pair of pants is fine here: stop is a critical
      // path and racing with the recorder's final flush is common.
      if (this.stopped) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Drain anything that piled up during a prior reconnect window
        // before sending the current chunk, so frame order is preserved.
        if (this.pendingChunks.length > 0) this.flushPendingChunks();
        try {
          this.ws.send(e.data);
        } catch {
          // Socket racing closed mid-send. Stash the chunk so the next
          // reconnect picks it up. onclose handler will trigger reconnect.
          this.pushPendingChunk(e.data);
        }
      } else {
        // WS is reconnecting (or hasn't opened yet). Buffer so we don't
        // lose words during the gap; flushed by flushPendingChunks on
        // reconnect.
        this.pushPendingChunk(e.data);
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
      // Format selection priority: MP4/h264 first, VP9/WebM fallback.
      //
      // === Why MP4 (and how we sidestep the multi-segment trap) ===
      // The orchestrator-level pause()/resume() flow tears the
      // MediaRecorder down completely on pause (so the mic indicator
      // + screen-share badge actually disappear during a real pause)
      // and constructs a fresh one on resume. Each MediaRecorder
      // run emits its own self-contained MP4 container with its own
      // ftyp+moov header. Naively concatenating those into a single
      // Blob produces an INVALID MP4 — demuxers reject it with
      // MediaError code 4. That's exactly the bug we hit before.
      //
      // Solution: keep recording in MP4 BUT track each pause/resume
      // cycle as its own segment (videoSegments[][]). Upload each
      // segment as a separate S3 object, then call /api/uploads/concat
      // which runs `ffmpeg -f concat -i list.txt -c copy final.mp4`
      // — a non-re-encoding remux that takes ~1s and produces a
      // single valid MP4 ready for WeChat / iOS / QuickTime.
      //
      // Why this beats VP9/WebM: WebM tolerates naive concat (so
      // playback "just works" with multi-segment) but VP9 doesn't
      // play in WeChat. Server-side WebM → MP4 is a full pixel-level
      // transcode that takes 3-5 minutes on a t3.small. MP4 + ffmpeg
      // -c copy stays under 10s end-to-end.
      //
      // Constrained Baseline (avc1.42E01E) is the most universally
      // compatible h264 profile — accepted by WeChat / Enterprise
      // WeChat / iOS Safari / older Android browsers. AAC LC
      // (mp4a.40.2) is the audio analog. Listed first so
      // MediaRecorder picks it specifically rather than negotiating
      // a less compatible profile.
      // Detect + stash the negotiated mime so setupVideoRecorder()
      // can reuse it when constructing fresh recorders mid-session
      // (handleCropTransition's stop+restart path) without re-running
      // isTypeSupported.
      this.videoMime = MediaRecorder.isTypeSupported(
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2"
      )
        ? "video/mp4;codecs=avc1.42E01E,mp4a.40.2"
        : MediaRecorder.isTypeSupported("video/mp4")
        ? "video/mp4"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus"
        : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm";
      this.setupVideoRecorder();
    }
  }

  /** Full pause: tear down the entire audio capture pipeline (mic
   *  released, Deepgram socket closed, MediaRecorders stopped) but
   *  keep accumulated chunks + duration on the instance so resume()
   *  can pick up where we left off. Per user spec: when paused, the
   *  mic system indicator should go off — partial / MediaRecorder-
   *  only pause was insufficient because the mic stream stays active. */

  /** Build a new videoRecorder on the existing this.videoStream and
   *  start it. Idempotent in the sense that callers must null out
   *  this.videoRecorder first if they want a fresh one — this method
   *  always constructs a new MediaRecorder and pushes a new segment.
   *
   *  Used by:
   *    1. start() — initial recorder for the session.
   *    2. handleCropTransition() — after stopping the prior recorder,
   *       construct a NEW one so the encoder produces a clean keyframe
   *       at "resume" instead of a P-frame referencing a stale frame
   *       (which is what makes fullscreen-toggle 花屏 persist for
   *       several seconds with pause/resume).
   *
   *  Returns true on success, false if construction failed (codec
   *  mismatch, headless context) — caller can decide whether to
   *  continue without video. */
  private setupVideoRecorder(): boolean {
    if (!this.videoStream) return false;
    if (this.stopped) return false;
    if (this.paused) return false;
    // Re-use the negotiated mime from the first construction. Empty
    // on first call (start() detects + sets); after that, sticky.
    const requestedMime =
      this.videoMime ||
      (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1.42E01E,mp4a.40.2")
        ? "video/mp4;codecs=avc1.42E01E,mp4a.40.2"
        : MediaRecorder.isTypeSupported("video/mp4")
          ? "video/mp4"
          : MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
            ? "video/webm;codecs=vp9,opus"
            : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
              ? "video/webm;codecs=vp8,opus"
              : "video/webm");
    try {
      this.videoRecorder = new MediaRecorder(this.videoStream, {
        mimeType: requestedMime,
        videoBitsPerSecond: 6_000_000,
        ...(({
          videoKeyFrameIntervalDuration: 500,
        }) as unknown as Record<string, never>),
      });
      this.videoMime = this.videoRecorder.mimeType || requestedMime;
      this.videoSegments.push([]);
      this.videoRecorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        if (this.videoSegments.length === 0) this.videoSegments.push([]);
        const current = this.videoSegments[this.videoSegments.length - 1];
        current.push(e.data);
        let total = 0;
        for (const seg of this.videoSegments) total += seg.length;
        if (total > AudioSession.MAX_VIDEO_CHUNKS) {
          for (const seg of this.videoSegments) {
            if (seg.length > 0) {
              seg.shift();
              break;
            }
          }
          if (!this.videoChunksDroppedWarned) {
            this.videoChunksDroppedWarned = true;
            this.callbacks.onError(
              "Video recording exceeded 4 hours — older frames are being dropped to keep the page responsive. Save soon to preserve the rest."
            );
          }
        }
      };
      this.videoRecorder.onerror = (ev) => {
        this.callbacks.onLog?.("video:recorder-error", {
          error: String((ev as unknown as { error?: unknown }).error ?? ev),
        });
      };
      this.videoRecorder.start(250);
      this.callbacks.onLog?.("video:recorder-started", {
        mime: this.videoMime,
      });
      return true;
    } catch (e) {
      this.videoRecorder = null;
      this.callbacks.onLog?.("video:recorder-construct-failed", {
        mime: requestedMime,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /** Single entry point for the "screen share has ended mid-session"
   *  flow. Called from the addEventListener("ended") handler and from
   *  the watchdog poll — idempotent on the shareEnded flag so
   *  double-firing is harmless. */
  private notifyShareEnded(source: string): void {
    if (this.shareEnded) return;
    this.shareEnded = true;
    this.callbacks.onLog?.("video:track-ended", { source });
    if (this.videoRecorder && this.videoRecorder.state !== "inactive") {
      try {
        this.videoRecorder.stop();
      } catch {
        /* ignore — already stopping */
      }
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("ic:share-ended"));
    }
    this.callbacks.onError(
      "Screen recording paused — likely from moving Chrome between displays. Click \"Resume Sharing\" to keep recording."
    );
  }

  /** User-triggered recovery from a track-ended event. Re-acquires
   *  the screen-share via getDisplayMedia, re-applies cropTo to the
   *  cropTarget, and constructs a fresh MediaRecorder on the new
   *  stream. The new recorder produces a new segment in
   *  videoSegments — the existing concat path stitches segments
   *  together at upload time.
   *
   *  MUST be called from a user-gesture handler (button click).
   *  Browser security blocks getDisplayMedia from anywhere else,
   *  so silent auto-recovery isn't an option.
   *
   *  Returns true on success, false if the user declined the share
   *  prompt or the session was torn down mid-recovery. */
  async resumeScreenShare(): Promise<boolean> {
    if (!this.shareEnded) return false;
    if (this.stopped || this.paused) return false;
    try {
      const newStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
        },
        audio: false,
        // @ts-expect-error preferCurrentTab is Chromium-specific
        preferCurrentTab: true,
      });
      const newTracks = newStream.getVideoTracks();
      if (newTracks.length === 0) {
        newStream.getTracks().forEach((t) => t.stop());
        this.callbacks.onError(
          "No video track in the new share — please try again."
        );
        return false;
      }
      // Apply same constraints + cropTo as the original setup so
      // the new track produces frames matching the old segments'
      // resolution and SPS where possible.
      try {
        await newTracks[0].applyConstraints({
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
        });
      } catch {
        /* non-fatal */
      }
      const Ctor = (
        globalThis as {
          CropTarget?: {
            fromElement?: (el: Element) => Promise<unknown>;
          };
        }
      ).CropTarget;
      if (Ctor && typeof Ctor.fromElement === "function") {
        const target = document.getElementById("ic-capture-region");
        if (target) {
          try {
            const cropTarget = await Ctor.fromElement(target);
            // @ts-expect-error cropTo only exists on BrowserCaptureMediaStreamTrack
            await newTracks[0].cropTo(cropTarget);
          } catch (e) {
            this.callbacks.onLog?.("video:resume-share-crop-failed", {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
      this.croppedVideoTrack = newTracks[0];
      // Re-attach the track-ended listener on the new track so a
      // second display-move event can also recover.
      newTracks[0].addEventListener("ended", () => {
        this.notifyShareEnded("ended-event-post-resume");
      });
      // Build a new MediaStream with new video + reuse mic/tab audio.
      // The displayMedia we just acquired has audio:false, so we
      // pull audio from the existing mediaStream's audio tracks.
      const audioTracks = this.mediaStream
        ? this.mediaStream.getAudioTracks()
        : [];
      this.selfTabStream = newStream;
      this.videoStream = new MediaStream([newTracks[0], ...audioTracks]);
      // Spin up a fresh MediaRecorder on the new stream. Pushes a
      // new segment in videoSegments; concat path stitches it.
      const ok = this.setupVideoRecorder();
      if (!ok) {
        this.callbacks.onError(
          "Couldn't restart the recording on the new share."
        );
        return false;
      }
      this.shareEnded = false;
      this.callbacks.onLog?.("video:share-resumed", {
        videoTrackCount: newTracks.length,
      });
      return true;
    } catch (e) {
      const err = e as { name?: string; message?: string };
      this.callbacks.onLog?.("video:resume-share-failed", {
        name: err?.name ?? "unknown",
        message: err?.message ?? String(e),
      });
      // NotAllowedError = user declined the share dialog. Silent.
      // Other errors get a toast.
      if (err?.name !== "NotAllowedError") {
        this.callbacks.onError(
          err?.message ?? "Couldn't resume the screen share — please try again."
        );
      }
      return false;
    }
  }

  /** Shared handler for all four "the crop region is about to change"
   *  signals (pre-emptive keydown / wheel-with-ctrl /
   *  visualViewport.resize, plus the reactive ResizeObserver). Pauses
   *  the videoRecorder immediately so no garbled transition frames
   *  reach the encoder, then schedules a debounced refreshVideoCrop()
   *  + resume after the bounds have been stable for 500ms.
   *
   *  Idempotent: multiple signals firing in quick succession just
   *  re-pause (already-paused = no-op) and reset the debounce timer,
   *  which is exactly what we want — the recorder stays paused for
   *  the full duration of a continuous zoom gesture.
   *
   *  500ms debounce (was 300ms): gives the post-zoom layout time to
   *  fully settle before we re-prime cropTo + resume. The user's
   *  recording has a ~500-700ms still-frame gap at zoom transitions
   *  instead of corrupt frames — strictly better than the prior
   *  garbled output. */
  // Public version for the orchestrator to call on user-initiated
  // layout transitions that aren't detected by the keyboard/wheel
  // listeners (e.g. clicking the Fullscreen button — the React
  // re-render fires no DOM event we can observe from here).
  triggerCropTransition(reason: string) {
    this.handleCropTransition(reason);
  }
  private handleCropTransition(reason: string) {
    // Phase 1: pause the encoder immediately.
    if (
      this.videoRecorder &&
      this.videoRecorder.state === "recording"
    ) {
      try {
        // Reverted from stop+restart back to pause+resume after
        // observing a worse failure mode in production: stop+
        // restart left a ~1s "frozen frame" at every transition
        // boundary (encoder finalizes last frame on stop, new
        // MediaRecorder starts ~1s later). For sessions that
        // legitimately had 4-6 layout transitions (window resize,
        // visualViewport changes, fullscreen toggle) the result
        // was a stutter pattern users described as "video
        // repeating every second" — strictly worse than the
        // residual reference-chain 花屏 from pause+resume.
        //
        // Pause+resume keeps a single MediaRecorder alive across
        // the transition. Pre-pause and post-resume content are
        // written contiguously into one encoded stream — no
        // freeze frames. Cost: for major layout changes
        // (fullscreen toggle), the first post-resume P-frame
        // references the wrong pre-pause keyframe and decodes as
        // brief 花屏 until the next keyframe. With Chrome's
        // default ~2s keyframe interval for MP4 that's at most
        // ~2s of mild artifact at the transition.
        //
        // requestData() BEFORE pause() flushes any in-flight
        // chunk so the chunk-aligned pause delay (Chrome's
        // pause() defers until current timeslice ends) shrinks
        // from ~250ms to ~0ms.
        this.videoRecorder.requestData();
        this.videoRecorder.pause();
        this.callbacks.onLog?.("video:zoom-pause", { reason });
      } catch {
        /* ignore — recorder may have torn down */
      }
    }
    if (this.cropRefreshDebounceTimer) {
      clearTimeout(this.cropRefreshDebounceTimer);
    }
    // Debounce 1000ms (was 500ms). Critical because Chrome's
    // MediaRecorder doesn't honor pause() mid-chunk — the in-flight
    // chunk has to complete before pause takes effect. With the
    // companion change to start() timeslice (now 250ms), an in-
    // flight chunk is at most 250ms long, so the 1000ms debounce
    // gives a 4× safety margin: by the time we refresh+resume,
    // the recorder is GENUINELY paused and any garbled transition
    // frames have been discarded by Chrome (they were never
    // included in any committed chunk).
    //
    // Also picks up CSS transitions on surrounding elements (sidebar
    // collapse animation if present, etc.) — empirically 500ms was
    // enough for static layouts but not enough when tied to a
    // fullscreen toggle that involves multiple simultaneous reflows.
    //
    // User-visible cost: ~1 second freeze frame in the recording at
    // each transition. Toggling fullscreen ~once per session, so
    // negligible.
    this.cropRefreshDebounceTimer = setTimeout(async () => {
      this.cropRefreshDebounceTimer = null;
      // Phase 2: bounds stable for 1000ms. Re-prime cropTo, wait two
      // frames for the new crop to flush through Chrome's capture
      // pipeline, then resume the existing recorder.
      await this.refreshVideoCrop();
      const resumeRecorder = () => {
        if (
          this.videoRecorder &&
          this.videoRecorder.state === "paused"
        ) {
          try {
            this.videoRecorder.resume();
            this.callbacks.onLog?.("video:zoom-resume", {});
          } catch {
            /* ignore */
          }
        }
      };
      // Two RAFs: first ensures the cropTo has been picked up by the
      // compositor; second ensures at least one clean frame has been
      // produced before we let the encoder consume it. Single-RAF was
      // letting one residual garbled frame through on slower machines.
      if (typeof requestAnimationFrame !== "undefined") {
        requestAnimationFrame(() => {
          requestAnimationFrame(resumeRecorder);
        });
      } else {
        resumeRecorder();
      }
    }, 1000);
  }

  /** Re-acquire the Region Capture cropTarget on the captured video
   *  track. Called by the orchestrator after a UI event that
   *  dramatically changes the cropped element's bounds (fullscreen
   *  toggle is the main case) — Chrome's auto-tracking of the
   *  element's bounding box during these reflows is buggy in some
   *  versions and produces garbled frames at the transition. Issuing
   *  a fresh `cropTo()` against the same DOM element resolves to
   *  the current bounds and recovers a clean recording from that
   *  point forward.
   *
   *  No-op when:
   *    - We never had a video track in the first place (audio-only
   *      session).
   *    - The Region Capture API isn't available (older browsers).
   *    - The cropTarget element isn't in the DOM right now.
   *  Errors are logged via the onError callback (informational,
   *  doesn't kill the session). */
  async refreshVideoCrop() {
    if (!this.croppedVideoTrack) return;
    try {
      const Ctor = (
        globalThis as {
          CropTarget?: {
            fromElement?: (el: Element) => Promise<unknown>;
          };
        }
      ).CropTarget;
      if (!Ctor || typeof Ctor.fromElement !== "function") return;
      const target = document.getElementById("ic-capture-region");
      if (!target) return;
      const cropTarget = await Ctor.fromElement(target);
      // @ts-expect-error cropTo only exists on BrowserCaptureMediaStreamTrack
      await this.croppedVideoTrack.cropTo(cropTarget);
      this.callbacks.onLog?.("video:crop-refreshed", {
        targetId: "ic-capture-region",
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      this.callbacks.onLog?.("video:crop-refresh-failed", {
        name: err?.name ?? "unknown",
        message: err?.message ?? String(e),
      });
    }
  }

  /** Hard-fail abort path used during start() when a required
   *  precondition can't be satisfied (no audio source after the
   *  share dialog, screen-share declined, etc.). Symmetric job to
   *  stop() but without producing onAudioReady/onVideoReady — the
   *  session never actually ran, so there's nothing to hand back.
   *
   *  Releases any tracks we already acquired before the failing
   *  step (mic, tab audio, partial selfTab), surfaces the reason to
   *  the user via onError, and dispatches `ic:session-aborted` so
   *  the page flips live status back to idle without throwing
   *  through async start().
   *
   *  Idempotent — calling multiple times is a no-op after the first
   *  via the `stopped` flag. */
  private abortSession(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    // Unlock browser zoom — we attached the lock at the top of
    // start() but the session never made it to recording, so the
    // user should be free to zoom around the idle UI again.
    this.detachZoomLock();
    // Release any partial captures so the user's mic indicator + the
    // browser's "sharing this tab" badge release immediately, without
    // waiting for GC.
    this.micStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.tabStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.selfTabStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.cameraStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.micStream = null;
    this.tabStream = null;
    this.selfTabStream = null;
    this.cameraStream = null;
    this.micGainNode = null;
    this.mediaStream = null;
    this.videoStream = null;
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        void this.audioContext.close();
      } catch {
        /* ignore */
      }
    }
    this.audioContext = null;
    // Tear down the diagnostic RMS sampler — its AudioContext + timer
    // would leak if we let abort short-circuit cleanup.
    this.stopAudioRmsSampling();
    // Surface the reason as a (non-throw) error message + signal the
    // page to roll status back to idle. The reason is also threaded
    // through the custom event's detail so the page can render a
    // dismissable "couldn't start" modal explaining what to do —
    // without that, a decline silently dumps the user back to the
    // idle "Click Start" placeholder with no clue what just
    // happened. Custom event keeps us decoupled from the page
    // module.
    this.callbacks.onError(reason);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("ic:session-aborted", { detail: reason })
      );
    }
  }

  async pause() {
    if (this.paused || this.stopped) return;
    // Add this run-segment's duration to the accumulator before we
    // tear down. start() will reset startTime when resume kicks off
    // a new segment.
    if (this.startTime > 0) {
      this.accumulatedDurationMs += Date.now() - this.startTime;
    }
    this.paused = true;
    await this.tearDown();
  }

  /** Full resume: re-acquire mic, re-prompt for tab share if it was
   *  active, re-open Deepgram, restart MediaRecorders. The new
   *  MediaRecorders append to the same audioChunks / videoChunks as
   *  before pause, so the final saved blob covers the entire session.
   *  NOTE: each pause/resume cycle yields a separate WebM container
   *  in the chunk list — concatenated at stop() time. Playback is
   *  generally fine but seek behavior across segment boundaries is
   *  not guaranteed by the WebM spec. */
  async resume() {
    if (!this.paused) return;
    await this.start();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;

    // Disconnect the cropTarget ResizeObserver + cancel any pending
    // refresh — no point firing cropTo() after the session ended.
    if (this.cropResizeObserver) {
      this.cropResizeObserver.disconnect();
      this.cropResizeObserver = null;
    }
    if (this.cropRefreshDebounceTimer) {
      clearTimeout(this.cropRefreshDebounceTimer);
      this.cropRefreshDebounceTimer = null;
    }
    // Clear the share-ended watchdog interval so we don't keep
    // polling track.readyState after the session is torn down.
    if (this.shareTrackWatchdog) {
      clearInterval(this.shareTrackWatchdog);
      this.shareTrackWatchdog = null;
    }
    // Detach pre-emptive zoom listeners.
    if (this.cropZoomKeyHandler) {
      window.removeEventListener("keydown", this.cropZoomKeyHandler, true);
      this.cropZoomKeyHandler = null;
    }
    if (this.cropZoomWheelHandler) {
      window.removeEventListener("wheel", this.cropZoomWheelHandler, {
        capture: true,
      } as EventListenerOptions);
      this.cropZoomWheelHandler = null;
    }
    if (this.cropZoomViewportHandler && window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this.cropZoomViewportHandler
      );
      this.cropZoomViewportHandler = null;
    }
    if (this.cropWindowResizeHandler) {
      window.removeEventListener("resize", this.cropWindowResizeHandler);
      this.cropWindowResizeHandler = null;
    }
    if (this.cropFullscreenHandler) {
      document.removeEventListener(
        "fullscreenchange",
        this.cropFullscreenHandler
      );
      this.cropFullscreenHandler = null;
    }
    if (this.cropScrollHandler) {
      window.removeEventListener("scroll", this.cropScrollHandler, {
        capture: true,
      } as EventListenerOptions);
      this.cropScrollHandler = null;
    }
    if (this.cropScrollThrottleTimer) {
      clearTimeout(this.cropScrollThrottleTimer);
      this.cropScrollThrottleTimer = null;
    }

    // Compute total duration: previously-accumulated + the active
    // run-segment if we're not already paused (pause already added
    // its segment in).
    if (!this.paused && this.startTime > 0) {
      this.accumulatedDurationMs += Date.now() - this.startTime;
    }
    const duration = this.accumulatedDurationMs / 1000;

    // If we're already paused, the pipeline is already torn down —
    // skip straight to finalizing blobs. Otherwise tear down now.
    if (!this.paused) {
      await this.tearDown();
    }

    // Hand back the recorded audio. Built from ALL chunks accumulated
    // across pause/resume cycles.
    const blob = new Blob(this.audioChunks, { type: "audio/webm" });
    const url = URL.createObjectURL(blob);
    this.callbacks.onLog?.("audio:final", {
      chunks: this.audioChunks.length,
      bytes: blob.size,
    });
    this.callbacks.onAudioReady(url, duration);

    // Hand back the recorded video, if any. Skip when nothing was
    // captured (captureVideo off, or share declined / no video track).
    // Drop empty trailing segment(s) — if pause() ran but no further
    // chunks were captured, the segment is empty and would just be
    // an empty file at upload time.
    const nonEmptySegments = this.videoSegments.filter((s) => s.length > 0);
    const totalChunks = nonEmptySegments.reduce((n, s) => n + s.length, 0);
    this.callbacks.onLog?.("video:final", {
      segments: nonEmptySegments.length,
      totalChunks,
      hasOnVideoReady: !!this.callbacks.onVideoReady,
    });
    if (totalChunks > 0 && this.callbacks.onVideoReady) {
      // Tag each segment Blob with the recorder's actual MIME so the
      // upload code's Content-Type stays consistent with the bytes.
      // Default to mp4 if for some reason the MIME wasn't captured —
      // defensive only.
      const blobType =
        (this.videoMime || "").split(";")[0].trim() || "video/mp4";

      // Patch each segment Blob individually. WebM segments need the
      // EBML duration fix (without it, scrubber breaks and some
      // demuxers mis-decode the tail). MP4 segments need no fix-up —
      // Chrome's fMP4 carries per-fragment timing in tfdt boxes that
      // demuxers handle correctly.
      const segmentBlobs: Blob[] = [];
      for (let i = 0; i < nonEmptySegments.length; i++) {
        let segBlob = new Blob(nonEmptySegments[i], { type: blobType });
        if (blobType === "video/webm") {
          try {
            const { default: fixWebmDuration } = await import(
              "fix-webm-duration"
            );
            // We don't have per-segment duration tracked separately —
            // use the accumulated session duration as a best-effort
            // for the FIRST segment; later segments fall back to the
            // segment's natural inferred duration. The duration patch
            // is mostly cosmetic (scrubber UX); concat doesn't depend
            // on it.
            const segDurationMs =
              i === 0 ? this.accumulatedDurationMs : 0;
            segBlob = await fixWebmDuration(segBlob, segDurationMs, {
              logger: false,
            });
          } catch (e) {
            this.callbacks.onLog?.("video:duration-patch-failed", {
              error: e instanceof Error ? e.message : String(e),
              segmentIndex: i,
            });
          }
        }
        segmentBlobs.push(segBlob);
      }

      const segmentUrls = segmentBlobs.map((b) => URL.createObjectURL(b));
      this.callbacks.onLog?.("video:url-ready", {
        segments: segmentUrls.length,
        totalBytes: segmentBlobs.reduce((n, b) => n + b.size, 0),
        mime: blobType,
      });
      this.callbacks.onVideoReady(segmentUrls, duration, blobType);
    }
  }

  /** Shared resource-teardown used by both pause() and stop().
   *  Closes Deepgram, stops MediaRecorders (waits for final chunks),
   *  releases mic + tab streams + self-tab video stream, closes
   *  AudioContext. Does NOT finalize blobs / fire onAudioReady —
   *  that's stop()'s job. */
  /** Detach the zoom-LOCK keydown + wheel listeners. Called from
   *  abortSession() (failed start) and tearDown() (pause / stop) so
   *  the user gets browser zoom back the moment recording ends.
   *  Idempotent — both fields are nulled inside, so subsequent calls
   *  no-op. */
  private detachZoomLock() {
    if (this.zoomLockKeyHandler) {
      window.removeEventListener("keydown", this.zoomLockKeyHandler, {
        capture: true,
      } as EventListenerOptions);
      this.zoomLockKeyHandler = null;
    }
    if (this.zoomLockWheelHandler) {
      window.removeEventListener("wheel", this.zoomLockWheelHandler, {
        capture: true,
      } as EventListenerOptions);
      this.zoomLockWheelHandler = null;
    }
  }

  private async tearDown() {
    // Cancel any pending reconnect attempt — we're shutting down
    // intentionally and don't want a delayed openWs() to revive a
    // socket against half-released streams.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    // Unlock browser zoom — recording is ending (pause or stop), so
    // the user should be able to zoom freely again. On pause/resume
    // the lock is re-attached at the top of the next start().
    this.detachZoomLock();

    // Drop crop-transition listeners. They reference the recorder
    // we're about to release — if we leave them attached, a zoom
    // event during pause would try to pause a null recorder. They'll
    // be re-armed when start() runs on resume.
    if (this.cropResizeObserver) {
      this.cropResizeObserver.disconnect();
      this.cropResizeObserver = null;
    }
    if (this.cropRefreshDebounceTimer) {
      clearTimeout(this.cropRefreshDebounceTimer);
      this.cropRefreshDebounceTimer = null;
    }
    if (this.cropZoomKeyHandler) {
      window.removeEventListener("keydown", this.cropZoomKeyHandler, true);
      this.cropZoomKeyHandler = null;
    }
    if (this.cropZoomWheelHandler) {
      window.removeEventListener("wheel", this.cropZoomWheelHandler, {
        capture: true,
      } as EventListenerOptions);
      this.cropZoomWheelHandler = null;
    }
    if (this.cropZoomViewportHandler && window.visualViewport) {
      window.visualViewport.removeEventListener(
        "resize",
        this.cropZoomViewportHandler
      );
      this.cropZoomViewportHandler = null;
    }
    if (this.cropWindowResizeHandler) {
      window.removeEventListener("resize", this.cropWindowResizeHandler);
      this.cropWindowResizeHandler = null;
    }
    if (this.cropFullscreenHandler) {
      document.removeEventListener(
        "fullscreenchange",
        this.cropFullscreenHandler
      );
      this.cropFullscreenHandler = null;
    }
    if (this.cropScrollHandler) {
      window.removeEventListener("scroll", this.cropScrollHandler, {
        capture: true,
      } as EventListenerOptions);
      this.cropScrollHandler = null;
    }
    if (this.cropScrollThrottleTimer) {
      clearTimeout(this.cropScrollThrottleTimer);
      this.cropScrollThrottleTimer = null;
    }

    // STEP 1: Release ALL capture tracks IMMEDIATELY. This is the
    // critical user-facing release — mic indicator goes off, screen
    // share dialog closes, Chrome's "this tab is being shared" badge
    // disappears. We do this BEFORE awaiting any recorder.onstop so
    // that even if the rest of teardown stalls (Chrome bug, recorder
    // stuck in paused state, etc.) the user's hardware is freed and
    // no further audio reaches the encoder.
    //
    // Side effect: ending all source tracks causes the MediaRecorder
    // to transition to "inactive" automatically and fire onstop —
    // which is exactly what we await below as the most reliable
    // signal that buffered chunks have been flushed. Using stop() on
    // a paused recorder is unreliable in some Chromium versions
    // (onstop never fires); track-end is reliable.
    this.micStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.tabStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.selfTabStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.cameraStream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
    this.micStream = null;
    this.tabStream = null;
    this.selfTabStream = null;
    this.cameraStream = null;
    this.micGainNode = null;

    // STEP 2: Tell Deepgram we're done so it flushes the final transcript.
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        /* ignore */
      }
    }

    // STEP 3: Wait for recorder onstop (final ondataavailable has
    // fired, all chunks are in audioChunks). Bounded by a 1.5s
    // timeout — if the source tracks are stopped, onstop should fire
    // within ~250ms; the timeout exists purely as a safety net so
    // teardown never hangs the page.
    if (this.recorder && this.recorder.state !== "inactive") {
      // If the recorder is paused (some Chromium versions don't fire
      // onstop when transitioning paused → inactive directly), resume
      // it first so the state machine is recording → inactive.
      if (this.recorder.state === "paused") {
        try { this.recorder.resume(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        this.recorder!.onstop = () => {
          clearTimeout(timer);
          finish();
        };
        try {
          this.recorder!.stop();
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
    }

    // Stop the parallel video recorder if we started one. Same
    // resume-then-stop-with-timeout pattern as the audio recorder —
    // the videoRecorder is the one MOST likely to be in paused state
    // because handleCropTransition pauses it on every zoom event.
    if (this.videoRecorder && this.videoRecorder.state !== "inactive") {
      if (this.videoRecorder.state === "paused") {
        try { this.videoRecorder.resume(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          resolve();
        };
        const timer = setTimeout(finish, 1500);
        this.videoRecorder!.onstop = () => {
          clearTimeout(timer);
          finish();
        };
        try {
          this.videoRecorder!.stop();
        } catch {
          clearTimeout(timer);
          finish();
        }
      });
    }

    // STEP 4: Close the socket. Give Deepgram a beat to flush.
    await new Promise((r) => setTimeout(r, 200));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        await this.audioContext.close();
      } catch {
        /* ignore */
      }
    }
    this.audioContext = null;
    // Tear down the diagnostic RMS sampler — its AudioContext + timer
    // are independent of the recording pipeline's audioContext above
    // and need their own teardown.
    this.stopAudioRmsSampling();
    // The mediaStream reference either was the mic stream (already stopped)
    // or a mixed stream whose sources we just released — drop it either way.
    this.mediaStream = null;
    // videoStream's underlying tracks were owned by selfTabStream and
    // mediaStream above, both already stopped. Just drop the wrapper.
    this.videoStream = null;
    this.recorder = null;
    this.videoRecorder = null;
    this.startTime = 0;
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
