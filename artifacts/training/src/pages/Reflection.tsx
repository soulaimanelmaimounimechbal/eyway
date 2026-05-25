import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENT_LIST, type SocialStyle } from "@/lib/agents";

export interface ReflectionData {
  worked: string;
  next: string;
  hardestStyle: SocialStyle | "";
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
        <p className="mt-2 max-w-2xl text-muted-foreground">A short reflection before you see the tips.</p>

        <div className="mt-8 space-y-6">
          <div className="space-y-2">
            <Label className="text-sm font-medium">What worked well in that conversation?</Label>
            <Textarea rows={3} value={data.worked} onChange={(e) => setData({ ...data, worked: e.target.value })} data-testid="input-worked" placeholder="e.g. I gave them a clear next step..." />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">What will you try differently next time?</Label>
            <Textarea rows={3} value={data.next} onChange={(e) => setData({ ...data, next: e.target.value })} data-testid="input-next" placeholder="e.g. lead with empathy, then move to action..." />
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">Which style do you find most challenging?</Label>
            <Select
              value={data.hardestStyle}
              onValueChange={(v) => setData({ ...data, hardestStyle: v as SocialStyle })}
            >
              <SelectTrigger data-testid="select-hardest"><SelectValue placeholder="Pick a style…" /></SelectTrigger>
              <SelectContent>
                {AGENT_LIST.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.headline} — {a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </main>

      <footer className="flex items-center justify-end pt-6">
        <Button size="lg" onClick={() => onNext(data)} data-testid="button-continue">See tips</Button>
      </footer>
    </div>
  );
}
