import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ProgressDots } from "@/components/ProgressDots";

export interface SelfReflectionData {
  feeling: string;
  priority: string;
  worry: string;
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
        <ProgressDots step={2} total={8} label="Step 3 of 8" />
      </header>

      <main className="flex-1 py-10">
        <h1 className="text-3xl font-semibold sm:text-4xl">Before you walk in</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Take a beat. Notice what's actually going on for you before this conversation. There are
          no right answers — this is for you.
        </p>

        <div className="mt-8 space-y-6">
          <Field
            label="How are you feeling right now about this call?"
            placeholder="e.g. anxious, prepared, defensive..."
            value={data.feeling}
            onChange={(v) => setData({ ...data, feeling: v })}
            testId="input-feeling"
          />
          <Field
            label="What's the one thing you most want from this conversation?"
            placeholder="e.g. they trust the report; we agree on a plan; they calm down..."
            value={data.priority}
            onChange={(v) => setData({ ...data, priority: v })}
            testId="input-priority"
          />
          <Field
            label="What are you most worried might go wrong?"
            placeholder="e.g. they don't listen; I get blamed; I freeze..."
            value={data.worry}
            onChange={(v) => setData({ ...data, worry: v })}
            testId="input-worry"
          />
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

function Field({
  label, placeholder, value, onChange, testId,
}: { label: string; placeholder: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        data-testid={testId}
      />
    </div>
  );
}
