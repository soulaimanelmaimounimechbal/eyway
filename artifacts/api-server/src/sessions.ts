import type { Express, Request, Response } from "express";
import { db, trainingSessionsTable } from "@workspace/db";
import { logger } from "./lib/logger";

const SESSIONS_PATH = "/api/sessions";
const MAX_BODY_BYTES = 200_000; // transcripts can be large; keep a sane ceiling
const MAX_TRANSCRIPT_ENTRIES = 500;
const ALLOWED_STYLES = new Set(["analytical", "driving", "expressive", "amiable"]);
const ALLOWED_INTENSITIES = new Set(["subtle", "standard", "extreme"]);
const ALLOWED_TIERS = new Set(["green", "amber", "red"]);
const ALLOWED_SIGNALS = new Set(["green", "amber", "grey"]);

interface StoredAssessment {
  tier: string;
  overall: string;
  strengths: string[];
  suggestions: { text: string; quotedLine?: string }[];
  turns: { signal: string; reason: string; quote?: string }[];
}

function isSameOrigin(req: Request): boolean {
  const origin = (req.headers as Record<string, string | undefined>).origin;
  const host = (req.headers as Record<string, string | undefined>).host;
  if (!origin || !host) return false;
  try {
    const u = new URL(origin);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    return u.host === host;
  } catch {
    return false;
  }
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

// Sanitize the optional AI assessment (already shaped by /api/evaluate, but it
// arrives here via the client so we clamp it again defensively). Null when
// absent or unusable — the session still saves with the deterministic tier.
function sanitizeAssessment(v: unknown): StoredAssessment | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const tier = str(o["tier"], 16);
  if (!tier || !ALLOWED_TIERS.has(tier)) return null;
  const overall = str(o["overall"], 4_000) ?? "";
  const strengths = (Array.isArray(o["strengths"]) ? (o["strengths"] as unknown[]) : [])
    .filter((s): s is string => typeof s === "string")
    .slice(0, 10)
    .map((s) => s.slice(0, 500));
  const suggestions = (Array.isArray(o["suggestions"]) ? (o["suggestions"] as unknown[]) : [])
    .slice(0, 10)
    .map((s) => {
      const so = (s ?? {}) as Record<string, unknown>;
      const text = str(so["text"], 500) ?? "";
      const quotedLine = str(so["quotedLine"], 500);
      return quotedLine ? { text, quotedLine } : { text };
    })
    .filter((s) => s.text.length > 0);
  const turns = (Array.isArray(o["turns"]) ? (o["turns"] as unknown[]) : [])
    .slice(0, 200)
    .map((t) => {
      const to = (t ?? {}) as Record<string, unknown>;
      const signal = typeof to["signal"] === "string" && ALLOWED_SIGNALS.has(to["signal"])
        ? (to["signal"] as string)
        : "grey";
      const reason = str(to["reason"], 1_000) ?? "";
      const quote = str(to["quote"], 1_000);
      return quote ? { signal, reason, quote } : { signal, reason };
    });
  return { tier, overall, strengths, suggestions, turns };
}

// Persist a completed training session for later analytics. Same-origin only,
// since this comes from our own frontend. Best-effort from the client's
// perspective, but we validate strictly here and never store unbounded input.
export function registerSessionRoute(app: Express): void {
  app.post(SESSIONS_PATH, async (req: Request, res: Response) => {
    if (!isSameOrigin(req)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = req.body as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      res.status(400).json({ error: "invalid body" });
      return;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch {
      res.status(400).json({ error: "invalid body" });
      return;
    }
    if (serialized.length > MAX_BODY_BYTES) {
      res.status(413).json({ error: "payload too large" });
      return;
    }

    const raw = body as Record<string, unknown>;

    const style = str(raw["style"], 32);
    const intensity = str(raw["intensity"], 32);
    const tier = str(raw["tier"], 16);
    const userTurns = int(raw["userTurns"]);

    if (!style || !ALLOWED_STYLES.has(style)) {
      res.status(400).json({ error: "invalid style" });
      return;
    }
    if (!intensity || !ALLOWED_INTENSITIES.has(intensity)) {
      res.status(400).json({ error: "invalid intensity" });
      return;
    }
    if (!tier || !ALLOWED_TIERS.has(tier)) {
      res.status(400).json({ error: "invalid tier" });
      return;
    }
    if (userTurns === null || userTurns < 0) {
      res.status(400).json({ error: "invalid userTurns" });
      return;
    }

    const hitsRaw = Array.isArray(raw["hits"]) ? (raw["hits"] as unknown[]) : [];
    const hits = hitsRaw
      .filter((h): h is string => typeof h === "string")
      .slice(0, 100)
      .map((h) => h.slice(0, 100));

    const transcriptRaw = Array.isArray(raw["transcript"]) ? (raw["transcript"] as unknown[]) : [];
    const transcript = transcriptRaw
      .slice(0, MAX_TRANSCRIPT_ENTRIES)
      .map((e) => {
        const entry = (e ?? {}) as Record<string, unknown>;
        const role = entry["role"] === "assistant" ? "assistant" : "user";
        return {
          role: role as "user" | "assistant",
          text: typeof entry["text"] === "string" ? (entry["text"] as string).slice(0, 8_000) : "",
          done: entry["done"] === true,
        };
      });

    const avgWordsRaw = raw["avgWords"];
    const avgWords =
      typeof avgWordsRaw === "number" && Number.isFinite(avgWordsRaw) && avgWordsRaw >= 0
        ? avgWordsRaw
        : null;
    const durationMsRaw = int(raw["durationMs"]);
    const durationMs = durationMsRaw !== null && durationMsRaw >= 0 ? durationMsRaw : null;

    try {
      const [row] = await db
        .insert(trainingSessionsTable)
        .values({
          style,
          intensity,
          selfReportedStyle: str(raw["selfReportedStyle"], 64),
          selfNote: str(raw["selfNote"], 2_000),
          tier,
          userTurns,
          avgWords,
          hits,
          durationMs,
          clientSessionId: str(raw["clientSessionId"], 128),
          transcript,
          assessment: sanitizeAssessment(raw["assessment"]),
        })
        .returning({ id: trainingSessionsTable.id });

      res.status(201).json({ id: row?.id });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "failed to persist training session");
      res.status(500).json({ error: "failed to save session" });
    }
  });
}
