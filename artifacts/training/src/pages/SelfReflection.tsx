import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ProgressDots } from "@/components/ProgressDots";
import type { SocialStyle } from "@/lib/agents";
import { AGENT_LIST } from "@/lib/agents";

export interface SelfReflectionData {
  selfStyle: SocialStyle | "";
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
  const canContinue = data.selfStyle !== "";

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1" data-testid="button-back">← Back</button>
        <ProgressDots step={2} total={8} label="Step 3 of 8" />
      </header>

      <main className="flex-1 py-10">
        <h1 className="text-3xl font-semibold sm:text-4xl">Before you walk in</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          A quick gut check so you can compare how you usually show up against how you actually
          adapt in the call.
        </p>

        <div className="mt-8 space-y-8">
          <div className="space-y-4">
            <Label className="text-sm font-medium">
              Which Social Style do you think is <span className="underline">most like you</span>?
              <span className="ml-1 text-destructive">*</span>
            </Label>
            <RadioGroup
              value={data.selfStyle}
              onValueChange={(v) => setData({ ...data, selfStyle: v as SocialStyle })}
              className="grid gap-3 sm:grid-cols-2"
            >
              {AGENT_LIST.map((a) => (
                <label
                  key={a.id}
                  htmlFor={`self-${a.id}`}
                  className="flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-4 shadow-sm hover-elevate"
                  data-testid={`radio-self-${a.id}`}
                >
                  <RadioGroupItem id={`self-${a.id}`} value={a.id} className="mt-1" />
                  <div>
                    <div className="font-semibold">{a.headline}</div>
                    <div className="text-sm text-muted-foreground">{a.bullets[0]}</div>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Anything else on your mind before this call? <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              value={data.note}
              onChange={(e) => setData({ ...data, note: e.target.value })}
              rows={3}
              placeholder="e.g. I'm nervous they'll think it's our fault, I want to keep the relationship..."
              data-testid="input-note"
            />
          </div>
        </div>
      </main>

      <footer className="flex items-center justify-between pt-6">
        <span className="text-xs text-muted-foreground">Your answers stay on this device.</span>
        <Button size="lg" onClick={() => onNext(data)} disabled={!canContinue} data-testid="button-continue">
          Continue
        </Button>
      </footer>
    </div>
  );
}
