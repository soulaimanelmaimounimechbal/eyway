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
const VOICE_TELEMETRY_PATH = "/api/voice-live/telemetry";
const VOICE_HEALTH_PATH = "/api/voice-live/health";
const VOICE_SMOKE_PATH = "/api/voice-live/smoke";
const DEFAULT_MODEL = "gpt-4o-realtime-preview";
const DEFAULT_API_VERSION = "2025-05-01-preview";
const DEFAULT_VOICE = "en-US-Ava:DragonHDLatestNeural";
const TOKEN_TTL_MS = 60_000;
const START_TIMEOUT_MS = 8_000;
const MAX_INSTR_LEN = 8_000;
const MAX_GREETING_LEN = 1_000;
const PROBE_TIMEOUT_MS = 8_000;

// Mirror of artifacts/training/src/lib/agents.ts — only the voice IDs we
// need for /smoke. Kept tiny and explicit so an env change can be verified
// per-persona in one click without reaching across packages.
const SHARED_FALLBACK_VOICES = [
  "en-US-Ava:DragonHDLatestNeural",
  "en-US-Andrew:DragonHDLatestNeural",
  "en-US-Jenny:DragonHDLatestNeural",
];
const SMOKE_PERSONAS: { id: string; voice: string; fallbackVoices: string[] }[] = [
  {
    id: "analytical",
    voice: "en-US-Andrew:DragonHDLatestNeural",
    fallbackVoices: SHARED_FALLBACK_VOICES.filter((v) => v !== "en-US-Andrew:DragonHDLatestNeural"),
  },
  {
    id: "driving",
    voice: "en-US-Brian:DragonHDLatestNeural",
    fallbackVoices: SHARED_FALLBACK_VOICES.filter((v) => v !== "en-US-Brian:DragonHDLatestNeural"),
  },
  {
    id: "expressive",
    voice: "en-US-Ava:DragonHDLatestNeural",
    fallbackVoices: SHARED_FALLBACK_VOICES.filter((v) => v !== "en-US-Ava:DragonHDLatestNeural"),
  },
  {
    id: "amiable",
    voice: "en-US-Emma:DragonHDLatestNeural",
    fallbackVoices: SHARED_FALLBACK_VOICES,
  },
];

const ALLOWED_TELEMETRY_EVENTS = new Set([
  "preflight_started",
  "preflight_passed",
  "preflight_failed",
  "call_started",
  "first_audio_ms",
  "voice_fallback",
  "reconnect_attempted",
  "reconnect_succeeded",
  "call_ended",
  "mic_engaged",
  "mic_released",
  "error",
]);
const MAX_TELEMETRY_BODY_BYTES = 4_096;

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

const HEX_RE = /^[0-9a-f]+$/i;

function verifyToken(token: string | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, sig] = parts;
  if (!HEX_RE.test(nonce) || !HEX_RE.test(sig)) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  let secret: string;
  try { secret = getSecret(); } catch { return false; }
  const expected = signToken(nonce, exp, secret);
  if (expected.length !== sig.length) return false;
  let expectedBuf: Buffer;
  let sigBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, "hex");
    sigBuf = Buffer.from(sig, "hex");
  } catch { return false; }
  if (expectedBuf.length !== sigBuf.length || expectedBuf.length === 0) return false;
  try { if (!timingSafeEqual(expectedBuf, sigBuf)) return false; }
  catch { return false; }
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

type Intensity = "subtle" | "standard" | "extreme";

// Server-side mirror of artifacts/training/src/lib/agents.ts INTENSITY_MODIFIERS.
// Kept here (rather than imported across packages) so the API server owns the
// final prompt seen by Azure and the client cannot inject arbitrary suffix text.
const INTENSITY_MODIFIERS: Record<Intensity, string> = {
  subtle:
    "\n\nIntensity: SUBTLE. Keep reactions restrained and professional. Do not interrupt. Stay patient even when answers are vague. Express frustration or concern briefly and only when clearly warranted. Stay in character, but dial the emotion down.",
  standard: "",
  extreme:
    "\n\nIntensity: EXTREME. Amplify your in-character reactions. Be visibly impatient, emotional, or insistent depending on your style. React strongly and immediately when answers are off-style, vague, or evasive. Stay in character, but make the trait unmistakable.",
};

interface StartMsg {
  type: "start";
  instructions: string;
  intensity: Intensity;
  voice: string;
  fallbackVoices: string[];
  greeting: string;
  probe: boolean;
  resume: boolean;
}

function parseStartMessage(raw: unknown): StartMsg | null {
  let text: string;
  if (typeof raw === "string") text = raw;
  else if (raw instanceof Buffer) text = raw.toString("utf-8");
  else return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (j["type"] !== "start") return null;
    const probe = j["probe"] === true;
    const resume = j["resume"] === true;
    const instructions = typeof j["instructions"] === "string" ? (j["instructions"] as string) : "";
    const voice = typeof j["voice"] === "string" ? (j["voice"] as string) : DEFAULT_VOICE;
    const greeting = typeof j["greeting"] === "string" ? (j["greeting"] as string) : "";
    const intensityRaw = j["intensity"];
    const intensity: Intensity =
      intensityRaw === "subtle" || intensityRaw === "extreme" ? intensityRaw : "standard";
    const fbRaw = Array.isArray(j["fallbackVoices"]) ? (j["fallbackVoices"] as unknown[]) : [];
    const fallbackVoices = fbRaw
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .slice(0, 6)
      .map((v) => v.slice(0, 200));
    if (!probe && (!instructions || !greeting)) return null;
    return {
      type: "start",
      instructions: instructions.slice(0, MAX_INSTR_LEN),
      intensity,
      voice: voice.slice(0, 200),
      fallbackVoices,
      greeting: greeting.slice(0, MAX_GREETING_LEN),
      probe,
      resume,
    };
  } catch { return null; }
}

type UpstreamErrorKind = "benign" | "transient" | "config" | "fatal";

function classifyUpstreamError(code: string, msg: string): UpstreamErrorKind {
  const c = code.toLowerCase();
  const m = msg.toLowerCase();
  if (c === "response_cancel_not_active" || /no active response/.test(m)) return "benign";
  // Race: the previous response is still closing on Azure's side when the
  // user releases PTT. The pre-emptive response.cancel below resolves it
  // 99% of the time; treat any leak-through as benign so the call survives.
  if (c === "conversation_already_has_active_response" || /already has an active response/.test(m)) return "benign";
  // Belt-and-braces: our client gate filters tiny buffers, but if anything
  // slips through (mid-flight reconnect, etc.), don't tear the call down.
  if (c === "input_audio_buffer_commit_empty" || /buffer too small|commit_empty/.test(m)) return "benign";
  if (
    /invalid_voice|voice_not_found|model_not_found|deployment_not_found/.test(c) ||
    /invalid.*(voice|model)|(voice|model).*(not\s*found|not\s*available|invalid)/.test(m)
  ) return "config";
  if (
    /rate.?limit|timeout|server_error|temporarily|unavailable|5\d\d/.test(c) ||
    /rate.?limit|timeout|temporarily|try again|unavailable/.test(m)
  ) return "transient";
  return "fatal";
}

function isInvalidVoiceError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /invalid.*voice|voice.*(invalid|not\s*found|not\s*available|unsupported)/.test(m);
}

function effectiveConfig(): { endpointHost: string; model: string; apiVersion: string } {
  let endpointHost = "unknown";
  try {
    const ep = getEndpoint();
    endpointHost = new URL(ep).host;
  } catch { /* leave as unknown */ }
  return {
    endpointHost,
    model: process.env["AZURE_VOICE_LIVE_MODEL"] ?? DEFAULT_MODEL,
    apiVersion: process.env["AZURE_VOICE_LIVE_API_VERSION"] ?? DEFAULT_API_VERSION,
  };
}

interface ProbeOutcome {
  ok: boolean;
  voice?: string;
  kind?: UpstreamErrorKind | "config" | "transient" | "fatal";
  message?: string;
  elapsedMs: number;
}

/**
 * Lightweight upstream probe: opens a Voice Live session, applies the
 * requested voice (with the same fallback ladder as the live flow), and
 * closes cleanly. Used by both /health (one-shot) and /smoke (per-persona).
 * Never speaks; configures probe-only instructions.
 */
async function probeVoice(voice: string, fallbackVoices: string[] = []): Promise<ProbeOutcome> {
  const started = Date.now();
  let endpoint: string;
  let apiKey: string;
  try { endpoint = getEndpoint(); apiKey = getSecret(); }
  catch (err) {
    return { ok: false, kind: "config", message: (err as Error).message, elapsedMs: Date.now() - started };
  }
  const model = process.env["AZURE_VOICE_LIVE_MODEL"] ?? DEFAULT_MODEL;
  const apiVersion = process.env["AZURE_VOICE_LIVE_API_VERSION"] ?? DEFAULT_API_VERSION;
  const sdkClient = new VoiceLiveClient(endpoint, new AzureKeyCredential(apiKey), { apiVersion });
  const session: VoiceLiveSession = sdkClient.createSession({ model });
  const cleanup = async () => {
    try { await session.disconnect(); } catch { /* noop */ }
    try { await session.dispose(); } catch { /* noop */ }
  };

  const ladder = [voice, ...fallbackVoices.filter((v) => v !== voice)];
  try {
    const connectPromise = session.connect();
    const timer = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS),
    );
    await Promise.race([connectPromise, timer]);

    let lastErr: unknown = null;
    for (const candidate of ladder) {
      try {
        await session.updateSession({
          model,
          modalities: ["text", "audio"],
          instructions: "You are a connection probe. Do not speak.",
          voice: { type: "azure-standard", name: candidate },
          inputAudioFormat: "pcm16",
          outputAudioFormat: "pcm16",
        });
        await cleanup();
        return { ok: true, voice: candidate, elapsedMs: Date.now() - started };
      } catch (err) {
        lastErr = err;
        if (!isInvalidVoiceError(err)) {
          await cleanup();
          const m = (err as Error).message ?? "probe failed";
          return { ok: false, kind: classifyUpstreamError("", m), message: m.slice(0, 300), elapsedMs: Date.now() - started };
        }
      }
    }
    await cleanup();
    const m = lastErr instanceof Error ? lastErr.message : "no usable voice";
    return { ok: false, kind: "config", message: m.slice(0, 300), elapsedMs: Date.now() - started };
  } catch (err) {
    await cleanup();
    const m = (err as Error).message ?? "probe failed";
    return { ok: false, kind: classifyUpstreamError("", m), message: m.slice(0, 300), elapsedMs: Date.now() - started };
  }
}

function debugAllowed(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const expected = process.env["VOICE_LIVE_DEBUG_TOKEN"];
  if (!expected) return false;
  const provided = (req.headers["x-debug-token"] as string | undefined) ?? "";
  if (provided.length === 0 || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch { return false; }
}

export function registerVoiceLiveTelemetryRoute(app: Express): void {
  app.post(VOICE_TELEMETRY_PATH, (req: Request, res: Response) => {
    // Telemetry comes from our own frontend only. Same origin enforcement
    // mirrors the token route.
    if (!isSameOrigin(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const body = req.body as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    const raw = body as Record<string, unknown>;
    const event = typeof raw["event"] === "string" ? raw["event"] : "";
    if (!ALLOWED_TELEMETRY_EVENTS.has(event)) {
      res.status(400).json({ error: "unknown event" });
      return;
    }
    let serialized: string;
    try { serialized = JSON.stringify(raw); }
    catch { res.status(400).json({ error: "invalid body" }); return; }
    if (serialized.length > MAX_TELEMETRY_BODY_BYTES) {
      res.status(413).json({ error: "payload too large" });
      return;
    }
    // Allow-list which fields we forward into the log to avoid logging
    // anything unexpected from the client.
    const safe: Record<string, unknown> = { telemetry: true, event };
    for (const key of ["sessionId", "buildHash", "ts"]) {
      const v = raw[key];
      if (typeof v === "string" || typeof v === "number") safe[key] = v;
    }
    for (const [k, v] of Object.entries(raw)) {
      if (k === "event" || k in safe) continue;
      if (typeof v === "string") safe[k] = v.slice(0, 200);
      else if (typeof v === "number" || typeof v === "boolean") safe[k] = v;
    }
    logger.info(safe, "telemetry");
    res.status(204).end();
  });
}

export function registerVoiceLiveHealthRoute(app: Express): void {
  app.get(VOICE_HEALTH_PATH, async (_req: Request, res: Response) => {
    const cfg = effectiveConfig();
    const checks: { name: string; ok: boolean; detail?: string; elapsedMs?: number }[] = [];

    // 1. Token mint (uses the same secret + signer as the live flow).
    let tokenOk = false;
    try { mintToken(); tokenOk = true; } catch (err) {
      checks.push({ name: "token", ok: false, detail: (err as Error).message });
    }
    if (tokenOk) checks.push({ name: "token", ok: true });

    // 2. One-shot upstream probe with the default voice. Confirms endpoint
    //    reachability and credentials end-to-end.
    const probe = await probeVoice(DEFAULT_VOICE);
    checks.push({
      name: "upstream_probe",
      ok: probe.ok,
      detail: probe.ok ? probe.voice : `${probe.kind ?? "fail"}: ${probe.message ?? ""}`.slice(0, 300),
      elapsedMs: probe.elapsedMs,
    });

    const ok = checks.every((c) => c.ok);
    res.status(ok ? 200 : 503).json({ ok, config: cfg, checks });
  });
}

export function registerVoiceLiveSmokeRoute(app: Express): void {
  app.get(VOICE_SMOKE_PATH, async (req: Request, res: Response) => {
    if (!debugAllowed(req)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const cfg = effectiveConfig();
    const results: { persona: string; ok: boolean; voice?: string; kind?: string; message?: string; elapsedMs: number }[] = [];
    // Run sequentially — the upstream rate-limits per-key and parallel
    // probes can cause spurious "transient" failures.
    for (const p of SMOKE_PERSONAS) {
      const out = await probeVoice(p.voice, p.fallbackVoices);
      results.push({
        persona: p.id,
        ok: out.ok,
        voice: out.voice,
        kind: out.kind,
        message: out.message,
        elapsedMs: out.elapsedMs,
      });
    }
    const ok = results.every((r) => r.ok);
    res.status(ok ? 200 : 503).json({ ok, config: cfg, results });
  });
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
  const apiVersion = process.env["AZURE_VOICE_LIVE_API_VERSION"] ?? DEFAULT_API_VERSION;
  const sdkClient = new VoiceLiveClient(endpoint, new AzureKeyCredential(apiKey), { apiVersion });
  const session: VoiceLiveSession = sdkClient.createSession({ model });

  let subscription: VoiceLiveSubscription | null = null;
  let closed = false;
  let responseInFlight = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (subscription) { try { await subscription.close(); } catch { /* noop */ } subscription = null; }
    try { await session.disconnect(); } catch { /* noop */ }
    try { await session.dispose(); } catch { /* noop */ }
  };

  let readySent = false;
  subscription = session.subscribe({
    onSessionUpdated: async () => {
      if (readySent) return;
      readySent = true;
      sendJson(client, { type: "ready" });
    },
    onResponseAudioDelta: async (event) => {
      const d = event.delta as Uint8Array | string | undefined;
      if (!d) return;
      let b64: string;
      if (typeof d === "string") {
        b64 = d;
      } else if (d instanceof Uint8Array) {
        if (d.byteLength === 0) return;
        b64 = Buffer.from(d).toString("base64");
      } else {
        return;
      }
      sendJson(client, { type: "audio_delta", delta: b64 });
    },
    onConversationItemInputAudioTranscriptionCompleted: async (event) => {
      sendJson(client, { type: "user_transcript", text: event.transcript ?? "" });
    },
    onResponseAudioTranscriptDone: async (event) => {
      sendJson(client, { type: "assistant_transcript", text: event.transcript ?? "" });
    },
    onInputAudioBufferSpeechStarted: async () => {
      sendJson(client, { type: "speech_started" });
      if (responseInFlight) {
        responseInFlight = false;
        try { await session.sendEvent({ type: "response.cancel" }); } catch { /* noop */ }
      }
    },
    onResponseCreated: async () => {
      responseInFlight = true;
      sendJson(client, { type: "assistant_speaking", value: true });
    },
    onResponseDone: async () => {
      responseInFlight = false;
      sendJson(client, { type: "assistant_speaking", value: false });
    },
    onServerError: async (event) => {
      const code = event.error?.code ?? "";
      const msg = event.error?.message ?? "voice service error";
      const kind = classifyUpstreamError(code, msg);
      const safeMsg = msg.slice(0, 300);
      switch (kind) {
        case "benign":
          logger.debug({ code, msg }, "voice-live: benign upstream error suppressed");
          return;
        case "transient":
          logger.warn({ code, msg }, "voice-live: transient upstream error");
          sendJson(client, { type: "warning", kind: "transient", message: safeMsg });
          return;
        case "config":
          logger.warn({ code, msg }, "voice-live: config upstream error");
          sendJson(client, { type: "error", kind: "config", message: safeMsg });
          return;
        default:
          logger.warn({ code, msg }, "voice-live: upstream error");
          sendJson(client, { type: "error", kind: "fatal", message: safeMsg });
      }
    },
    onDisconnected: async (args) => {
      const reason = (args as { reason?: string } | undefined)?.reason;
      const msg = reason && reason.length > 0 ? `upstream disconnected: ${reason}` : "upstream disconnected";
      logger.warn({ reason }, "voice-live: upstream disconnected");
      // Tagged as lost_connection so the client can decide between reconnect
      // and remediation copy without inferring from a generic error string.
      sendJson(client, { type: "error", kind: "lost_connection", message: msg.slice(0, 300) });
      await cleanup();
      safeClose(client, 1011, "upstream disconnected");
    },
  });

  const probeInstructions = "You are a connection probe. Do not speak.";
  // Append the intensity modifier so the same four personas can be dialled
  // up or down without separate prompt files. Standard is an empty suffix.
  const personaInstructions = `${start.instructions}${INTENSITY_MODIFIERS[start.intensity]}`;
  const voiceLadder = [start.voice, ...start.fallbackVoices.filter((v) => v !== start.voice)];
  let chosenVoice = "";
  try {
    await session.connect();

    let lastErr: unknown = null;
    for (const candidate of voiceLadder) {
      try {
        await session.updateSession({
          model,
          modalities: ["text", "audio"],
          instructions: start.probe ? probeInstructions : personaInstructions,
          voice: { type: "azure-standard", name: candidate },
          inputAudioFormat: "pcm16",
          outputAudioFormat: "pcm16",
          // Server VAD disabled — client drives turn boundaries via
          // push-to-talk. The model only generates a response when the
          // client sends an explicit input_audio_buffer.commit +
          // response.create pair (see the JSON "commit" branch below).
          inputAudioEchoCancellation: { type: "server_echo_cancellation" },
          inputAudioNoiseReduction: { type: "azure_deep_noise_suppression" },
          inputAudioTranscription: { model: "azure-speech" },
        });
        // Belt-and-braces: the SDK has no first-class "disable VAD" so we
        // patch the raw session afterwards. Azure's realtime contract is
        // `turn_detection: null` to disable; sending it explicitly avoids
        // any server-side default kicking back in.
        try {
          await session.sendEvent({
            type: "session.update",
            session: { turn_detection: null },
          } as unknown as Parameters<typeof session.sendEvent>[0]);
        } catch (err) {
          logger.warn({ err: (err as Error).message }, "voice-live: failed to disable server VAD");
        }
        chosenVoice = candidate;
        if (candidate !== start.voice) {
          logger.warn({ requested: start.voice, used: candidate }, "voice-live: voice fallback used");
          sendJson(client, { type: "warning", kind: "voice_fallback", message: `voice fell back to ${candidate}` });
        } else {
          logger.info({ voice: candidate, probe: start.probe }, "voice-live: session ready");
        }
        break;
      } catch (err) {
        lastErr = err;
        if (!isInvalidVoiceError(err)) throw err;
        logger.warn({ voice: candidate, err: (err as Error).message }, "voice-live: voice invalid, trying next");
      }
    }

    if (!chosenVoice) {
      throw lastErr instanceof Error ? lastErr : new Error("no usable voice");
    }

    if (start.probe) {
      // Probe mode: confirm session is ready, then close cleanly without speaking.
      if (!readySent) {
        readySent = true;
        sendJson(client, { type: "ready" });
      }
      sendJson(client, { type: "probe_ok", voice: chosenVoice });
      await cleanup();
      safeClose(client, 1000, "probe complete");
      return;
    }

    // Pre-generated greeting as assistant turn (deterministic; speaks the persona's opening line).
    // Skipped on resume so a reconnect doesn't replay the opener.
    if (!start.resume) {
      await session.sendEvent({
        type: "response.create",
        response: {
          preGeneratedAssistantMessage: {
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: start.greeting }],
          },
        },
      });
    }
  } catch (err) {
    const detail = (err as Error).message || "session init failed";
    const kind = isInvalidVoiceError(err) ? "config" : classifyUpstreamError("", detail);
    logger.error({ err: detail, kind }, "voice-live: session init failed");
    sendJson(client, {
      type: "error",
      kind: kind === "transient" ? "transient" : kind === "config" ? "config" : "fatal",
      message: `session init failed: ${detail}`.slice(0, 300),
    });
    await cleanup();
    safeClose(client, 1011, "session init failed");
    return;
  }

  // From this point: binary frames from the client are mic PCM16 audio;
  // text frames are turn-control signals from the push-to-talk UI
  // ({"type":"commit"} on mic release, {"type":"clear"} to drop a buffer).
  client.on("message", (data, isBinary) => {
    if (!session.isConnected) return;
    if (!isBinary) {
      try {
        const text = data instanceof Buffer ? data.toString("utf-8") : String(data);
        const msg = JSON.parse(text) as { type?: string };
        if (msg.type === "commit") {
          // Drop commits while a response is already being generated — a
          // double-tap on the PTT button (or a Space-up racing a click)
          // would otherwise fire two response.create events for one turn.
          if (responseInFlight) {
            logger.debug("commit ignored: response already in flight");
            return;
          }
          responseInFlight = true;
          void (async () => {
            try {
              // Pre-emptive cancel: Azure's response lifecycle can lag
              // behind our local `onResponseDone` (particularly for the
              // pre-generated greeting), so a brand-new response.create
              // would race "conversation_already_has_active_response"
              // and tear the call down. response.cancel is a no-op when
              // nothing is active (classified benign upstream).
              try { await session.sendEvent({ type: "response.cancel" }); } catch { /* noop */ }
              await session.sendEvent({ type: "input_audio_buffer.commit" });
              await session.sendEvent({ type: "response.create" });
            } catch (err) {
              responseInFlight = false;
              logger.debug({ err: (err as Error).message }, "commit failed");
            }
          })();
        } else if (msg.type === "clear") {
          void session.sendEvent({ type: "input_audio_buffer.clear" }).catch(() => {});
        }
      } catch { /* ignore unparseable control frames */ }
      return;
    }
    if (data instanceof Buffer) {
      const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      session.sendAudio(u8).catch((err: Error) => {
        logger.debug({ err: err.message }, "sendAudio failed");
      });
    }
  });

  client.on("close", () => { void cleanup(); });
  client.on("error", (err) => {
    logger.warn({ err: err.message }, "voice-live: client ws error");
    void cleanup();
  });
}
