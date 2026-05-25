import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { Express, Request, Response } from "express";
import { VoiceLiveClient, type VoiceLiveSession, type VoiceLiveSubscription } from "@azure/ai-voicelive";
import { AzureKeyCredential } from "@azure/core-auth";
import { logger } from "./lib/logger";

const VOICE_LIVE_PATH = "/api/voice-live";
const VOICE_TOKEN_PATH = "/api/voice-live/token";
const DEFAULT_MODEL = "gpt-realtime";
const DEFAULT_VOICE = "en-US-Ava:DragonHDLatestNeural";
const TOKEN_TTL_MS = 60_000;
const START_TIMEOUT_MS = 8_000;
const MAX_INSTR_LEN = 8_000;
const MAX_GREETING_LEN = 1_000;

function getSecret(): string {
  const k = process.env["AZURE_VOICE_LIVE_API_KEY"];
  if (!k) throw new Error("AZURE_VOICE_LIVE_API_KEY not configured");
  return k;
}

function getEndpoint(): string {
  const e = process.env["AZURE_VOICE_LIVE_ENDPOINT"];
  if (!e) throw new Error("AZURE_VOICE_LIVE_ENDPOINT is not configured");
  let url = e.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url) && !/^wss?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function signToken(nonce: string, exp: number, secret: string): string {
  return createHmac("sha256", secret).update(`${nonce}.${exp}`).digest("hex");
}

function mintToken(): { token: string; expiresAt: number } {
  const secret = getSecret();
  const nonce = randomBytes(16).toString("hex");
  const exp = Date.now() + TOKEN_TTL_MS;
  const sig = signToken(nonce, exp, secret);
  return { token: `${nonce}.${exp}.${sig}`, expiresAt: exp };
}

const usedNonces = new Map<string, number>();
function cleanupNonces() {
  const now = Date.now();
  for (const [n, exp] of usedNonces) if (exp < now) usedNonces.delete(n);
}

function verifyToken(token: string | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  let secret: string;
  try { secret = getSecret(); } catch { return false; }
  const expected = signToken(nonce, exp, secret);
  if (expected.length !== sig.length) return false;
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) return false;
  cleanupNonces();
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, exp);
  return true;
}

function isSameOrigin(req: IncomingMessage | Request): boolean {
  const origin = (req.headers as Record<string, string | undefined>).origin;
  const host = (req.headers as Record<string, string | undefined>).host;
  if (!origin || !host) return false;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    return u.host === host;
  } catch { return false; }
}

function sanitizeCloseCode(code: number): number {
  if (code === 1005 || code === 1006 || code === 1015 || code === 1004) return 1011;
  if (code >= 1000 && code <= 1015) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

function safeClose(ws: WsWebSocket, code: number, reason: string) {
  try { ws.close(sanitizeCloseCode(code), reason.slice(0, 120)); }
  catch (err) {
    try { ws.terminate(); } catch { /* noop */ }
    logger.warn({ err: (err as Error).message }, "close failed; terminated");
  }
}

function sendJson(ws: WsWebSocket, obj: unknown): void {
  if (ws.readyState !== WsWebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); }
  catch (err) { logger.warn({ err: (err as Error).message }, "client send failed"); }
}

interface StartMsg {
  type: "start";
  instructions: string;
  voice: string;
  greeting: string;
}

function parseStartMessage(raw: unknown): StartMsg | null {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof Buffer) text = raw.toString("utf-8");
  else return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j["type"] !== "start") return null;
    const instructions = typeof j["instructions"] === "string" ? (j["instructions"] as string) : "";
    const voice = typeof j["voice"] === "string" ? (j["voice"] as string) : DEFAULT_VOICE;
    const greeting = typeof j["greeting"] === "string" ? (j["greeting"] as string) : "";
    if (!instructions || !greeting) return null;
    return {
      type: "start",
      instructions: instructions.slice(0, MAX_INSTR_LEN),
      voice: voice.slice(0, 200),
      greeting: greeting.slice(0, MAX_GREETING_LEN),
    };
  } catch { return null; }
}

export function registerVoiceLiveTokenRoute(app: Express): void {
  app.post(VOICE_TOKEN_PATH, (req: Request, res: Response) => {
    if (!isSameOrigin(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    try {
      const t = mintToken();
      res.json(t);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "token mint failed");
      res.status(500).json({ error: "token unavailable" });
    }
  });
}

export function attachVoiceLiveProxy(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let pathname: string | null = null;
    let token: string | null = null;
    try {
      if (req.url) {
        const u = new URL(req.url, "http://localhost");
        pathname = u.pathname;
        token = u.searchParams.get("token");
      }
    } catch { /* fallthrough */ }

    if (pathname !== VOICE_LIVE_PATH) return;

    if (!isSameOrigin(req)) {
      logger.warn({ origin: req.headers.origin, host: req.headers.host }, "voice-live: rejected origin");
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyToken(token)) {
      logger.warn("voice-live: rejected token");
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => { void handleClient(client); });
  });

  logger.info({ path: VOICE_LIVE_PATH }, "Voice Live WS proxy attached (SDK mode)");
}

async function handleClient(client: WsWebSocket): Promise<void> {
  let endpoint: string;
  let apiKey: string;
  try { endpoint = getEndpoint(); apiKey = getSecret(); }
  catch (err) {
    logger.error({ err: (err as Error).message }, "voice-live: server not configured");
    safeClose(client, 1011, "server not configured");
    return;
  }

  // Wait for the client to send the "start" message with persona config.
  let start: StartMsg | null = null;
  try {
    start = await new Promise<StartMsg | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), START_TIMEOUT_MS);
      const onMsg = (data: unknown) => {
        const parsed = parseStartMessage(data);
        if (parsed) {
          clearTimeout(timer);
          client.off("message", onMsg);
          resolve(parsed);
        }
      };
      client.on("message", onMsg);
    });
  } catch { /* noop */ }

  if (!start) {
    safeClose(client, 4400, "missing start configuration");
    return;
  }

  const model = process.env["AZURE_VOICE_LIVE_MODEL"] ?? DEFAULT_MODEL;
  const sdkClient = new VoiceLiveClient(endpoint, new AzureKeyCredential(apiKey));
  const session: VoiceLiveSession = sdkClient.createSession({ model });

  let subscription: VoiceLiveSubscription | null = null;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (subscription) { try { await subscription.close(); } catch { /* noop */ } subscription = null; }
    try { await session.disconnect(); } catch { /* noop */ }
    try { await session.dispose(); } catch { /* noop */ }
  };

  subscription = session.subscribe({
    onSessionUpdated: async () => {
      sendJson(client, { type: "ready" });
    },
    onResponseAudioDelta: async (event) => {
      if (event.delta) sendJson(client, { type: "audio_delta", delta: event.delta });
    },
    onConversationItemInputAudioTranscriptionCompleted: async (event) => {
      sendJson(client, { type: "user_transcript", text: event.transcript ?? "" });
    },
    onResponseAudioTranscriptDone: async (event) => {
      sendJson(client, { type: "assistant_transcript", text: event.transcript ?? "" });
    },
    onInputAudioBufferSpeechStarted: async () => {
      sendJson(client, { type: "speech_started" });
      try { await session.sendEvent({ type: "response.cancel" }); } catch { /* may have no active response */ }
    },
    onResponseCreated: async () => { sendJson(client, { type: "assistant_speaking", value: true }); },
    onResponseDone: async () => { sendJson(client, { type: "assistant_speaking", value: false }); },
    onServerError: async (event) => {
      const msg = event.error?.message ?? "voice service error";
      logger.warn({ msg }, "voice-live: upstream error");
      sendJson(client, { type: "error", message: msg });
    },
  });

  try {
    await session.connect();
    await session.updateSession({
      model,
      modalities: ["text", "audio"],
      instructions: start.instructions,
      voice: { type: "azure-standard", name: start.voice },
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
      turnDetection: {
        type: "server_vad",
        threshold: 0.5,
        prefixPaddingInMs: 300,
        silenceDurationInMs: 500,
      },
      inputAudioEchoCancellation: { type: "server_echo_cancellation" },
      inputAudioNoiseReduction: { type: "azure_deep_noise_suppression" },
      inputAudioTranscription: { model: "azure-speech" },
    });

    // Pre-generated greeting as assistant turn (deterministic; speaks the persona's opening line).
    await session.sendEvent({
      type: "response.create",
      response: {
        preGeneratedAssistantMessage: {
          content: [{ type: "text", text: start.greeting }],
        },
      },
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "voice-live: session init failed");
    sendJson(client, { type: "error", message: "session init failed" });
    await cleanup();
    safeClose(client, 1011, "session init failed");
    return;
  }

  // From this point: any binary message from the client is mic PCM16 audio.
  client.on("message", (data) => {
    if (!session.isConnected) return;
    if (data instanceof Buffer) {
      const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      session.sendAudio(u8).catch((err: Error) => {
        logger.debug({ err: err.message }, "sendAudio failed");
      });
    }
    // Ignore stray JSON after start; we drive everything from server VAD.
  });

  client.on("close", () => { void cleanup(); });
  client.on("error", (err) => {
    logger.warn({ err: err.message }, "voice-live: client ws error");
    void cleanup();
  });
}
