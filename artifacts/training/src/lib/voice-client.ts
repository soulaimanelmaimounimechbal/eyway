import type { SocialStyle, AgentConfig } from "./agents";

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
  private micStream: MediaStream | null = null;
  private state: VoiceState = "idle";
  private transcript: TranscriptEntry[] = [];
  private currentAssistantText = "";
  private currentUserText = "";
  private playQueueEndsAt = 0;
  private outstandingSources: AudioOut[] = [];

  constructor(
    private readonly agent: AgentConfig,
    private readonly events: VoiceClientEvents,
  ) {}

  getTranscript(): TranscriptEntry[] {
    return this.transcript;
  }

  async start(): Promise<void> {
    this.setState("connecting");
    try {
      await this.setupAudio();
      await this.openSocket();
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
    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch {}
      this.workletNode = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch {}
      this.ctx = null;
    }
    // Let any queued audio play out, then close playback context
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

  private async setupAudio() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.micStream = stream;

    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.ctx = ctx;
    const workletUrl = `${import.meta.env.BASE_URL}pcm-processor.js`;
    await ctx.audioWorklet.addModule(workletUrl);

    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "pcm-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
    });
    this.workletNode = node;

    node.port.onmessage = (ev) => {
      const data = ev.data as Int16Array;
      this.sendAudioChunk(data);
    };

    source.connect(node);

    // Separate context for playback so we can resume independently
    this.playCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (this.playCtx.state === "suspended") {
      try { await this.playCtx.resume(); } catch { /* noop */ }
    }
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch { /* noop */ }
    }
  }

  private async openSocket() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/voice-live`;
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

    // Configure the session with persona instructions, voice, VAD, and transcription
    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: this.agent.instructions,
        voice: this.agent.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
          create_response: true,
        },
      },
    };
    ws.send(JSON.stringify(sessionUpdate));

    // Seed the assistant's first message so it speaks before the user does.
    const greeting = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: this.agent.greeting }],
      },
    };
    ws.send(JSON.stringify(greeting));
    ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));

    // Reflect the greeting in the local transcript immediately.
    this.transcript.push({ role: "assistant", text: this.agent.greeting, done: true });
    this.events.onTranscript?.([...this.transcript]);

    this.setState("listening");
  }

  private sendAudioChunk(pcm: Int16Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Convert Int16Array to base64
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
    }
    const b64 = btoa(bin);
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
  }

  private handleAzureMessage(raw: unknown) {
    let msg: any;
    try {
      const txt = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
      msg = JSON.parse(txt);
    } catch {
      return;
    }
    switch (msg.type) {
      case "response.audio.delta": {
        if (typeof msg.delta === "string") this.playAudioChunk(msg.delta);
        break;
      }
      case "response.audio_transcript.delta": {
        if (typeof msg.delta === "string") {
          this.currentAssistantText += msg.delta;
          this.upsertCurrentAssistant();
        }
        break;
      }
      case "response.audio_transcript.done":
      case "response.output_item.done": {
        if (this.currentAssistantText.trim().length > 0) {
          this.commitAssistant();
        }
        break;
      }
      case "conversation.item.input_audio_transcription.delta": {
        if (typeof msg.delta === "string") {
          this.currentUserText += msg.delta;
          this.upsertCurrentUser();
        }
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (typeof msg.transcript === "string") {
          this.currentUserText = msg.transcript;
          this.commitUser();
        }
        break;
      }
      case "input_audio_buffer.speech_started": {
        this.events.onSpeakingChange?.(false);
        break;
      }
      case "response.created": {
        this.events.onSpeakingChange?.(true);
        break;
      }
      case "response.done": {
        if (this.currentAssistantText.trim().length > 0) this.commitAssistant();
        this.events.onSpeakingChange?.(false);
        break;
      }
      case "error": {
        const message = msg.error?.message ?? "voice error";
        this.events.onError?.(String(message));
        break;
      }
      default: break;
    }
  }

  private upsertCurrentAssistant() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "assistant" && !last.done) {
      last.text = this.currentAssistantText;
    } else {
      this.transcript.push({ role: "assistant", text: this.currentAssistantText, done: false });
    }
    this.events.onTranscript?.([...this.transcript]);
  }

  private commitAssistant() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "assistant" && !last.done) {
      last.text = this.currentAssistantText;
      last.done = true;
    } else {
      this.transcript.push({ role: "assistant", text: this.currentAssistantText, done: true });
    }
    this.currentAssistantText = "";
    this.events.onTranscript?.([...this.transcript]);
  }

  private upsertCurrentUser() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "user" && !last.done) {
      last.text = this.currentUserText;
    } else {
      this.transcript.push({ role: "user", text: this.currentUserText, done: false });
    }
    this.events.onTranscript?.([...this.transcript]);
  }

  private commitUser() {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === "user" && !last.done) {
      last.text = this.currentUserText;
      last.done = true;
    } else {
      this.transcript.push({ role: "user", text: this.currentUserText, done: true });
    }
    this.currentUserText = "";
    this.events.onTranscript?.([...this.transcript]);
  }

  private playAudioChunk(b64: string) {
    if (!this.playCtx) return;
    try {
      const bin = atob(b64);
      const len = bin.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, len / 2);
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
      src.onended = () => {
        this.outstandingSources = this.outstandingSources.filter((e) => e !== entry);
      };
    } catch {
      // ignore decode errors
    }
  }
}

export function scoreTranscript(
  transcript: TranscriptEntry[],
  style: SocialStyle,
  agentKeywords: string[],
): { tier: "green" | "amber" | "red"; hits: string[]; userTurns: number } {
  const userText = transcript
    .filter((t) => t.role === "user" && t.done)
    .map((t) => t.text.toLowerCase())
    .join(" ");
  const userTurns = transcript.filter((t) => t.role === "user" && t.done && t.text.trim().length > 0).length;
  const hits = Array.from(new Set(agentKeywords.filter((k) => userText.includes(k.toLowerCase()))));
  // Tier rules
  let tier: "green" | "amber" | "red";
  if (userTurns < 2) {
    tier = "red";
  } else if (hits.length >= 3 && userTurns >= 3) {
    tier = "green";
  } else if (hits.length >= 1) {
    tier = "amber";
  } else {
    tier = "red";
  }
  // referenced to silence "unused" lint warnings in some checks
  void style;
  return { tier, hits, userTurns };
}
