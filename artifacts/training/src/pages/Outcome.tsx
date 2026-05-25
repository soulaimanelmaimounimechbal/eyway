import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, type SocialStyle } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { CheckCircle2, AlertCircle, XCircle } from "lucide-react";

export type Tier = "green" | "amber" | "red";

export default function Outcome({
  style, tier, hits, userTurns, onNext,
}: {
  style: SocialStyle;
  tier: Tier;
  hits: string[];
  userTurns: number;
  onNext: () => void;
}) {
  const agent = AGENTS[style];
  const visual = {
    green: {
      icon: <CheckCircle2 className="h-10 w-10" />,
      title: "Green — strong adaptation",
      blurb: `${agent.name} felt heard. Your approach matched their style and they're walking away reassured.`,
      ring: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      dot: "bg-emerald-500",
    },
    amber: {
      icon: <AlertCircle className="h-10 w-10" />,
      title: "Amber — partial fit",
      blurb: `${agent.name} got some of what they needed, but you missed cues that matter to their style.`,
      ring: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      dot: "bg-amber-500",
    },
    red: {
      icon: <XCircle className="h-10 w-10" />,
      title: "Red — style mismatch",
      blurb: `${agent.name} left the call more frustrated than they came in. The approach didn't land for their style.`,
      ring: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      dot: "bg-rose-500",
    },
  }[tier];

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <div />
        <ProgressDots step={5} total={8} label="Step 6 of 8" />
      </header>

      <main className="flex flex-1 flex-col justify-center gap-8 py-10">
        <div className={cn("flex items-start gap-4 rounded-2xl border p-6", visual.ring)}>
          <div className="shrink-0">{visual.icon}</div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider">Outcome</div>
            <h1 className="mt-1 text-2xl font-semibold">{visual.title}</h1>
            <p className="mt-2 text-base text-foreground/80">{visual.blurb}</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Your turns" value={String(userTurns)} />
          <Stat label="Style cues hit" value={`${hits.length}/${agent.keywords.length}`} />
          <Stat label="Client style" value={agent.headline} />
        </div>

        <div className="rounded-2xl border bg-card p-5 shadow-sm">
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
        </div>
      </main>

      <footer className="flex items-center justify-end pt-6">
        <Button size="lg" onClick={onNext} data-testid="button-continue">Reflect on it</Button>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
