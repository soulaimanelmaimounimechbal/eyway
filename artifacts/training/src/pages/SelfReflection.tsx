import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ProgressDots } from "@/components/ProgressDots";

export interface SelfReflectionData {
  note: string;
}

export default function SelfReflection({
  initial,
  onNext,
  onBack,
}: {
  initial: SelfReflectionData;
  onNext: (d: SelfReflectionData) => void;
  onBack: () => void;
}) {
  const [data, setData] = useState<SelfReflectionData>(initial);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1" data-testid="button-back">← Back</button>
        <ProgressDots step={2} total={7} label="Step 3 of 7" />
      </header>

      <main className="flex-1 py-10">
        <h1 className="text-3xl font-semibold sm:text-4xl">Before you walk in</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          A quick moment to set your intention before the call. Jot down anything you want to keep
          front of mind — it's just for you.
        </p>

        <div className="mt-8 space-y-8">
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Anything on your mind before this call? <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              value={data.note}
              onChange={(e) => setData({ ...data, note: e.target.value })}
              rows={4}
              placeholder="e.g. I'm nervous they'll think it's our fault, I want to keep the relationship..."
              data-testid="input-note"
            />
          </div>
        </div>
      </main>

      <footer className="flex items-center justify-between pt-6">
        <span className="text-xs text-muted-foreground">Your answers stay on this device.</span>
        <Button size="lg" onClick={() => onNext(data)} data-testid="button-continue">
          Continue
        </Button>
      </footer>
    </div>
  );
}
