import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, type SocialStyle } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { CheckCircle2, AlertCircle, XCircle, RefreshCcw, Users, ArrowRight } from "lucide-react";
import type { TranscriptEntry } from "@/lib/voice-client";
import {
  evaluateAllTurns,
  pairTurns,
  summarizeCall,
  TURN_SIGNAL_CLASSES,
  type TurnSignal,
} from "@/lib/coaching";
import type { AiAssessment, AiSuggestion } from "@/lib/assessment";

export type Tier = "green" | "amber" | "red";

const TIER_VISUALS: Record<Tier, {
  icon: ReactNode;
  title: string;
  blurb: (name: string) => string;
  ring: string;
}> = {
  green: {
    icon: <CheckCircle2 className="h-10 w-10" />,
    title: "Green — strong adaptation",
    blurb: (n) => `${n} felt heard. Your approach matched their style and they're walking away reassured.`,
    ring: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  amber: {
    icon: <AlertCircle className="h-10 w-10" />,
    title: "Amber — partial fit",
    blurb: (n) => `${n} got some of what they needed, but you missed cues that matter to their style.`,
    ring: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  red: {
    icon: <XCircle className="h-10 w-10" />,
    title: "Red — style mismatch",
    blurb: (n) => `${n} left the call more frustrated than they came in. The approach didn't land for their style.`,
    ring: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
};

interface TurnView {
  signal: TurnSignal;
  note?: string;
}

export default function Outcome({
  style,
  tier,
  hits,
  userTurns,
  transcript,
  assessment,
  onNext,
  onTrySame,
  onTryDifferent,
}: {
  style: SocialStyle;
  tier: Tier;
  hits: string[];
  userTurns: number;
  transcript: TranscriptEntry[];
  assessment?: AiAssessment;
  onNext: () => void;
  onTrySame: () => void;
  onTryDifferent: () => void;
}) {
  const agent = AGENTS[style];
  const visual = TIER_VISUALS[tier];
  const isAi = !!assessment;

  const pairs = useMemo(() => pairTurns(transcript), [transcript]);

  // Per-turn views, suggestions and headline blurb come from the AI assessment
  // when present; otherwise from the deterministic scorer. Per-turn signals in
  // the deterministic path are reconciled against the canonical tier so the
  // breakdown can never contradict the headline.
  const reconciledEvals = useMemo(
    () => evaluateAllTurns(transcript, agent, tier),
    [transcript, agent, tier],
  );
  const summary = useMemo(() => summarizeCall(transcript, agent, tier), [transcript, agent, tier]);

  const turnViews: TurnView[] = useMemo(() => {
    if (assessment) {
      return pairs.map((_, idx) => {
        const t = assessment.turns[idx];
        return { signal: t?.signal ?? "grey", note: t?.reason };
      });
    }
    return reconciledEvals.map((e) => ({ signal: e.signal, note: e.note }));
  }, [assessment, pairs, reconciledEvals]);

  const counts = useMemo(() => {
    let green = 0, amber = 0, grey = 0;
    for (const t of turnViews) {
      if (t.signal === "green") green++;
      else if (t.signal === "amber") amber++;
      else grey++;
    }
    return { green, amber, grey };
  }, [turnViews]);

  const blurb = assessment?.overall ?? visual.blurb(agent.name);
  const suggestions: AiSuggestion[] = assessment?.suggestions ?? summary.suggestions;
  const strengths = assessment?.strengths ?? [];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <div />
        <ProgressDots step={4} total={6} label="Step 5 of 6" />
      </header>

      <main className="flex flex-1 flex-col gap-6 py-8">
        <div className={cn("flex items-start gap-4 rounded-2xl border p-6", visual.ring)} data-testid="tier-headline">
          <div className="shrink-0">{visual.icon}</div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider">Outcome</div>
            <h1 className="mt-1 text-2xl font-semibold">{visual.title}</h1>
            <p className="mt-2 text-base text-foreground/80">{blurb}</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Your turns" value={String(userTurns)} />
          <Stat label="On-style" value={String(counts.green)} tone="green" />
          <Stat label="Partial" value={String(counts.amber)} tone="amber" />
          <Stat label="Off style" value={String(counts.grey)} tone="grey" />
        </div>

        <section className="rounded-2xl border bg-card p-5 shadow-sm">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Turn-by-turn</h2>
            <span className="text-xs text-muted-foreground">{pairs.length} of your turns</span>
          </div>
          {pairs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No completed turns to review — try the call again and speak naturally for a few exchanges.
            </p>
          ) : (
            <ol className="space-y-4" data-testid="turn-breakdown">
              {pairs.map((p, idx) => {
                const ev = turnViews[idx];
                if (!ev) return null;
                const cls = TURN_SIGNAL_CLASSES[ev.signal];
                return (
                  <li
                    key={idx}
                    className={cn("rounded-xl border bg-background/40 p-3 ring-1 ring-inset", cls.ring)}
                    data-testid={`turn-row-${ev.signal}`}
                  >
                    <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <span className={cn("inline-block h-2 w-2 rounded-full", cls.dot)} />
                      <span>Turn {idx + 1} · {cls.label}</span>
                    </div>
                    <div className="text-sm font-medium leading-snug">"{p.user.text}"</div>
                    {p.assistant && (
                      <div className="mt-2 text-sm text-muted-foreground">
                        <span className="font-semibold text-foreground/80">{agent.name}:</span> {p.assistant.text}
                      </div>
                    )}
                    {ev.note && ev.signal !== "green" && (
                      <div className="mt-2 text-xs italic text-foreground/70">→ {ev.note}</div>
                    )}
                    {ev.note && ev.signal === "green" && (
                      <div className="mt-2 text-xs italic text-emerald-700 dark:text-emerald-300">✓ {ev.note}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {strengths.length > 0 && (
          <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">What worked</h2>
            <ul className="mt-3 space-y-2" data-testid="strengths-list">
              {strengths.map((s, i) => (
                <li key={i} className="flex items-start gap-2 text-sm" data-testid={`strength-${i}`}>
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span className="leading-snug">{s}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-primary/30 bg-primary/5 p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-primary">Try next time</h2>
          <ul className="mt-3 space-y-3" data-testid="suggestions-list">
            {suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-sm" data-testid={`suggestion-${i}`}>
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                  {i + 1}
                </span>
                <div className="flex-1">
                  <div className="leading-snug">{s.text}</div>
                  {s.quotedLine && (
                    <div
                      className="mt-1.5 border-l-2 border-primary/40 px-3 py-1 text-xs italic text-foreground/70"
                      data-testid={`suggestion-quote-${i}`}
                    >
                      e.g. when you said "{s.quotedLine}"
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {!isAi && (
          <section className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Cues we listened for</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {agent.keywords.map((k) => {
                const hit = hits.includes(k);
                return (
                  <span
                    key={k}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs",
                      hit ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-border bg-muted text-muted-foreground",
                    )}
                    data-testid={`chip-keyword-${k}`}
                  >
                    {hit ? "✓ " : ""}{k}
                  </span>
                );
              })}
            </div>
          </section>
        )}
      </main>

      <footer className="flex flex-wrap items-center justify-end gap-3 pt-6">
        <Button
          size="lg"
          variant="outline"
          onClick={onTrySame}
          data-testid="button-try-same"
          className="gap-2"
        >
          <RefreshCcw className="h-4 w-4" /> Try {agent.name.split(" ")[0]} again
        </Button>
        <Button
          size="lg"
          variant="outline"
          onClick={onTryDifferent}
          data-testid="button-try-different"
          className="gap-2"
        >
          <Users className="h-4 w-4" /> Try a different style
        </Button>
        <Button size="lg" onClick={onNext} data-testid="button-continue" className="gap-2">
          See tips <ArrowRight className="h-4 w-4" />
        </Button>
      </footer>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "green" | "amber" | "grey";
}) {
  const toneClass = tone === "green"
    ? "text-emerald-600 dark:text-emerald-300"
    : tone === "amber"
      ? "text-amber-600 dark:text-amber-300"
      : tone === "grey"
        ? "text-muted-foreground"
        : "text-foreground";
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold", toneClass)}>{value}</div>
    </div>
  );
}
