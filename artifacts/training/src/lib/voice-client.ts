import { DEFAULT_INTENSITY, type AgentConfig, type Intensity, type SocialStyle } from "./agents";

const SAMPLE_RATE = 24000;

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  done: boolean;
}

export interface VoiceClientEvents {
  onStateChange?: (s: VoiceState) => void;
  onTranscript?: (t: TranscriptEntry[]) => void;
  onError?: (err: string, kind?: ErrorKind) => void;
  onWarning?: (msg: string, kind?: WarningKind) => void;
  onSpeakingChange?: (assistantSpeaking: boolean) => void;
  onMicLevel?: (level: number) => void;
  onAssistantLevel?: (level: number) => void;
  onSilenceHint?: (silent: boolean) => void;
}

export type VoiceState =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "reconnecting"
  | "closing"
  | "closed"
  | "error";

export type ErrorKind = "config" | "fatal" | "transient" | "lost_connection";
export type WarningKind = "transient" | "voice_fallback";

const RECONNECT_WINDOW_MS = 5_000;

// Minimum cumulative time the user must spend above the speech floor
// during a single push-to-talk turn before we'll commit the buffer.
// Tuned to filter taps, single coughs, and breath noise without rejecting
// genuine short utterances ("yes", "okay").
const MIN_SPEECH_MS = 400;
// Minimum peak normalized RMS level seen during the turn. The level loop
// already normalizes by `rms * 4`, so 0.08 corresponds to a clearly
// audible word, not just room noise breaking the 0.04 noise floor.
const MIN_SPEECH_PEAK = 0.08;

interface AudioOut {
  source: AudioBufferSourceNode;
  endsAt: number;
}

export class VoiceClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private playCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;
  private analyserRaf: number | null = null;
  private micStream: MediaStream | null = null;
  private state: VoiceState = "idle";
  private transcript: TranscriptEntry[] = [];
  private playQueueEndsAt = 0;
  private outstandingSources: AudioOut[] = [];
  // Push-to-talk: mic is muted by default. The UI calls engageMic() while
  // the user holds (or after they tap) the speak button, and releaseMic()
  // when they let go, which commits the audio buffer upstream so the model
  // generates a response.
  private muted = true;
  private micActive = false;
  private audioSentSinceEngage = false;
  // Speech-quality gate. We don't want a stray cough or half-pressed PTT to
  // commit a turn and provoke a reply, so we require the user to actually
  // speak above a noise floor for a minimum duration before we'll commit.
  private speechMsSinceEngage = 0;
  private peakLevelSinceEngage = 0;
  private lastSpeechTickAt = 0;
  private lastErrorMessage = "";
  private readyAt = 0;
  private reconnectAttempted = false;
  private stopping = false;
  private errorEmittedForCurrentSession = false;
  private lastInputAboveFloorAt = 0;
  private silenceHintActive = false;
  private lastMicLevelEmitAt = 0;
  private assistantLevelTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly agent: AgentConfig,
    private readonly intensity: Intensity,
    private readonly events: VoiceClientEvents,
  ) {}

  getTranscript(): TranscriptEntry[] {
    return this.transcript;
  }

  private applyMuteToTracks() {
    if (this.micStream) {
      this.micStream.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    }
  }

  /**
   * Open the mic and start streaming PCM upstream. The server's VAD is
   * disabled, so no response will fire until releaseMic() commits.
   */
  engageMic() {
    if (this.micActive) return;
    this.micActive = true;
    this.muted = false;
    this.audioSentSinceEngage = false;
    this.speechMsSinceEngage = 0;
    this.peakLevelSinceEngage = 0;
    this.lastSpeechTickAt = 0;
    this.lastInputAboveFloorAt = Date.now();
    this.applyMuteToTracks();
  }

  /**
   * Close the mic. If we streamed at least one frame, commit the buffer
   * so the model produces a response; otherwise clear it so we don't
   * provoke an "empty buffer" error from upstream.
   */
  releaseMic() {
    if (!this.micActive) return;
    this.micActive = false;
    this.muted = true;
    this.applyMuteToTracks();
    if (this.silenceHintActive) {
      this.silenceHintActive = false;
      this.events.onSilenceHint?.(false);
    }
    // Speech-quality gate: only commit if the user actually spoke. Without
    // this, a quick PTT tap, a stray cough, or background noise would send a
    // sub-second buffer upstream and the persona would invent a reply to it.
    const spokeEnough =
      this.audioSentSinceEngage &&
      this.speechMsSinceEngage >= MIN_SPEECH_MS &&
      this.peakLevelSinceEngage >= MIN_SPEECH_PEAK;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({ type: spokeEnough ? "commit" : "clear" });
      try { this.ws.send(payload); } catch { /* swallow */ }
    }
    if (!spokeEnough && this.audioSentSinceEngage) {
      this.events.onWarning?.(
        "We didn't catch that — hold the button and speak clearly.",
        "transient",
      );
    }
    this.audioSentSinceEngage = false;
    this.speechMsSinceEngage = 0;
    this.peakLevelSinceEngage = 0;
    this.lastSpeechTickAt = 0;
  }

  isMicActive(): boolean { return this.micActive; }
  isMuted(): boolean { return this.muted; }

  async start(): Promise<void> {
    this.lastErrorMessage = "";
    this.setState("connecting");
    try {
      const token = await this.fetchToken();
      await this.setupAudio();
      await this.openSocket(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events.onError?.(msg);
      this.setState("error");
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return;
    this.stopping = true;
    this.setState("closing");
    try { this.ws?.close(); } catch {}
    this.ws = null;
    this.clearAssistantLevelTimers();
    if (this.silenceHintActive) {
      this.silenceHintActive = false;
      this.events.onSilenceHint?.(false);
    }
    if (this.analyserRaf != null) {
      cancelAnimationFrame(this.analyserRaf);
      this.analyserRaf = null;
    }
    if (this.workletNode) { try { this.workletNode.disconnect(); } catch {} this.workletNode = null; }
    if (this.analyser) { try { this.analyser.disconnect(); } catch {} this.analyser = null; }
    if (this.micStream) { this.micStream.getTracks().forEach((t) => t.stop()); this.micStream = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch {} this.ctx = null; }
    if (this.playCtx) {
      const now = this.playCtx.currentTime;
      const wait = Math.max(0, this.playQueueEndsAt - now) * 1000 + 200;
      const pc = this.playCtx;
      this.playCtx = null;
      setTimeout(() => { pc.close().catch(() => {}); }, wait);
    }
    this.setState("closed");
  }

  private setState(s: VoiceState) {
    this.state = s;
    // Silence hint is only meaningful while actively listening. Clear it on
    // any transition out so it can't persist into reconnecting / closed / etc.
    if (s !== "listening" && this.silenceHintActive) {
      this.silenceHintActive = false;
      this.events.onSilenceHint?.(false);
    }
    if (s === "listening") {
      this.lastInputAboveFloorAt = Date.now();
    }
    this.events.onStateChange?.(s);
  }

  private async fetchToken(): Promise<string> {
    const r = await fetch("/api/voice-live/token", { method: "POST" });
    if (!r.ok) throw new Error(`could not start session (${r.status})`);
    const j = (await r.json()) as { token: string };
    if (!j.token) throw new Error("invalid session token");
    return j.token;
  }

  private async setupAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micStream = stream;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.ctx = ctx;
    const workletUrl = `${import.meta.env.BASE_URL}pcm-processor.js`;
    await ctx.audioWorklet.addModule(workletUrl);

    const source = ctx.createMediaStreamSource(stream);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.analyser = analyser;
    this.analyserBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    source.connect(analyser);

    const node = new AudioWorkletNode(ctx, "pcm-processor", {
      numberOfInputs: 1, numberOfOutputs: 0,
      channelCount: 1, channelCountMode: "explicit",
    });
    this.workletNode = node;
    node.port.onmessage = (ev) => { this.sendAudioChunk(ev.data as Int16Array); };
    source.connect(node);

    this.playCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (this.playCtx.state === "suspended") { try { await this.playCtx.resume(); } catch {} }
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch {} }

    this.startLevelLoop();
  }

  private startLevelLoop() {
    const FLOOR = 0.04;
    const SILENCE_MS = 6000;
    const EMIT_MS = 60; // ~16Hz cap so React doesn't re-render every frame
    this.lastInputAboveFloorAt = Date.now();
    this.lastMicLevelEmitAt = 0;
    const tick = () => {
      const a = this.analyser;
      const buf = this.analyserBuf;
      if (a && buf) {
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const level = this.muted ? 0 : Math.min(1, rms * 4);
        const now = Date.now();
        if (now - this.lastMicLevelEmitAt >= EMIT_MS) {
          this.lastMicLevelEmitAt = now;
          this.events.onMicLevel?.(level);
        }

        if (!this.muted && level >= FLOOR) {
          // Accumulate "real speech" time while the mic is engaged so the
          // releaseMic() gate can reject sub-threshold turns. We sum the
          // gap from the previous above-floor tick (capped at 100ms so a
          // long quiet gap doesn't get credited as speech).
          if (this.micActive) {
            if (this.lastSpeechTickAt > 0) {
              this.speechMsSinceEngage += Math.min(100, now - this.lastSpeechTickAt);
            }
            this.lastSpeechTickAt = now;
            if (level > this.peakLevelSinceEngage) this.peakLevelSinceEngage = level;
          }
          this.lastInputAboveFloorAt = now;
          if (this.silenceHintActive) {
            this.silenceHintActive = false;
            this.events.onSilenceHint?.(false);
          }
        } else if (this.state === "listening" && !this.muted && now - this.lastInputAboveFloorAt > SILENCE_MS) {
          if (!this.silenceHintActive) {
            this.silenceHintActive = true;
            this.events.onSilenceHint?.(true);
          }
        }
      }
      this.analyserRaf = requestAnimationFrame(tick);
    };
    this.analyserRaf = requestAnimationFrame(tick);
  }

  private async openSocket(token: string, opts?: { isReconnect?: boolean }) {
    const isReconnect = opts?.isReconnect === true;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/voice-live?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error("voice connection failed")); };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onErr);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onErr);
    });

    ws.addEventListener("message", (ev) => this.handleServerMessage(ev.data));
    ws.addEventListener("close", () => {
      void this.handleSocketClose();
    });

    // Reset per-session flags so a reconnect can emit its own error/ready cleanly.
    this.errorEmittedForCurrentSession = false;
    this.readyAt = 0;

    ws.send(JSON.stringify({
      type: "start",
      resume: isReconnect,
      instructions: this.agent.instructions,
      intensity: this.intensity,
      voice: this.agent.voice,
      fallbackVoices: this.agent.fallbackVoices,
      greeting: this.agent.greeting,
    }));

    if (!isReconnect) {
      // Optimistically show the greeting in the transcript; the server will speak it.
      this.transcript.push({ role: "assistant", text: this.agent.greeting, done: true });
      this.events.onTranscript?.([...this.transcript]);
    }

    this.setState("listening");
  }

  private isTerminating(): boolean {
    return this.stopping || this.state === "closing" || this.state === "closed";
  }

  private async handleSocketClose() {
    if (this.isTerminating()) return;
    // If the user was actively speaking when the socket dropped, drop the
    // mic state so we don't later try to commit over a dead/new session.
    // The UI watches `state` and will reset its own micActive via its
    // auto-release effect; this just makes the VoiceClient consistent.
    if (this.micActive) {
      this.micActive = false;
      this.muted = true;
      this.audioSentSinceEngage = false;
      this.applyMuteToTracks();
    }
    const eligibleForReconnect =
      !this.reconnectAttempted &&
      this.readyAt > 0 &&
      Date.now() - this.readyAt < RECONNECT_WINDOW_MS;
    if (eligibleForReconnect) {
      this.reconnectAttempted = true;
      this.setState("reconnecting");
      try {
        const token = await this.fetchToken();
        // Re-check after async work: stop() may have run while we awaited.
        if (this.isTerminating()) return;
        await this.openSocket(token, { isReconnect: true });
        if (this.isTerminating()) {
          try { this.ws?.close(); } catch { /* noop */ }
          return;
        }
        return;
      } catch (err) {
        if (this.stopping) return;
        const msg = err instanceof Error ? err.message : String(err);
        this.lastErrorMessage = msg;
      }
    }
    // If an `error` event already surfaced for this session, don't also emit a
    // generic "lost_connection" on top of it — that produced duplicate banners.
    if (!this.errorEmittedForCurrentSession) {
      this.events.onError?.(this.lastErrorMessage || "connection lost", "lost_connection");
    }
    this.setState("closed");
  }

  private sendAudioChunk(pcm: Int16Array) {
    if (this.muted) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const buf = new ArrayBuffer(pcm.byteLength);
    new Int16Array(buf).set(pcm);
    this.ws.send(buf);
    this.audioSentSinceEngage = true;
  }

  private handleServerMessage(raw: unknown) {
    let msg: { type?: string; [k: string]: unknown };
    try {
      const txt = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      msg = JSON.parse(txt);
    } catch { return; }

    switch (msg.type) {
      case "ready":
        this.readyAt = Date.now();
        break;
      case "warning": {
        const m = String(msg["message"] ?? "");
        const k = (msg["kind"] as WarningKind | undefined);
        if (m) this.events.onWarning?.(m, k);
        break;
      }
      case "audio_delta":
        if (typeof msg["delta"] === "string") this.playAudioChunk(msg["delta"] as string);
        break;
      case "assistant_transcript":
        if (typeof msg["text"] === "string") this.pushTranscript("assistant", msg["text"] as string);
        break;
      case "user_transcript":
        if (typeof msg["text"] === "string") this.pushTranscript("user", msg["text"] as string);
        break;
      case "speech_started":
        this.cancelPendingPlayback();
        this.events.onSpeakingChange?.(false);
        break;
      case "assistant_speaking":
        this.events.onSpeakingChange?.(Boolean(msg["value"]));
        break;
      case "error": {
        const m = String(msg["message"] ?? "voice error");
        const k = (msg["kind"] as ErrorKind | undefined) ?? "fatal";
        this.lastErrorMessage = m;
        // For lost_connection we hold the error until the close handler has
        // decided whether reconnect succeeded — otherwise users would see a
        // red banner during a recovery we are about to complete silently.
        if (k === "lost_connection") break;
        this.errorEmittedForCurrentSession = true;
        this.events.onError?.(m, k);
        break;
      }
      default: break;
    }
  }

  private pushTranscript(role: "user" | "assistant", text: string) {
    const t = text.trim();
    if (!t) return;
    // Avoid duplicating the optimistic greeting line.
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === role && last.done && last.text.trim() === t) return;
    this.transcript.push({ role, text: t, done: true });
    this.events.onTranscript?.([...this.transcript]);
  }

  private cancelPendingPlayback() {
    if (!this.playCtx) return;
    const now = this.playCtx.currentTime;
    for (const o of this.outstandingSources) {
      if (o.endsAt > now) { try { o.source.stop(); } catch { /* noop */ } }
    }
    this.outstandingSources = [];
    this.playQueueEndsAt = now;
    this.clearAssistantLevelTimers();
    this.events.onAssistantLevel?.(0);
  }

  private clearAssistantLevelTimers() {
    for (const id of this.assistantLevelTimers) clearTimeout(id);
    this.assistantLevelTimers = [];
  }

  private playAudioChunk(b64: string) {
    if (!this.playCtx) return;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bin.length / 2);
      const float = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float[i] = pcm[i] / 0x8000;

      // Per-chunk RMS so the UI can drive an assistant waveform without
      // tapping the WebAudio graph from React.
      let sum = 0;
      for (let i = 0; i < float.length; i++) sum += float[i] * float[i];
      const rms = Math.sqrt(sum / Math.max(1, float.length));
      const level = Math.min(1, rms * 3);

      const buf = this.playCtx.createBuffer(1, float.length, SAMPLE_RATE);
      buf.copyToChannel(float, 0);
      const src = this.playCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.playCtx.destination);
      const now = this.playCtx.currentTime;
      const startAt = Math.max(now, this.playQueueEndsAt);
      src.start(startAt);
      const endsAt = startAt + buf.duration;
      this.playQueueEndsAt = endsAt;
      const entry: AudioOut = { source: src, endsAt };
      this.outstandingSources.push(entry);

      const emit = this.events.onAssistantLevel;
      if (emit) {
        const delay = Math.max(0, startAt - now) * 1000;
        const t1 = setTimeout(() => {
          this.assistantLevelTimers = this.assistantLevelTimers.filter((x) => x !== t1);
          emit(level);
        }, delay);
        const t2 = setTimeout(() => {
          this.assistantLevelTimers = this.assistantLevelTimers.filter((x) => x !== t2);
          if (this.outstandingSources.length === 0) emit(0);
        }, delay + buf.duration * 1000);
        this.assistantLevelTimers.push(t1, t2);
      }
      src.onended = () => {
        this.outstandingSources = this.outstandingSources.filter((e) => e !== entry);
        if (this.outstandingSources.length === 0) this.events.onAssistantLevel?.(0);
      };
    } catch { /* ignore */ }
  }
}

export interface MicCheckResult {
  ok: boolean;
  permission: "granted" | "denied" | "unavailable" | "error";
  peakLevel: number;
  message?: string;
}

export async function runMicCheck(
  durationMs = 2000,
  onLevel?: (level: number) => void,
): Promise<MicCheckResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, permission: "unavailable", peakLevel: 0, message: "Microphone API unavailable in this browser." };
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = (err as DOMException | null)?.name ?? "";
    const denied = name === "NotAllowedError" || name === "SecurityError";
    return {
      ok: false,
      permission: denied ? "denied" : "error",
      peakLevel: 0,
      message: denied
        ? "Microphone permission denied. Click the camera/mic icon in the address bar and allow access."
        : ((err as Error).message || "Could not access microphone."),
    };
  }

  const AudioCtor: typeof AudioContext =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtor();
  if (ctx.state === "suspended") { try { await ctx.resume(); } catch { /* noop */ } }
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  let peak = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const level = Math.min(1, rms * 4);
    if (level > peak) peak = level;
    onLevel?.(level);
  };
  const start = Date.now();
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      tick();
      if (Date.now() - start >= durationMs) { clearInterval(id); resolve(); }
    }, 50);
  });
  onLevel?.(0);

  try { src.disconnect(); } catch { /* noop */ }
  try { analyser.disconnect(); } catch { /* noop */ }
  try { await ctx.close(); } catch { /* noop */ }
  stream.getTracks().forEach((t) => t.stop());

  const FLOOR = 0.03;
  return {
    ok: peak >= FLOOR,
    permission: "granted",
    peakLevel: peak,
    message: peak < FLOOR ? "We didn't pick up your voice. Try moving closer to the mic and say a few words." : undefined,
  };
}

export interface VoiceProbeResult {
  ok: boolean;
  message?: string;
  kind?: "config" | "fatal" | "transient" | "network";
  voice?: string;
}

export async function runVoiceProbe(agent: AgentConfig, timeoutMs = 6000): Promise<VoiceProbeResult> {
  let token: string;
  try {
    const r = await fetch("/api/voice-live/token", { method: "POST" });
    if (!r.ok) return { ok: false, kind: "fatal", message: `token mint failed (${r.status})` };
    const j = (await r.json()) as { token?: string };
    if (!j.token) return { ok: false, kind: "fatal", message: "token mint returned no token" };
    token = j.token;
  } catch (err) {
    return { ok: false, kind: "network", message: (err as Error).message || "could not reach server" };
  }

  return await new Promise<VoiceProbeResult>((resolve) => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/voice-live?token=${encodeURIComponent(token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      resolve({ ok: false, kind: "network", message: (err as Error).message || "could not open websocket" });
      return;
    }
    let settled = false;
    const finish = (r: VoiceProbeResult) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* noop */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, kind: "transient", message: "probe timed out" }), timeoutMs);
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify({
          type: "start",
          probe: true,
          instructions: "",
          voice: agent.voice,
          fallbackVoices: agent.fallbackVoices,
          greeting: "",
        }));
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, kind: "network", message: (err as Error).message });
      }
    });
    ws.addEventListener("message", (ev) => {
      try {
        const txt = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
        const msg = JSON.parse(txt) as { type?: string; kind?: string; message?: string; voice?: string };
        if (msg.type === "probe_ok") {
          clearTimeout(timer);
          finish({ ok: true, voice: msg.voice });
        } else if (msg.type === "error") {
          clearTimeout(timer);
          const k = msg.kind === "config" || msg.kind === "transient" ? msg.kind : "fatal";
          finish({ ok: false, kind: k, message: msg.message ?? "voice probe failed" });
        }
      } catch { /* ignore */ }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      finish({ ok: false, kind: "network", message: "voice connection failed" });
    });
    ws.addEventListener("close", () => {
      // If we got here without resolving, treat as failure.
      clearTimeout(timer);
      finish({ ok: false, kind: "network", message: "probe closed before completing" });
    });
  });
}

export function scoreTranscript(
  transcript: TranscriptEntry[],
  style: SocialStyle,
  agentKeywords: string[],
): { tier: "green" | "amber" | "red"; hits: string[]; userTurns: number; avgWords: number } {
  void style;
  const userEntries = transcript.filter((t) => t.role === "user" && t.done && t.text.trim().length > 0);
  const userText = userEntries.map((t) => t.text.toLowerCase()).join(" ");
  const userTurns = userEntries.length;
  const totalWords = userEntries.reduce((sum, t) => sum + t.text.trim().split(/\s+/).length, 0);
  const avgWords = userTurns === 0 ? 0 : totalWords / userTurns;
  const hits = Array.from(new Set(agentKeywords.filter((k) => userText.includes(k.toLowerCase()))));

  let tier: "green" | "amber" | "red";
  if (userTurns < 2 || avgWords < 4) {
    tier = "red";
  } else if (hits.length >= 3 && userTurns >= 3 && avgWords >= 10) {
    tier = "green";
  } else if (hits.length >= 1 && avgWords >= 6) {
    tier = "amber";
  } else if (hits.length >= 1) {
    tier = "amber";
  } else {
    tier = "red";
  }
  return { tier, hits, userTurns, avgWords };
}
