import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AlertTriangle, Building2, Clock } from "lucide-react";

export default function Scenario({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1" data-testid="button-back">← Back</button>
        <ProgressDots step={1} total={8} label="Step 2 of 8" />
      </header>

      <main className="flex-1 py-10">
        <span className="inline-flex items-center gap-2 rounded-full border bg-secondary px-3 py-1 text-xs font-medium uppercase tracking-wider">
          <Building2 className="h-3.5 w-3.5" /> Client brief
        </span>
        <h1 className="mt-4 text-3xl font-semibold sm:text-4xl">Glenara Travel Group</h1>
        <p className="mt-2 text-muted-foreground">A last-minute call from a senior stakeholder. The room is tense.</p>

        <div className="mt-8 space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
          <Row icon={<Building2 className="h-4 w-4" />} label="Client">
            Glenara Travel Group — fast-growing logistics company, EY engagement on sustainability reporting.
          </Row>
          <Row icon={<AlertTriangle className="h-4 w-4" />} label="Situation">
            EY delivered a sustainability report. The <span className="font-medium">data is correct</span>, but parts of
            it were unclear and have been misinterpreted internally. There is negative feedback circulating.
          </Row>
          <Row icon={<Clock className="h-4 w-4" />} label="Stakes">
            The stakeholder has a leadership update <span className="font-medium">tomorrow morning</span>. They want
            clarity on what happened, what to say, and what to do next.
          </Row>
        </div>

        <div className="mt-6 rounded-xl border border-accent/40 bg-accent/10 p-4 text-sm">
          <span className="font-semibold">Your role:</span> EY consultant on the engagement. You called in to handle
          this conversation directly.
        </div>
      </main>

      <footer className="flex items-center justify-end pt-6">
        <Button size="lg" onClick={onNext} data-testid="button-continue">I'm ready</Button>
      </footer>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div>
      <div className="flex-1">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-1 text-[15px] leading-relaxed">{children}</div>
      </div>
    </div>
  );
}
