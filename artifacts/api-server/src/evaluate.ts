import type { Express, Request, Response } from "express";
import { logger } from "./lib/logger";

const EVALUATE_PATH = "/api/evaluate";
const MAX_BODY_BYTES = 200_000;
const MAX_TRANSCRIPT_ENTRIES = 500;
const MAX_USER_TURNS = 200;
const ALLOWED_STYLES = new Set(["analytical", "driving", "expressive", "amiable"]);
const ALLOWED_INTENSITIES = new Set(["subtle", "standard", "extreme"]);
const ALLOWED_TIERS = new Set(["green", "amber", "red"]);
const ALLOWED_SIGNALS = new Set(["green", "amber", "grey"]);
const AZURE_TIMEOUT_MS = 25_000;

type Style = "analytical" | "driving" | "expressive" | "amiable";

interface TurnEval {
  signal: "green" | "amber" | "grey";
  reason: string;
  quote?: string;
}
interface Assessment {
  tier: "green" | "amber" | "red";
  overall: string;
  strengths: string[];
  suggestions: { text: string; quotedLine?: string }[];
  turns: TurnEval[];
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

type AzureConfig = {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion: string;
  // Azure AI Foundry resources (*.services.ai.azure.com) speak the
  // OpenAI-compatible v1 API: POST /openai/v1/chat/completions with the model
  // in the request body and no api-version query param. Classic Azure OpenAI
  // resources (*.cognitiveservices.azure.com) use the deployments path instead.
  useV1: boolean;
};

function safeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

// Resolve the Azure OpenAI chat config. Prefer a dedicated AZURE_OPENAI_*
// resource; otherwise fall back to the existing Azure Voice Live credentials so
// a single Azure resource that also hosts a chat deployment works without extra
// setup. Endpoints may be pasted as a full path (e.g. the Foundry ".../openai/
// v1/responses" URL); we always reduce them to their origin and rebuild the path.
function azureConfig(): AzureConfig | null {
  const n = process.env;
  const apiVersion = n["AZURE_OPENAI_API_VERSION"] ?? "2024-10-21";

  const dedicatedEndpoint = n["AZURE_OPENAI_ENDPOINT"];
  const dedicatedKey = n["AZURE_OPENAI_API_KEY"];
  if (dedicatedEndpoint && dedicatedKey) {
    const origin = safeOrigin(dedicatedEndpoint);
    if (!origin) return null;
    const useV1 =
      /\.services\.ai\.azure\.com$/i.test(new URL(origin).host) ||
      /\/openai\/v1\//i.test(dedicatedEndpoint);
    // Don't borrow the realtime AZURE_VOICE_LIVE_MODEL here — the dedicated chat
    // resource may not host that deployment. gpt-4o-mini is the common default.
    const deployment = n["AZURE_OPENAI_DEPLOYMENT"] ?? "gpt-4o-mini";
    return { endpoint: origin, apiKey: dedicatedKey, deployment, apiVersion, useV1 };
  }

  const endpoint = n["AZURE_VOICE_LIVE_ENDPOINT"];
  const apiKey = n["AZURE_VOICE_LIVE_API_KEY"];
  if (!endpoint || !apiKey) return null;
  const deployment = n["AZURE_VOICE_LIVE_MODEL"] ?? "gpt-4o";
  return { endpoint: endpoint.replace(/\/+$/, ""), apiKey, deployment, apiVersion, useV1: false };
}

// Per-style success criteria — what "adapting to this Social Style" looks like.
const STYLE_RUBRIC: Record<Style, string> = {
  analytical:
    "ANALYTICAL (Morgan Reeves, Head of Sustainability Strategy). Adapting well means: grounding claims in data, evidence, methodology and named sources; being precise and structured; stating assumptions; honestly acknowledging what is and isn't known. Off-style: vague generalities, hand-waving, confident claims with no specifics, emotional appeals without substance.",
  driving:
    "DRIVING (Dana Voss, COO). Adapting well means: leading with the headline and the ask; being concise and direct; offering a clear recommendation, decision, owners and timelines; closing with concrete next steps. Off-style: rambling, giving background before the point, hedging ('I think maybe we could'), no clear action.",
  expressive:
    "EXPRESSIVE (Daniel Chen, VP Brand & Communications). Adapting well means: framing things as a clear narrative or story; giving a memorable line they can repeat; tying it to people, vision and momentum; bringing energy and confidence. Off-style: dry, technical, numbers-only answers; no story or big picture; flat, low-energy delivery.",
  amiable:
    "AMIABLE (John O'Sullivan, Head of People & Culture). Adapting well means: leading with empathy; acknowledging how the team/people feel before proposing fixes; building trust and reassurance; using 'we' and partnership language. Off-style: transactional or cold tone, jumping straight to fixes, dismissing the human side.",
};

function buildSystemPrompt(style: Style, turnCount: number): string {
  return [
    "You are an expert coach assessing how well an EY consultant adapted to a stakeholder's TRACOM Social Style during a voice roleplay.",
    "The stakeholder (the 'assistant' role in the transcript) is playing a specific personality style; the consultant (the 'user' role) is being coached to flex their communication to match that style.",
    "Judge ONLY how well the consultant adapted to the target style — not their factual correctness about the scenario.",
    "",
    `Target style for this call:\n${STYLE_RUBRIC[style]}`,
    "",
    "Scoring:",
    "- Per consultant turn, assign a signal: 'green' = clearly adapted to the style on that turn; 'amber' = partially adapted or a mixed attempt; 'grey' = off-style, generic, or too thin to read.",
    "- Overall tier: 'green' = consistently adapted, the stakeholder would feel genuinely met; 'amber' = a mixed performance with real gaps; 'red' = largely failed to adapt to this style.",
    "- Be specific and grounded: each reason must refer to what the consultant actually said. Keep each reason to one or two sentences, written directly to the consultant in second person ('you').",
    "- Suggestions are concrete things to try next time, tailored to this style. Where natural, anchor a suggestion to a line the consultant actually said via 'quotedLine'.",
    "",
    "Return ONLY a JSON object with this exact shape (no markdown, no commentary):",
    "{",
    '  "tier": "green" | "amber" | "red",',
    '  "overall": "2-3 sentence plain-language justification of the tier",',
    '  "strengths": ["short specific strength", ...],',
    '  "suggestions": [{ "text": "concrete next-time suggestion", "quotedLine": "optional exact consultant quote" }, ...],',
    `  "turns": [ exactly ${turnCount} objects, in order, one per numbered consultant turn below: { "signal": "green"|"amber"|"grey", "reason": "grounded one-or-two sentence reason", "quote": "optional short exact quote from that turn" } ]`,
    "}",
    `The "turns" array MUST contain exactly ${turnCount} objects in the same order as the numbered consultant turns.`,
  ].join("\n");
}

function buildUserPrompt(
  transcript: { role: string; text: string }[],
  userTurns: string[],
): string {
  const convo = transcript
    .map((t) => `${t.role === "assistant" ? "STAKEHOLDER" : "CONSULTANT"}: ${t.text}`)
    .join("\n");
  const numbered = userTurns.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    "Full conversation transcript:",
    convo,
    "",
    "The consultant turns to grade, in order:",
    numbered,
  ].join("\n");
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

// Validate + clamp the model's JSON into our Assessment shape. Returns null if
// the payload is too malformed to trust (caller then falls back).
function coerceAssessment(parsed: unknown, expectedTurns: number): Assessment | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  const tier = typeof o.tier === "string" ? o.tier : "";
  if (!ALLOWED_TIERS.has(tier)) return null;

  const overall = str(o.overall, 4_000) ?? "";

  const strengths = (Array.isArray(o.strengths) ? o.strengths : [])
    .filter((s): s is string => typeof s === "string")
    .slice(0, 10)
    .map((s) => s.slice(0, 500));

  const suggestions = (Array.isArray(o.suggestions) ? o.suggestions : [])
    .slice(0, 10)
    .map((s) => {
      const so = (s ?? {}) as Record<string, unknown>;
      const text = str(so.text, 500) ?? "";
      const quotedLine = str(so.quotedLine, 500);
      return quotedLine ? { text, quotedLine } : { text };
    })
    .filter((s) => s.text.length > 0);

  const rawTurns = Array.isArray(o.turns) ? o.turns : [];
  const turns: TurnEval[] = rawTurns.slice(0, MAX_USER_TURNS).map((t) => {
    const to = (t ?? {}) as Record<string, unknown>;
    const signal = typeof to.signal === "string" && ALLOWED_SIGNALS.has(to.signal)
      ? (to.signal as TurnEval["signal"])
      : "grey";
    const reason = str(to.reason, 1_000) ?? "";
    const quote = str(to.quote, 1_000);
    return quote ? { signal, reason, quote } : { signal, reason };
  });

  // Need at least one turn evaluated to be useful when turns were expected.
  if (expectedTurns > 0 && turns.length === 0) return null;

  return { tier: tier as Assessment["tier"], overall, strengths, suggestions, turns };
}

async function callAzure(
  cfg: NonNullable<ReturnType<typeof azureConfig>>,
  system: string,
  user: string,
): Promise<string> {
  const url = cfg.useV1
    ? `${cfg.endpoint}/openai/v1/chat/completions`
    : `${cfg.endpoint}/openai/deployments/${encodeURIComponent(cfg.deployment)}/chat/completions?api-version=${encodeURIComponent(cfg.apiVersion)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AZURE_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "api-key": cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        // The v1 API selects the deployment via the model field; the classic
        // deployments path encodes it in the URL instead.
        ...(cfg.useV1 ? { model: cfg.deployment } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: 2_000,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`azure ${r.status}: ${detail.slice(0, 300)}`);
    }
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const content = j.choices?.[0]?.message?.content;
    if (!content) throw new Error("azure returned empty content");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// LLM evaluation of a completed Social Styles call. Same-origin only. On any
// failure (config missing, Azure error, malformed JSON) we return a non-2xx so
// the client silently falls back to its deterministic scorer.
export function registerEvaluateRoute(app: Express): void {
  app.post(EVALUATE_PATH, async (req: Request, res: Response) => {
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
    if (!style || !ALLOWED_STYLES.has(style)) {
      res.status(400).json({ error: "invalid style" });
      return;
    }
    if (!intensity || !ALLOWED_INTENSITIES.has(intensity)) {
      res.status(400).json({ error: "invalid intensity" });
      return;
    }

    const transcript = (Array.isArray(raw["transcript"]) ? (raw["transcript"] as unknown[]) : [])
      .slice(0, MAX_TRANSCRIPT_ENTRIES)
      .map((e) => {
        const entry = (e ?? {}) as Record<string, unknown>;
        const role = entry["role"] === "assistant" ? "assistant" : "user";
        return { role, text: typeof entry["text"] === "string" ? (entry["text"] as string).slice(0, 8_000) : "" };
      })
      .filter((e) => e.text.length > 0);

    const userTurns = (Array.isArray(raw["userTurns"]) ? (raw["userTurns"] as unknown[]) : [])
      .filter((t): t is string => typeof t === "string")
      .slice(0, MAX_USER_TURNS)
      .map((t) => t.slice(0, 8_000));

    if (userTurns.length === 0) {
      res.status(422).json({ error: "no scorable turns" });
      return;
    }

    const cfg = azureConfig();
    if (!cfg) {
      logger.warn("evaluate: Azure OpenAI not configured");
      res.status(503).json({ error: "evaluation unavailable" });
      return;
    }

    try {
      const system = buildSystemPrompt(style as Style, userTurns.length);
      const user = buildUserPrompt(transcript, userTurns);
      const content = await callAzure(cfg, system, user);

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        logger.warn("evaluate: model returned non-JSON");
        res.status(502).json({ error: "evaluation failed" });
        return;
      }
      const assessment = coerceAssessment(parsed, userTurns.length);
      if (!assessment) {
        logger.warn("evaluate: model JSON failed validation");
        res.status(502).json({ error: "evaluation failed" });
        return;
      }
      res.status(200).json({ assessment });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "evaluate: Azure call failed");
      res.status(502).json({ error: "evaluation failed" });
    }
  });
}
