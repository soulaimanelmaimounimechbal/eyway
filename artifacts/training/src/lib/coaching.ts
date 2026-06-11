import type { AgentConfig, SocialStyle } from "./agents";
import { isScorableUserTurn, type TranscriptEntry } from "./voice-client";

export type TurnSignal = "green" | "amber" | "grey";
export type Tier = "green" | "amber" | "red";

export interface TurnEvaluation {
  signal: TurnSignal;
  note?: string;
  hits: string[];
  wordCount: number;
}

export interface AnchoredSuggestion {
  text: string;
  quotedLine?: string;
}

export interface CallSummary {
  suggestions: AnchoredSuggestion[];
  greenTurns: number;
  amberTurns: number;
  greyTurns: number;
}

// Per-turn thresholds are derived from the canonical scoreTranscript rules
// (see voice-client.ts) so the two scorers cannot disagree:
//   - scoreTranscript treats avgWords < 4 as a hard "red" floor
//   - scoreTranscript only grants overall "green" when avgWords >= 10 AND
//     there is at least one keyword hit per ~turn
//   - everything in between with at least one keyword is "amber"
// Mirroring those thresholds per turn means an aggregate of per-turn signals
// is structurally compatible with the canonical tier; reconcileWithTier()
// below provides a defense-in-depth check.
const GREY_WORDS = 4;
const GREEN_WORDS = 10;

function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function matchKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return Array.from(new Set(keywords.filter((k) => lower.includes(k.toLowerCase()))));
}

const TURN_NOTES: Record<SocialStyle, { green: string; amber: string }> = {
  analytical: {
    green: "good — you grounded it in specifics",
    amber: "they want a source or number behind that",
  },
  driving: {
    green: "tight and direct — they like that",
    amber: "this might feel like preamble — cut to the action",
  },
  expressive: {
    green: "you gave it shape and energy",
    amber: "frame this as a story they can repeat tomorrow",
  },
  amiable: {
    green: "warm — you acknowledged the people side",
    amber: "felt transactional — name how the team is affected",
  },
};

const GREY_NOTE = "very short — they may not have much to react to";

export function evaluateTurn(turn: TranscriptEntry, persona: AgentConfig): TurnEvaluation {
  const words = wordsOf(turn.text);
  const wordCount = words.length;
  const hits = matchKeywords(turn.text, persona.keywords);
  const notes = TURN_NOTES[persona.id];

  // Too short to register as adapting to the style at all.
  if (wordCount < GREY_WORDS) {
    return { signal: "grey", note: GREY_NOTE, hits, wordCount };
  }
  // Amber / green BOTH require at least one persona keyword hit. A turn
  // with no hits cannot register as "partial fit" — that would let an
  // all-amber breakdown sit under a canonical "red" tier (no hits anywhere).
  if (hits.length === 0) {
    return { signal: "grey", note: notes.amber, hits, wordCount };
  }
  // Mirrors the canonical avgWords >= 10 + keyword-hit threshold per turn.
  if (wordCount >= GREEN_WORDS) {
    return { signal: "green", note: notes.green, hits, wordCount };
  }
  return { signal: "amber", note: notes.amber, hits, wordCount };
}

/**
 * Reconcile per-turn signals against the canonical tier from scoreTranscript.
 * Guarantees the per-turn breakdown never contradicts the headline tier:
 *   - tier=red    → no greens (downgrade any greens to amber)
 *   - tier=amber  → cannot be "all green" (demote weakest green to amber)
 *   - tier=green  → must have at least one green (promote strongest amber if needed)
 */
export function reconcileWithTier(
  evals: TurnEvaluation[],
  tier: Tier,
  persona: AgentConfig,
): TurnEvaluation[] {
  const notes = TURN_NOTES[persona.id];
  const out = evals.map((e) => ({ ...e }));
  if (tier === "red") {
    // Under a red tier, no turn may read as "on-style". With the tightened
    // amber rule (requires ≥1 keyword hit), a true red transcript usually
    // has zero hits anywhere, so most turns are already grey. We still
    // demote any greens to amber and use the persona's amber note.
    for (const e of out) {
      if (e.signal === "green") {
        e.signal = "amber";
        e.note = notes.amber;
      }
    }
    return out;
  }
  if (tier === "amber") {
    const nonGrey = out.filter((e) => e.signal !== "grey");
    if (nonGrey.length > 0 && nonGrey.every((e) => e.signal === "green")) {
      // Demote the weakest green (fewest hits, then shortest) to amber.
      let weakest = nonGrey[0];
      for (const e of nonGrey) {
        if (
          e.hits.length < weakest.hits.length ||
          (e.hits.length === weakest.hits.length && e.wordCount < weakest.wordCount)
        ) {
          weakest = e;
        }
      }
      weakest.signal = "amber";
      weakest.note = notes.amber;
    }
    return out;
  }
  // tier === "green": ensure at least one green dot exists.
  if (!out.some((e) => e.signal === "green")) {
    let strongest: TurnEvaluation | null = null;
    for (const e of out) {
      if (e.signal !== "amber") continue;
      if (
        !strongest ||
        e.hits.length > strongest.hits.length ||
        (e.hits.length === strongest.hits.length && e.wordCount > strongest.wordCount)
      ) {
        strongest = e;
      }
    }
    if (strongest) {
      strongest.signal = "green";
      strongest.note = notes.green;
    }
  }
  return out;
}

// Same per-persona pointers we anchor in the post-call Summary, but exposed
// for the in-call coaching panel so participants can stay aligned to the
// style *while* they talk — not just learn after the fact.
export const LIVE_STYLE_TIPS: Record<SocialStyle, string[]> = {
  analytical: [
    "Lead with the number, then the inference.",
    "Name your assumptions so Morgan can audit them.",
    "When you don't know, say 'I don't have that yet — I'll come back with the source.'",
  ],
  driving: [
    "Open with the headline and the ask — not the context.",
    "Close every answer with a clear next step and an owner.",
    "Cut hedging ('I think we could maybe…') — Dana hears it as drift.",
  ],
  expressive: [
    "Give Daniel one sentence he can use in the room tomorrow.",
    "Reach for a metaphor or analogy to make it stick.",
    "Tie it to people and momentum, not process.",
  ],
  amiable: [
    "Acknowledge how the team is feeling before proposing a fix.",
    "Use 'we' more than 'I' — John listens for partnership.",
    "Slow down. Let pauses sit. They read warmth as care.",
  ],
};

export function summarizeCall(
  transcript: TranscriptEntry[],
  persona: AgentConfig,
  tier: Tier,
): CallSummary {
  const userTurns = transcript.filter(isScorableUserTurn);
  const rawEvals = userTurns.map((t) => evaluateTurn(t, persona));
  const evals = reconcileWithTier(rawEvals, tier, persona);

  let green = 0, amber = 0, grey = 0;
  for (const e of evals) {
    if (e.signal === "green") green++;
    else if (e.signal === "amber") amber++;
    else grey++;
  }

  // Anchor each suggestion to its own quoted user line. We rank candidate
  // turns by "how clearly off-style" they were (amber > grey, then longer
  // lines first so the quote is meaningful). If we run out of off-style
  // turns we fall back to any user turn, and finally to no anchor.
  const ranked = userTurns
    .map((t, i) => ({ turn: t, ev: evals[i] }))
    .filter((x) => x.ev.signal !== "green")
    .sort((a, b) => {
      const sigRank = (s: TurnSignal) => (s === "amber" ? 0 : s === "grey" ? 1 : 2);
      const r = sigRank(a.ev.signal) - sigRank(b.ev.signal);
      if (r !== 0) return r;
      return b.turn.text.length - a.turn.text.length;
    });
  const fallback = userTurns.filter((t) => !ranked.some((r) => r.turn === t));
  const quotes: (string | undefined)[] = [];
  for (let i = 0; i < LIVE_STYLE_TIPS[persona.id].length; i++) {
    if (i < ranked.length) quotes.push(ranked[i].turn.text);
    else if (i - ranked.length < fallback.length) quotes.push(fallback[i - ranked.length].text);
    else quotes.push(undefined);
  }

  const suggestions: AnchoredSuggestion[] = LIVE_STYLE_TIPS[persona.id]
    .slice(0, 3)
    .map((text, i) => ({ text, quotedLine: quotes[i] }));

  return { suggestions, greenTurns: green, amberTurns: amber, greyTurns: grey };
}

export const TURN_SIGNAL_CLASSES: Record<TurnSignal, { dot: string; ring: string; label: string }> = {
  green: { dot: "bg-emerald-500", ring: "ring-emerald-500/40", label: "on-style" },
  amber: { dot: "bg-amber-500", ring: "ring-amber-500/40", label: "partial" },
  grey: { dot: "bg-muted-foreground/50", ring: "ring-muted-foreground/30", label: "off style" },
};

/** Pair each scorable user turn with the next assistant turn that follows it. */
export function pairTurns(
  transcript: TranscriptEntry[],
): { user: TranscriptEntry; assistant?: TranscriptEntry }[] {
  const pairs: { user: TranscriptEntry; assistant?: TranscriptEntry }[] = [];
  for (let i = 0; i < transcript.length; i++) {
    const t = transcript[i];
    if (!isScorableUserTurn(t)) continue;
    let assistant: TranscriptEntry | undefined;
    for (let j = i + 1; j < transcript.length; j++) {
      if (transcript[j].role === "assistant" && transcript[j].done) {
        assistant = transcript[j];
        break;
      }
    }
    pairs.push({ user: t, assistant });
  }
  return pairs;
}

/**
 * Compute the per-turn evaluations the Outcome screen should render —
 * always reconciled against the canonical tier so the per-turn dots and
 * the headline tier are guaranteed to agree.
 */
export function evaluateAllTurns(
  transcript: TranscriptEntry[],
  persona: AgentConfig,
  tier: Tier,
): TurnEvaluation[] {
  const userTurns = transcript.filter(isScorableUserTurn);
  return reconcileWithTier(userTurns.map((t) => evaluateTurn(t, persona)), tier, persona);
}
