import type { AgentConfig, SocialStyle } from "./agents";

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
  private muted = false;
  private lastErrorMessage = "";
  private readyAt = 0;
  private reconnectAttempted = false;
  private stopping = false;
  private errorEmittedForCurrentSession = false;

  constructor(
    private readonly agent: AgentConfig,
    private readonly events: VoiceClientEvents,
  ) {}

  getTranscript(): TranscriptEntry[] {
    return this.transcript;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.micStream) {
      this.micStream.getAudioTracks().forEach((t) => { t.enabled = !m; });
    }
  }

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
    const tick = () => {
      const a = this.analyser;
      const buf = this.analyserBuf;
      if (a && buf) {
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const level = this.muted ? 0 : Math.min(1, rms * 4);
        this.events.onMicLevel?.(level);
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
      src.onended = () => { this.outstandingSources = this.outstandingSources.filter((e) => e !== entry); };
    } catch { /* ignore */ }
  }
}

export interface MicCheckResult {
  ok: boolean;
  permission: "granted" | "denied" | "unavailable" | "error";
  peakLevel: number;
  message?: string;
}

export async function runMicCheck(durationMs = 2000): Promise<MicCheckResult> {
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
  };
  const start = Date.now();
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      tick();
      if (Date.now() - start >= durationMs) { clearInterval(id); resolve(); }
    }, 50);
  });

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
