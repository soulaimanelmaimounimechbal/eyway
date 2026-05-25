import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENT_LIST, type SocialStyle } from "@/lib/agents";
import { cn } from "@/lib/utils";

export default function SelectClient({
  selected,
  onSelect,
  onNext,
  onBack,
}: {
  selected: SocialStyle | null;
  onSelect: (s: SocialStyle) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1" data-testid="button-back">← Back</button>
        <ProgressDots step={3} total={8} label="Step 4 of 8" />
      </header>

      <main className="flex-1 py-10">
        <h1 className="text-3xl font-semibold sm:text-4xl">Who's on the call?</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Pick the stakeholder you want to practice with. Each one represents a different Social
          Style. They will react very differently to the same approach.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {AGENT_LIST.map((a) => {
            const active = selected === a.id;
            return (
              <button
                key={a.id}
                onClick={() => onSelect(a.id)}
                data-testid={`card-client-${a.id}`}
                className={cn(
                  "relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 text-left shadow-sm transition-all hover-elevate",
                  a.accent,
                  active && "ring-2 ring-primary ring-offset-2 ring-offset-background",
                )}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{a.headline}</div>
                    <h3 className="mt-1 text-xl font-semibold">{a.name}</h3>
                    <div className="text-sm text-muted-foreground">{a.role}</div>
                  </div>
                  <div className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full border text-xs",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background",
                  )}>
                    {active ? "✓" : ""}
                  </div>
                </div>
                <ul className="mt-4 space-y-1.5 text-sm">
                  {a.bullets.map((b) => (
                    <li key={b} className="flex gap-2"><span className="text-muted-foreground">•</span>{b}</li>
                  ))}
                </ul>
                <div className="mt-4 text-xs uppercase tracking-wider text-muted-foreground">Tone</div>
                <div className="text-sm">{a.tone}</div>
              </button>
            );
          })}
        </div>
      </main>

      <footer className="flex items-center justify-between pt-6">
        <span className="text-xs text-muted-foreground">You can come back and try another after.</span>
        <Button size="lg" onClick={onNext} disabled={!selected} data-testid="button-continue">
          Start conversation
        </Button>
      </footer>
    </div>
  );
}
