import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { Express, Request, Response } from "express";
import { logger } from "./lib/logger";

const VOICE_LIVE_PATH = "/api/voice-live";
const VOICE_TOKEN_PATH = "/api/voice-live/token";
const DEFAULT_API_VERSION = "2025-05-01-preview";
const DEFAULT_MODEL = "gpt-4o-realtime-preview";
const MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const AZURE_CONNECT_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS = 60_000;

function getSecret(): string {
  const k = process.env["AZURE_VOICE_LIVE_API_KEY"];
  if (!k) throw new Error("AZURE_VOICE_LIVE_API_KEY not configured");
  return k;
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

function buildAzureWsUrl(): string {
  const endpoint = process.env["AZURE_VOICE_LIVE_ENDPOINT"];
  if (!endpoint) throw new Error("AZURE_VOICE_LIVE_ENDPOINT is not configured");
  let host = endpoint.trim();
  host = host.replace(/^https?:\/\//i, "").replace(/^wss?:\/\//i, "").replace(/\/+$/, "");
  const apiVersion = process.env["AZURE_VOICE_LIVE_API_VERSION"] ?? DEFAULT_API_VERSION;
  const model = process.env["AZURE_VOICE_LIVE_MODEL"] ?? DEFAULT_MODEL;
  return `wss://${host}/voice-live/realtime?api-version=${encodeURIComponent(apiVersion)}&model=${encodeURIComponent(model)}`;
}

function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    const u = new URL(origin);
    // Allow localhost in dev
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

export function registerVoiceLiveTokenRoute(app: Express): void {
  app.post(VOICE_TOKEN_PATH, (req: Request, res: Response) => {
    // Origin check: same-origin or localhost
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

    wss.handleUpgrade(req, socket, head, (client) => handleClient(client));
  });

  logger.info({ path: VOICE_LIVE_PATH }, "Voice Live WS proxy attached");
}

function handleClient(client: WsWebSocket): void {
  const apiKey = process.env["AZURE_VOICE_LIVE_API_KEY"];
  if (!apiKey) { logger.error("AZURE_VOICE_LIVE_API_KEY missing"); safeClose(client, 1011, "server not configured"); return; }

  let azureUrl: string;
  try { azureUrl = buildAzureWsUrl(); }
  catch (err) { logger.error({ err }, "Failed to build Azure URL"); safeClose(client, 1011, "server not configured"); return; }

  logger.info("Opening Azure Voice Live WS");
  const azure = new WsWebSocket(azureUrl, { headers: { "api-key": apiKey } });

  const queued: Array<Buffer | string> = [];
  let queuedBytes = 0;
  let azureReady = false;

  const connectTimer = setTimeout(() => {
    if (!azureReady) {
      logger.error("Azure WS connect timeout");
      try { azure.terminate(); } catch { /* noop */ }
      safeClose(client, 1011, "upstream connect timeout");
    }
  }, AZURE_CONNECT_TIMEOUT_MS);

  azure.on("open", () => {
    clearTimeout(connectTimer);
    azureReady = true;
    for (const msg of queued) {
      try { azure.send(msg); } catch (err) { logger.warn({ err: (err as Error).message }, "flush send failed"); }
    }
    queued.length = 0; queuedBytes = 0;
    logger.info("Azure WS open");
  });

  azure.on("message", (data) => {
    if (client.readyState === WsWebSocket.OPEN) {
      try { client.send(data as Buffer); } catch (err) { logger.warn({ err: (err as Error).message }, "client send failed"); }
    }
  });

  azure.on("close", (code, reason) => {
    clearTimeout(connectTimer);
    logger.info({ code, reason: reason.toString() }, "Azure WS closed");
    if (client.readyState === WsWebSocket.OPEN) safeClose(client, code, reason.toString());
  });

  azure.on("error", (err) => {
    logger.error({ err: err.message }, "Azure WS error");
    if (client.readyState === WsWebSocket.OPEN) safeClose(client, 1011, "azure upstream error");
  });

  client.on("message", (data) => {
    const payload = data as Buffer;
    if (azureReady && azure.readyState === WsWebSocket.OPEN) {
      try { azure.send(payload); } catch (err) { logger.warn({ err: (err as Error).message }, "azure send failed"); }
      return;
    }
    const size = Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(String(payload));
    if (queuedBytes + size > MAX_QUEUE_BYTES) {
      logger.warn({ queuedBytes, size }, "pre-open queue full; dropping client");
      safeClose(client, 1013, "upstream not ready");
      try { azure.terminate(); } catch { /* noop */ }
      return;
    }
    queued.push(payload);
    queuedBytes += size;
  });

  client.on("close", () => {
    clearTimeout(connectTimer);
    if (azure.readyState === WsWebSocket.OPEN || azure.readyState === WsWebSocket.CONNECTING) {
      try { azure.close(); } catch { /* noop */ }
    }
  });

  client.on("error", (err) => { logger.error({ err: err.message }, "Client WS error"); });
}
