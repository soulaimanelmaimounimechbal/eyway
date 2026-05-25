import type { AgentConfig, SocialStyle } from "./agents";
import type { TranscriptEntry } from "./voice-client";

export type TurnSignal = "green" | "amber" | "grey";

export interface TurnEvaluation {
  signal: TurnSignal;
  note?: string;
  hits: string[];
  wordCount: number;
}

export interface CoachingNudge {
  id: string;
  text: string;
}

export interface CallSummary {
  suggestions: string[];
  quotedLine?: string;
  greenTurns: number;
  amberTurns: number;
  greyTurns: number;
}

const GREY_WORDS = 4;
const SHORT_WORDS = 6;

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

  if (wordCount < GREY_WORDS) {
    return { signal: "grey", note: GREY_NOTE, hits, wordCount };
  }
  if (hits.length >= 1 && wordCount >= SHORT_WORDS) {
    return { signal: "green", note: notes.green, hits, wordCount };
  }
  return { signal: "amber", note: notes.amber, hits, wordCount };
}

const NUDGE_TEXTS: Record<SocialStyle, { id: string; text: string }> = {
  analytical: {
    id: "analytical:data",
    text: "Morgan loves data — try grounding your point in a number or source.",
  },
  driving: {
    id: "driving:action",
    text: "Alex wants action — name an owner and a date.",
  },
  expressive: {
    id: "expressive:story",
    text: "Priya thinks in stories — give her a one-line narrative she can repeat.",
  },
  amiable: {
    id: "amiable:people",
    text: "Jordan listens for the team — name how this lands for the people.",
  },
};

/**
 * Decide whether a coaching nudge should fire right now.
 * Caller is responsible for de-duplicating by nudge id (already-fired set)
 * and for enforcing the cool-down between nudges.
 */
export function pickNudge(
  userTurns: TranscriptEntry[],
  persona: AgentConfig,
  alreadyFired: Set<string>,
): CoachingNudge | null {
  if (userTurns.length < 2) return null;
  const last2 = userTurns.slice(-2).map((t) => evaluateTurn(t, persona));
  const offStyle = last2.every((e) => e.signal !== "green");
  if (!offStyle) return null;
  const candidate = NUDGE_TEXTS[persona.id];
  if (alreadyFired.has(candidate.id)) return null;
  return candidate;
}

const SUGGESTIONS: Record<SocialStyle, string[]> = {
  analytical: [
    "Lead with the number, then the inference.",
    "Name your assumptions so Morgan can audit them.",
    "When you don't know, say 'I don't have that yet — I'll come back with the source.'",
  ],
  driving: [
    "Open with the headline and the ask — not the context.",
    "Close every answer with a clear next step and an owner.",
    "Cut hedging ('I think we could maybe…') — Alex hears it as drift.",
  ],
  expressive: [
    "Give Priya one sentence she can use in the room tomorrow.",
    "Reach for a metaphor or analogy to make it stick.",
    "Tie it to people and momentum, not process.",
  ],
  amiable: [
    "Acknowledge how the team is feeling before proposing a fix.",
    "Use 'we' more than 'I' — Jordan listens for partnership.",
    "Slow down. Let pauses sit. They read warmth as care.",
  ],
};

export function summarizeCall(transcript: TranscriptEntry[], persona: AgentConfig): CallSummary {
  const userTurns = transcript.filter((t) => t.role === "user" && t.done && t.text.trim());
  const evals = userTurns.map((t) => evaluateTurn(t, persona));
  let green = 0, amber = 0, grey = 0;
  let worstTurn: { text: string; len: number } | null = null;
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i];
    if (e.signal === "green") green++;
    else if (e.signal === "amber") amber++;
    else grey++;
    if (e.signal !== "green") {
      const len = userTurns[i].text.length;
      if (!worstTurn || len > worstTurn.len) {
        worstTurn = { text: userTurns[i].text, len };
      }
    }
  }
  const allSuggestions = SUGGESTIONS[persona.id];
  // Show all three by default; trim to 3 explicitly per the task.
  const suggestions = allSuggestions.slice(0, 3);
  return {
    suggestions,
    quotedLine: worstTurn?.text,
    greenTurns: green,
    amberTurns: amber,
    greyTurns: grey,
  };
}

export const TURN_SIGNAL_CLASSES: Record<TurnSignal, { dot: string; ring: string; label: string }> = {
  green: { dot: "bg-emerald-500", ring: "ring-emerald-500/40", label: "on-style" },
  amber: { dot: "bg-amber-500", ring: "ring-amber-500/40", label: "partial" },
  grey: { dot: "bg-muted-foreground/50", ring: "ring-muted-foreground/30", label: "too short" },
};

/** Pair each user turn with the assistant turn that immediately follows it. */
export function pairTurns(
  transcript: TranscriptEntry[],
): { user: TranscriptEntry; assistant?: TranscriptEntry }[] {
  const pairs: { user: TranscriptEntry; assistant?: TranscriptEntry }[] = [];
  for (let i = 0; i < transcript.length; i++) {
    const t = transcript[i];
    if (t.role !== "user" || !t.done || !t.text.trim()) continue;
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
