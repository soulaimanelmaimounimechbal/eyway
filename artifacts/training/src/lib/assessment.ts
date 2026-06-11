// Client for the LLM evaluation engine (/api/evaluate). On any failure the
// caller falls back to the deterministic scorer, so this module never throws —
// it returns null and lets the UI degrade gracefully.
import { isScorableUserTurn, type TranscriptEntry } from "./voice-client";

const ENDPOINT = `${import.meta.env.BASE_URL}api/evaluate`;
const REQUEST_TIMEOUT_MS = 30_000;

export type Tier = "green" | "amber" | "red";
export type TurnSignal = "green" | "amber" | "grey";

export interface AiTurnEval {
  signal: TurnSignal;
  reason: string;
  quote?: string;
}

export interface AiSuggestion {
  text: string;
  quotedLine?: string;
}

export interface AiAssessment {
  tier: Tier;
  overall: string;
  strengths: string[];
  suggestions: AiSuggestion[];
  turns: AiTurnEval[];
}

const TIERS = new Set<Tier>(["green", "amber", "red"]);
const SIGNALS = new Set<TurnSignal>(["green", "amber", "grey"]);

function isValid(a: unknown): a is AiAssessment {
  if (!a || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  if (typeof o.tier !== "string" || !TIERS.has(o.tier as Tier)) return false;
  if (typeof o.overall !== "string") return false;
  if (!Array.isArray(o.strengths) || !Array.isArray(o.suggestions) || !Array.isArray(o.turns)) {
    return false;
  }
  return o.turns.every(
    (t) => t && typeof t === "object" && SIGNALS.has((t as Record<string, unknown>).signal as TurnSignal),
  );
}

/**
 * Ask the server's LLM evaluation engine to assess a completed call. Returns
 * null on any failure (network, non-2xx, malformed response) so the caller can
 * fall back to the deterministic scorer.
 */
export async function evaluateConversation(input: {
  style: string;
  intensity: string;
  transcript: TranscriptEntry[];
}): Promise<AiAssessment | null> {
  const userTurns = input.transcript.filter(isScorableUserTurn).map((t) => t.text);
  if (userTurns.length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        style: input.style,
        intensity: input.intensity,
        transcript: input.transcript.map((t) => ({ role: t.role, text: t.text })),
        userTurns,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { assessment?: unknown };
    return isValid(data.assessment) ? data.assessment : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
