import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, type SocialStyle } from "@/lib/agents";
import { VoiceClient, type TranscriptEntry, type VoiceState } from "@/lib/voice-client";
import { Mic, MicOff, PhoneOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Conversation({
  style,
  onDone,
  onBack,
}: {
  style: SocialStyle;
  onDone: (transcript: TranscriptEntry[]) => void;
  onBack: () => void;
}) {
  const agent = AGENTS[style];
  const clientRef = useRef<VoiceClient | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    const c = new VoiceClient(agent, {
      onStateChange: setState,
      onTranscript: setTranscript,
      onError: (msg) => setError(msg),
      onSpeakingChange: setAssistantSpeaking,
    });
    clientRef.current = c;
    startedAtRef.current = Date.now();
    c.start().catch(() => {});
    const interval = setInterval(() => {
      if (startedAtRef.current) setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 500);
    return () => {
      clearInterval(interval);
      c.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript]);

  const userTurns = transcript.filter((t) => t.role === "user" && t.done && t.text.trim()).length;
  const maxSeconds = 300;
  const timeUp = seconds >= maxSeconds;
  const canEnd = userTurns >= 1;

  async function handleEnd() {
    const c = clientRef.current;
    if (!c) return;
    await c.stop();
    onDone(transcript);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1" data-testid="button-back">← Back</button>
        <ProgressDots step={4} total={8} label="Step 5 of 8" />
      </header>

      <main className="flex flex-1 flex-col gap-6 py-8">
        <div className={cn("flex items-center gap-4 rounded-2xl border bg-gradient-to-br p-5 shadow-sm", agent.accent)}>
          <div className={cn(
            "relative flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground text-lg font-semibold",
            assistantSpeaking && "animate-pulse-ring text-primary",
          )}>
            {agent.name.split(" ").map((n) => n[0]).join("")}
          </div>
          <div className="flex-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{agent.headline} client</div>
            <div className="text-lg font-semibold">{agent.name}</div>
            <div className="text-sm text-muted-foreground">{agent.role}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Call time</div>
            <div className="font-mono text-lg tabular-nums">{formatTime(seconds)}</div>
          </div>
        </div>

        <div className="grid flex-1 gap-4 md:grid-cols-[1fr_300px]">
          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex h-full max-h-[55vh] flex-col">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Live transcript</h3>
                <StateBadge state={state} />
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto pr-2" data-testid="transcript-list">
                {transcript.length === 0 && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    Connecting and warming up your microphone…
                  </div>
                )}
                {transcript.map((t, i) => (
                  <div
                    key={i}
                    className={cn(
                      "rounded-xl px-3.5 py-2.5 text-sm leading-relaxed",
                      t.role === "assistant"
                        ? "bg-secondary text-secondary-foreground"
                        : "ml-6 bg-primary text-primary-foreground",
                      !t.done && "opacity-70 italic",
                    )}
                  >
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider opacity-70">
                      {t.role === "assistant" ? agent.name : "You"}
                    </div>
                    {t.text || "…"}
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border bg-card p-4 shadow-sm">
              <h4 className="text-sm font-semibold">Guidance</h4>
              <p className="mt-2 text-sm text-muted-foreground">
                Speak naturally — there is no push-to-talk. Pause to let them respond.
              </p>
              <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                <li>· You can talk for up to 5 minutes</li>
                <li>· End the call when you feel done</li>
                <li>· They will react to your style, not just your words</li>
              </ul>
            </div>
            <div className="rounded-2xl border bg-card p-4 shadow-sm">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Your turns</div>
              <div className="text-2xl font-semibold">{userTurns}</div>
              {timeUp && <div className="mt-2 text-xs text-destructive">Time's up — wrap it up.</div>}
            </div>
          </aside>
        </div>

        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="error-banner">
            {error}
          </div>
        )}
      </main>

      <footer className="flex items-center justify-between pt-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {state === "listening" ? (
            <><Mic className="h-4 w-4 text-emerald-500" /> Mic live</>
          ) : state === "connecting" ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</>
          ) : (
            <><MicOff className="h-4 w-4" /> Mic off</>
          )}
        </div>
        <Button
          size="lg"
          variant="destructive"
          onClick={handleEnd}
          disabled={!canEnd && state !== "error"}
          data-testid="button-end-call"
        >
          <PhoneOff className="mr-2 h-4 w-4" /> End call
        </Button>
      </footer>
    </div>
  );
}

function StateBadge({ state }: { state: VoiceState }) {
  const label = {
    idle: "Idle",
    connecting: "Connecting…",
    ready: "Ready",
    listening: "Listening",
    closing: "Ending…",
    closed: "Ended",
    error: "Error",
  }[state];
  return (
    <span className={cn(
      "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
      state === "listening" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      state === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
    )}>{label}</span>
  );
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
