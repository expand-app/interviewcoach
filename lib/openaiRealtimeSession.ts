/**
 * OpenAI Realtime voice session over WebRTC — used ONLY by the Retake
 * (mock interview) flow's OpenAI engine. Wraps the RTCPeerConnection,
 * the data channel (JSON events), mic uplink, and AI-audio downlink.
 *
 * Connection flow (GA Realtime, verified July 2026):
 *   1) POST /api/retake/realtime-token  → ephemeral "ek_..." secret
 *   2) new RTCPeerConnection; add mic track; create "oai-events" data channel
 *   3) createOffer → setLocalDescription
 *   4) POST offer.sdp to https://api.openai.com/v1/realtime/calls
 *      (Authorization: Bearer ek_..., Content-Type: application/sdp)
 *   5) setRemoteDescription(answer)
 *
 * The AI's voice arrives as a remote MediaStream (`remoteStream`):
 *   - played to the speakers via a hidden <audio> element (here)
 *   - ALSO handed to AudioSession as `auxAudioStream` by the caller,
 *     so the AI voice is captured into the session recording — exactly
 *     the seam the Aura path used.
 *
 * Turn-taking (server VAD) and barge-in are handled by OpenAI; this
 * class just surfaces the events the controller needs.
 */

export interface RealtimeSessionCallbacks {
  /** Candidate started speaking (server VAD). Drives "hearing you". */
  onSpeechStarted?: () => void;
  /** Candidate stopped speaking (server VAD committed the turn). */
  onSpeechStopped?: () => void;
  /** Final transcript of the CANDIDATE's utterance. */
  onCandidateTranscript?: (text: string) => void;
  /** Final transcript of an AI spoken turn (question / follow-up). */
  onAiTranscript?: (text: string) => void;
  /** The model began a new spoken response (drives the "AI speaking"
   *  phase in the call UI). */
  onResponseCreated?: () => void;
  /** One AI response fully finished (audio + transcript). */
  onResponseDone?: () => void;
  /** The model called a function tool by name (e.g. "end_interview"). */
  onFunctionCall?: (name: string) => void;
  /** The remote AI audio stream is available (for recording capture). */
  onRemoteStream?: (stream: MediaStream) => void;
  onError?: (msg: string) => void;
  onLog?: (event: string, data?: Record<string, unknown>) => void;
}

export interface RealtimeConnectOptions {
  /** Mic stream for the OpenAI uplink (separate from AudioSession's own
   *  recording mic — muting handles both in the controller). */
  micStream: MediaStream;
  /** Full session instructions (persona + language + plan). */
  instructions: string;
  voice?: string;
  language?: "en" | "zh";
}

export class OpenAiRealtimeSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private closed = false;
  /** The AI voice stream — connect() resolves after this is wired. */
  public remoteStream: MediaStream | null = null;

  constructor(private cb: RealtimeSessionCallbacks) {}

  async connect(opts: RealtimeConnectOptions): Promise<void> {
    // 1) Ephemeral secret (master key stays server-side).
    const tokenResp = await fetch("/api/retake/realtime-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instructions: opts.instructions,
        voice: opts.voice,
        language: opts.language,
      }),
    });
    if (!tokenResp.ok) {
      const detail = await tokenResp.text().catch(() => "");
      throw new Error(
        `realtime token failed (${tokenResp.status}): ${detail.slice(0, 200)}`
      );
    }
    const { value: ephemeral } = (await tokenResp.json()) as {
      value?: string;
    };
    if (!ephemeral) throw new Error("no ephemeral secret from token route");

    // 2) Peer connection.
    const pc = new RTCPeerConnection();
    this.pc = pc;

    // AI audio downlink → hidden <audio> for playback + expose for recording.
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      this.remoteStream = stream;
      if (!this.audioEl) {
        const el = document.createElement("audio");
        el.autoplay = true;
        // Not added to the DOM tree visibly; autoplay still works with a
        // prior user gesture (the "Start interview" click).
        el.style.display = "none";
        document.body.appendChild(el);
        this.audioEl = el;
      }
      this.audioEl.srcObject = stream;
      void this.audioEl.play().catch(() => {});
      this.cb.onRemoteStream?.(stream);
    };

    // Mic uplink.
    const micTrack = opts.micStream.getAudioTracks()[0];
    if (micTrack) pc.addTrack(micTrack, opts.micStream);

    // 3) Data channel for JSON events.
    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (ev) => this.handleEvent(ev.data);
    dc.onerror = () => this.cb.onLog?.("rt:dc-error", {});

    pc.onconnectionstatechange = () => {
      this.cb.onLog?.("rt:conn-state", { state: pc.connectionState });
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      ) {
        if (!this.closed) this.cb.onError?.("Realtime connection lost");
      }
    };

    // 4) SDP offer → OpenAI → answer.
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ephemeral}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp ?? "",
    });
    if (!sdpResp.ok) {
      const detail = await sdpResp.text().catch(() => "");
      throw new Error(
        `realtime SDP exchange failed (${sdpResp.status}): ${detail.slice(0, 200)}`
      );
    }
    const answerSdp = await sdpResp.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.cb.onLog?.("rt:connected", {});
  }

  /** Ask the AI to produce a spoken turn described by `instructions`
   *  (e.g. "Ask the candidate this, in your own words: ..."). The
   *  session's turn_detection has create_response:false, so the AI
   *  only speaks when we tell it to. */
  requestSpeak(instructions: string): void {
    this.send({
      type: "response.create",
      response: { instructions },
    });
  }

  /** Cancel the in-flight AI response (used on hard interrupts / end). */
  cancelResponse(): void {
    this.send({ type: "response.cancel" });
  }

  /** Mute/unmute the OpenAI uplink so it stops "hearing" the candidate
   *  (separate from the recording mic gain). */
  setMicEnabled(enabled: boolean): void {
    this.pc?.getSenders().forEach((s) => {
      if (s.track && s.track.kind === "audio") s.track.enabled = enabled;
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.dc?.close();
    } catch {
      /* noop */
    }
    try {
      this.pc?.getSenders().forEach((s) => s.track?.stop());
      this.pc?.close();
    } catch {
      /* noop */
    }
    if (this.audioEl) {
      try {
        this.audioEl.srcObject = null;
        this.audioEl.remove();
      } catch {
        /* noop */
      }
      this.audioEl = null;
    }
    this.pc = null;
    this.dc = null;
    this.remoteStream = null;
  }

  private send(obj: unknown): void {
    if (this.dc && this.dc.readyState === "open") {
      this.dc.send(JSON.stringify(obj));
    } else {
      this.cb.onLog?.("rt:send-dropped", { state: this.dc?.readyState });
    }
  }

  private handleEvent(raw: unknown): void {
    if (typeof raw !== "string") return;
    let evt: {
      type?: string;
      transcript?: string;
      name?: string;
      error?: unknown;
      response?: {
        output?: Array<{ type?: string; name?: string }>;
      };
    };
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    const type = evt.type ?? "";

    // Candidate voice activity (server VAD).
    if (type === "input_audio_buffer.speech_started") {
      this.cb.onSpeechStarted?.();
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      this.cb.onSpeechStopped?.();
      return;
    }

    // Candidate transcript. GA event name has iterated; match defensively
    // on any input-transcription "completed" event carrying a transcript.
    if (
      type.includes("input_audio_transcription") &&
      type.endsWith(".completed")
    ) {
      if (typeof evt.transcript === "string" && evt.transcript.trim()) {
        this.cb.onCandidateTranscript?.(evt.transcript.trim());
      }
      return;
    }

    // AI spoken-turn transcript done. Accept both the GA name and the
    // older audio_transcript name.
    if (
      type === "response.output_audio_transcript.done" ||
      type === "response.audio_transcript.done"
    ) {
      if (typeof evt.transcript === "string" && evt.transcript.trim()) {
        this.cb.onAiTranscript?.(evt.transcript.trim());
      }
      return;
    }

    // The model began a new spoken response → "AI speaking" phase.
    if (type === "response.created") {
      this.cb.onResponseCreated?.();
      return;
    }

    // A function tool the model called mid-stream (fires before
    // response.done). Surface the name.
    if (
      type.includes("function_call") &&
      (type.endsWith(".done") || type.endsWith(".arguments.done"))
    ) {
      if (typeof evt.name === "string" && evt.name) {
        this.cb.onFunctionCall?.(evt.name);
      }
      return;
    }

    if (type === "response.done") {
      // Belt-and-suspenders: also scan the finished response's output
      // for function_call items (the streamed event above may not carry
      // the name in every API revision).
      const calls = (evt.response?.output ?? []).filter(
        (o) => o.type === "function_call" && o.name
      );
      for (const call of calls) this.cb.onFunctionCall?.(call.name as string);
      this.cb.onResponseDone?.();
      return;
    }

    if (type === "error") {
      const msg =
        typeof evt.error === "object" && evt.error
          ? JSON.stringify(evt.error).slice(0, 200)
          : "realtime error";
      this.cb.onError?.(msg);
      this.cb.onLog?.("rt:error", { error: evt.error });
    }
  }
}
