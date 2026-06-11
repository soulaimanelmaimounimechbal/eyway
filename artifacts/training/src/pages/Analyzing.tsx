import { Loader2 } from "lucide-react";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, type SocialStyle } from "@/lib/agents";

// Shown after the call ends while the LLM evaluation engine assesses the
// conversation. Falls through to the Outcome screen automatically.
export default function Analyzing({ style }: { style: SocialStyle }) {
  const agent = AGENTS[style];
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <div />
        <ProgressDots step={4} total={6} label="Step 5 of 6" />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 py-8 text-center">
        <div className="relative">
          <Loader2 className="h-12 w-12 animate-spin text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Reviewing your call</h1>
          <p className="mt-2 max-w-md text-base text-foreground/70">
            Analysing how well you adapted to {agent.name.split(" ")[0]}'s style — this takes a few
            seconds.
          </p>
        </div>
      </main>
    </div>
  );
}
