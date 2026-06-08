import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, type SocialStyle } from "@/lib/agents";
import type { Tier } from "./Outcome";
import { Sparkles, RotateCcw } from "lucide-react";

const STYLE_TIPS: Record<SocialStyle, { title: string; items: string[] }> = {
  analytical: {
    title: "Working with Analytical clients",
    items: [
      "Lead with structure: headline, evidence, then implication.",
      "Name your sources and your assumptions before they ask.",
      "Acknowledge what you don't yet know — they trust honesty over confidence.",
      "Avoid rushing them. Pace is part of the message.",
    ],
  },
  driving: {
    title: "Working with Driving clients",
    items: [
      "Open with the bottom line, then back it up if asked.",
      "Bring a recommendation, not just options.",
      "Name owners and dates for every action.",
      "Cut the preamble — they read it as wasting their time.",
    ],
  },
  expressive: {
    title: "Working with Expressive clients",
    items: [
      "Frame the situation as a story with a clear arc.",
      "Match their energy — be warm and direct, not flat.",
      "Give them a confident message they can repeat in the room.",
      "Don't drown them in numbers; lead with what it means.",
    ],
  },
  amiable: {
    title: "Working with Amiable clients",
    items: [
      "Open by acknowledging the people impact, not just the issue.",
      "Use \"we\" — show you're in it together.",
      "Move at their pace; rushing reads as not caring.",
      "Name concrete support for the team alongside the plan.",
    ],
  },
};

export default function Summary({
  style, tier, onRestart,
}: { style: SocialStyle; tier: Tier; onRestart: () => void }) {
  const agent = AGENTS[style];
  const tips = STYLE_TIPS[style];
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <div />
        <ProgressDots step={6} total={7} label="Step 7 of 7" />
      </header>

      <main className="flex-1 py-10 space-y-6">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium uppercase tracking-wider">
            <Sparkles className="h-3.5 w-3.5" /> Personalised tips
          </span>
          <h1 className="mt-4 text-3xl font-semibold sm:text-4xl">{tips.title}</h1>
          <p className="mt-2 text-muted-foreground">
            Based on your conversation with {agent.name} ({agent.headline}) — outcome was{" "}
            <span className="font-semibold uppercase">{tier}</span>.
          </p>
        </div>

        <ol className="space-y-3">
          {tips.items.map((t, i) => (
            <li key={i} className="flex gap-4 rounded-2xl border bg-card p-4 shadow-sm">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-semibold">
                {i + 1}
              </div>
              <div className="text-sm leading-relaxed">{t}</div>
            </li>
          ))}
        </ol>

        <div className="rounded-2xl border bg-gradient-to-br from-secondary to-background p-5">
          <div className="text-sm font-semibold">One-liner to remember</div>
          <div className="mt-1 text-lg">{agent.feedbackTip}</div>
        </div>
      </main>

      <footer className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-muted-foreground">Try another client to see how the same scenario shifts.</span>
        <Button size="lg" onClick={onRestart} data-testid="button-restart">
          <RotateCcw className="mr-2 h-4 w-4" /> Try another client
        </Button>
      </footer>
    </div>
  );
}
