import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { Mic, Sparkles, Users } from "lucide-react";

export default function Intro({ onNext }: { onNext: () => void }) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-between p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded bg-primary" />
          <span className="text-sm font-semibold tracking-wide">EY · Social Styles Lab</span>
        </div>
        <ProgressDots step={0} total={6} label="Step 1 of 6" />
      </header>
      <main className="flex flex-1 flex-col justify-center gap-8 py-10">
        <div className="space-y-4">
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium uppercase tracking-wider text-foreground">
            <Sparkles className="h-3.5 w-3.5" /> Voice simulation
          </span>
          <h1 className="text-4xl font-semibold leading-tight sm:text-5xl">
            Adapting your style in client conversations
          </h1>
          <p className="max-w-2xl text-lg text-muted-foreground">You'll walk into a high-stakes meeting with one of four clients, each modelled on the TRACOM Social Styles framework. Speak naturally. The client will respond in character, and you'll get feedback on how well you adapted.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Feature icon={<Users className="h-5 w-5" />} title="4 client social styles" body="Analytical, Driving, Expressive, Amiable" />
          <Feature icon={<Mic className="h-5 w-5" />} title="Live voice" body="Real-time, two-way conversation" />
          <Feature icon={<Sparkles className="h-5 w-5" />} title="Styled feedback" body="Tips tied to each social style" />
        </div>
      </main>
      <footer className="flex items-center justify-end pt-6">
        <Button size="lg" onClick={onNext} data-testid="button-start">
          Begin training
        </Button>
      </footer>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="mb-2 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-muted-foreground">{body}</div>
    </div>
  );
}
