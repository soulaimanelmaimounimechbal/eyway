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
  onError?: (err: string) => void;
  onSpeakingChange?: (assistantSpeaking: boolean) => void;
  onMicLevel?: (level: number) => void;
}

export type VoiceState =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "closing"
  | "closed"
  | "error";

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
  private analyserBuf: Float32Array | null = null;
  private analyserRaf: number | null = null;
  private micStream: MediaStream | null = null;
  private state: VoiceState = "idle";
  private transcript: TranscriptEntry[] = [];
  private currentAssistantText = "";
  private currentUserText = "";
  private playQueueEndsAt = 0;
  private outstandingSources: AudioOut[] = [];
  private muted = false;

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

    // Analyser for mic level meter
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.analyser = analyser;
    this.analyserBuf = new Float32Array(analyser.fftSize);
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

  private async openSocket(token: string) {
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

    ws.addEventListener("message", (ev) => this.handleAzureMessage(ev.data));
    ws.addEventListener("close", () => {
      if (this.state !== "closing" && this.state !== "closed") {
        this.events.onError?.("connection closed");
        this.setState("closed");
      }
    });

    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: this.agent.instructions,
        voice: this.agent.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad", threshold: 0.5, prefix_padding_ms: 300,
          silence_duration_ms: 600, create_response: true,
        },
      },
    }));
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "assistant", content: [{ type: "text", text: this.agent.greeting }] },
    }));
    ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));

    this.transcript.push({ role: "assistant", text: this.agent.greeting, done: true });
    this.events.onTranscript?.([...this.transcript]);

    this.setState("listening");
  }

  private sendAudioChunk(pcm: Int16Array) {
    if (this.muted) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
    }
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: btoa(bin) }));
  }

  private handleAzureMessage(raw: unknown) {
    let msg: any;
    try {
      const txt = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      msg = JSON.parse(txt);
    } catch { return; }
    switch (msg.type) {
      case "response.audio.delta":
        if (typeof msg.delta === "string") this.playAudioChunk(msg.delta);
        break;
      case "response.audio_transcript.delta":
        if (typeof msg.delta === "string") {
          this.currentAssistantText += msg.delta;
          this.upsertCurrentAssistant();
        }
        break;
      case "response.audio_transcript.done":
      case "response.output_item.done":
        if (this.currentAssistantText.trim().length > 0) this.commitAssistant();
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (typeof msg.delta === "string") {
          this.currentUserText += msg.delta;
          this.upsertCurrentUser();
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof msg.transcript === "string") {
          this.currentUserText = msg.transcript;
          this.commitUser();
        }
        break;
      case "input_audio_buffer.speech_started":
        this.events.onSpeakingChange?.(false);
        break;
      case "response.created":
        this.events.onSpeakingChange?.(true);
        break;
      case "response.done":
        if (this.currentAssistantText.trim().length > 0) this.commitAssistant();
        this.events.onSpeakingChange?.(false);
        break;
      case "error":
        this.events.onError?.(String(msg.error?.message ?? "voice error"));
        break;
      default: break;
    }
  }

  private upsertCurrentAssistant() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "assistant" && !last.done) last.text = this.currentAssistantText;
    else this.transcript.push({ role: "assistant", text: this.currentAssistantText, done: false });
    this.events.onTranscript?.([...this.transcript]);
  }
  private commitAssistant() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "assistant" && !last.done) { last.text = this.currentAssistantText; last.done = true; }
    else this.transcript.push({ role: "assistant", text: this.currentAssistantText, done: true });
    this.currentAssistantText = "";
    this.events.onTranscript?.([...this.transcript]);
  }
  private upsertCurrentUser() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "user" && !last.done) last.text = this.currentUserText;
    else this.transcript.push({ role: "user", text: this.currentUserText, done: false });
    this.events.onTranscript?.([...this.transcript]);
  }
  private commitUser() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "user" && !last.done) { last.text = this.currentUserText; last.done = true; }
    else this.transcript.push({ role: "user", text: this.currentUserText, done: true });
    this.currentUserText = "";
    this.events.onTranscript?.([...this.transcript]);
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

  // Tier rules combine keyword adaptation + substantive (long enough) responses.
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
