import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, type SocialStyle } from "@/lib/agents";
import { VoiceClient, type TranscriptEntry, type VoiceState } from "@/lib/voice-client";
import { Mic, MicOff, PhoneOff, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_TURNS = 10;
const MAX_SECONDS = 300;

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
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const startedAtRef = useRef<number | null>(null);
  const endedRef = useRef(false);

  useEffect(() => {
    const c = new VoiceClient(agent, {
      onStateChange: setState,
      onTranscript: setTranscript,
      onError: (msg) => setError(msg),
      onSpeakingChange: setAssistantSpeaking,
      onMicLevel: setMicLevel,
    });
    clientRef.current = c;
    startedAtRef.current = Date.now();
    c.start().catch(() => {});
    const interval = setInterval(() => {
      if (startedAtRef.current) setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
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
  const timeUp = seconds >= MAX_SECONDS;
  const turnsUp = userTurns >= MAX_TURNS;
  const shouldAutoEnd = (timeUp || turnsUp) && !assistantSpeaking;

  // Auto-end when either cap is hit and the assistant has finished speaking.
  useEffect(() => {
    if (!shouldAutoEnd || endedRef.current) return;
    endedRef.current = true;
    void handleEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoEnd]);

  async function handleEnd() {
    const c = clientRef.current;
    if (!c) return;
    await c.stop();
    onDoneRef.current(clientRef.current?.getTranscript() ?? transcript);
  }

  function toggleMute() {
    const c = clientRef.current;
    if (!c) return;
    const next = !muted;
    c.setMuted(next);
    setMuted(next);
  }

  const canEnd = userTurns >= 1;

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
            <div className="font-mono text-lg tabular-nums">{formatTime(seconds)} / {formatTime(MAX_SECONDS)}</div>
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
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Mic level</div>
                <button
                  onClick={toggleMute}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold hover-elevate",
                    muted ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-background",
                  )}
                  data-testid="button-mute"
                >
                  {muted ? <><MicOff className="h-3.5 w-3.5" /> Muted</> : <><Mic className="h-3.5 w-3.5" /> Mute</>}
                </button>
              </div>
              <MicMeter level={micLevel} muted={muted} />
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Stat label="Turns" value={`${userTurns} / ${MAX_TURNS}`} warn={turnsUp} />
                <Stat label="Time" value={formatTime(MAX_SECONDS - seconds)} warn={timeUp} />
              </div>
              {(timeUp || turnsUp) && (
                <div className="mt-2 text-xs text-destructive">
                  {turnsUp ? "Turn limit reached" : "Time's up"} — wrapping up…
                </div>
              )}
            </div>
            <div className="rounded-2xl border bg-card p-4 shadow-sm">
              <h4 className="text-sm font-semibold">Guidance</h4>
              <p className="mt-2 text-sm text-muted-foreground">
                Speak naturally — there's no push-to-talk. Pause to let them respond.
              </p>
              <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                <li>· Up to {MAX_TURNS} of your turns or 5 minutes</li>
                <li>· End the call whenever you feel done</li>
                <li>· They react to your style, not just your words</li>
              </ul>
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
          {state === "listening" && !muted ? (
            <><Mic className="h-4 w-4 text-emerald-500" /> Mic live</>
          ) : muted ? (
            <><MicOff className="h-4 w-4 text-destructive" /> Muted</>
          ) : state === "connecting" ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</>
          ) : (
            <><MicOff className="h-4 w-4" /> Mic off</>
          )}
        </div>
        <Button
          size="lg"
          variant="destructive"
          onClick={() => { endedRef.current = true; void handleEnd(); }}
          disabled={!canEnd && state !== "error"}
          data-testid="button-end-call"
        >
          <PhoneOff className="mr-2 h-4 w-4" /> End call
        </Button>
      </footer>
    </div>
  );
}

function MicMeter({ level, muted }: { level: number; muted: boolean }) {
  const pct = Math.round(Math.min(1, Math.max(0, level)) * 100);
  return (
    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted" data-testid="mic-meter">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-75",
          muted ? "bg-destructive/40" : "bg-emerald-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("font-mono text-base tabular-nums", warn && "text-destructive")}>{value}</div>
    </div>
  );
}

function StateBadge({ state }: { state: VoiceState }) {
  const label = { idle: "Idle", connecting: "Connecting…", ready: "Ready", listening: "Listening", closing: "Ending…", closed: "Ended", error: "Error" }[state];
  return (
    <span className={cn(
      "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
      state === "listening" && "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      state === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
    )}>{label}</span>
  );
}

function formatTime(s: number) {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const r = v % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
