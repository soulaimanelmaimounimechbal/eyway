import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ProgressDots } from "@/components/ProgressDots";

export interface ReflectionData {
  worked: string;
  struggled: string;
  next: string;
}

export default function Reflection({
  initial, onNext, onBack,
}: {
  initial: ReflectionData;
  onNext: (d: ReflectionData) => void;
  onBack: () => void;
}) {
  const [data, setData] = useState<ReflectionData>(initial);
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1" data-testid="button-back">← Back</button>
        <ProgressDots step={6} total={8} label="Step 7 of 8" />
      </header>

      <main className="flex-1 py-10">
        <h1 className="text-3xl font-semibold sm:text-4xl">How did that feel?</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          A short reflection before you see the tips. Honest beats polished.
        </p>

        <div className="mt-8 space-y-6">
          <Field label="What worked well in that conversation?" value={data.worked} onChange={(v) => setData({ ...data, worked: v })} testId="input-worked" placeholder="e.g. I gave them a clear next step..." />
          <Field label="What did you struggle with?" value={data.struggled} onChange={(v) => setData({ ...data, struggled: v })} testId="input-struggled" placeholder="e.g. I kept giving data when they wanted a story..." />
          <Field label="What will you try differently next time?" value={data.next} onChange={(v) => setData({ ...data, next: v })} testId="input-next" placeholder="e.g. lead with empathy, then move to action..." />
        </div>
      </main>

      <footer className="flex items-center justify-end pt-6">
        <Button size="lg" onClick={() => onNext(data)} data-testid="button-continue">See tips</Button>
      </footer>
    </div>
  );
}

function Field({ label, value, onChange, testId, placeholder }: { label: string; value: string; onChange: (v: string) => void; testId: string; placeholder: string }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <Textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} placeholder={placeholder} />
    </div>
  );
}
