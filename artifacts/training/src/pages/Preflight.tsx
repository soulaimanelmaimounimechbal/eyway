import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, type SocialStyle } from "@/lib/agents";
import { runMicCheck, runVoiceProbe } from "@/lib/voice-client";
import { CheckCircle2, XCircle, Loader2, Mic, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type StepStatus = "idle" | "running" | "pass" | "fail";

interface CheckState {
  status: StepStatus;
  detail?: string;
  meta?: string;
}

const INITIAL: CheckState = { status: "idle" };

export default function Preflight({
  style,
  onBack,
  onReady,
}: {
  style: SocialStyle;
  onBack: () => void;
  onReady: () => void;
}) {
  const agent = AGENTS[style];

  const [mic, setMic] = useState<CheckState>(INITIAL);
  const [selfTest, setSelfTest] = useState<CheckState>(INITIAL);
  const [token, setToken] = useState<CheckState>(INITIAL);
  const [probe, setProbe] = useState<CheckState>(INITIAL);
  const [running, setRunning] = useState(false);
  const runRef = useRef(0);

  const allPass =
    mic.status === "pass" &&
    selfTest.status === "pass" &&
    token.status === "pass" &&
    probe.status === "pass";

  const runAll = useCallback(async () => {
    const myRun = ++runRef.current;
    setRunning(true);
    setMic({ status: "running", detail: "Requesting microphone access…" });
    setSelfTest(INITIAL);
    setToken(INITIAL);
    setProbe(INITIAL);

    const micResult = await runMicCheck(0);
    if (myRun !== runRef.current) return;
    if (!micResult.ok && micResult.permission !== "granted") {
      setMic({ status: "fail", detail: micResult.message });
      setRunning(false);
      return;
    }
    setMic({ status: "pass", detail: "Microphone access granted." });

    setSelfTest({ status: "running", detail: "Say a few words — listening for 2 seconds…" });
    const self = await runMicCheck(2000);
    if (myRun !== runRef.current) return;
    if (!self.ok) {
      setSelfTest({
        status: "fail",
        detail: self.message ?? "We didn't pick up your voice.",
        meta: `Peak level ${(self.peakLevel * 100).toFixed(0)}%`,
      });
      setRunning(false);
      return;
    }
    setSelfTest({
      status: "pass",
      detail: "We heard you clearly.",
      meta: `Peak level ${(self.peakLevel * 100).toFixed(0)}%`,
    });

    setToken({ status: "running", detail: "Minting a session token…" });
    try {
      const r = await fetch("/api/voice-live/token", { method: "POST" });
      if (myRun !== runRef.current) return;
      if (!r.ok) {
        setToken({ status: "fail", detail: `Token request failed (HTTP ${r.status}).` });
        setRunning(false);
        return;
      }
      const j = (await r.json()) as { token?: string };
      if (!j.token) {
        setToken({ status: "fail", detail: "Token response was missing the token." });
        setRunning(false);
        return;
      }
      setToken({ status: "pass", detail: "Session token minted." });
    } catch (err) {
      if (myRun !== runRef.current) return;
      setToken({ status: "fail", detail: (err as Error).message || "Could not reach the server." });
      setRunning(false);
      return;
    }

    setProbe({ status: "running", detail: `Checking voice "${agent.voice.split(":")[0]}" with Azure…` });
    const p = await runVoiceProbe(agent);
    if (myRun !== runRef.current) return;
    if (!p.ok) {
      const hint =
        p.kind === "config"
          ? "Setup issue with the persona's voice. Try a different persona or contact your admin."
          : p.kind === "transient"
            ? "The voice service is temporarily unavailable. Retry in a moment."
            : "Could not reach the voice service.";
      setProbe({ status: "fail", detail: `${hint} (${p.message ?? "no details"})` });
      setRunning(false);
      return;
    }
    setProbe({
      status: "pass",
      detail: "Voice service reachable.",
      meta: p.voice && p.voice !== agent.voice ? `Using fallback: ${p.voice.split(":")[0]}` : undefined,
    });
    setRunning(false);
  }, [agent]);

  // Auto-run once on mount.
  useEffect(() => {
    void runAll();
    return () => { runRef.current++; };
  }, [runAll]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1" data-testid="button-back">← Back</button>
        <ProgressDots step={4} total={8} label="Step 5 of 8 · Pre-flight" />
      </header>

      <main className="flex-1 py-8">
        <div className={cn("rounded-2xl border bg-gradient-to-br p-5 shadow-sm", agent.accent)}>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{agent.headline} client</div>
          <div className="mt-1 text-xl font-semibold">{agent.name}</div>
          <div className="text-sm text-muted-foreground">{agent.role}</div>
        </div>

        <h1 className="mt-8 text-2xl font-semibold sm:text-3xl">Quick pre-flight check</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Before we connect you, let's make sure your mic works and the voice service is reachable. Takes a few seconds.
        </p>

        <ol className="mt-6 space-y-3" data-testid="preflight-list">
          <CheckRow index={1} title="Microphone permission" state={mic} icon={<Mic className="h-4 w-4" />} testId="check-mic" />
          <CheckRow index={2} title="Mic self-test (2-second listen)" state={selfTest} testId="check-self-test" />
          <CheckRow index={3} title="Session token" state={token} testId="check-token" />
          <CheckRow index={4} title="Voice service probe" state={probe} testId="check-probe" />
        </ol>

        {!running && !allPass && (
          <div className="mt-5 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
            <div>
              At least one check failed. Fix the issue and re-run, or pick a different persona.
            </div>
          </div>
        )}
      </main>

      <footer className="flex items-center justify-between gap-3 pt-6">
        <Button
          variant="outline"
          onClick={() => { void runAll(); }}
          disabled={running}
          data-testid="button-retest"
        >
          {running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Running…</> : "Re-run checks"}
        </Button>
        <Button
          size="lg"
          onClick={onReady}
          disabled={!allPass || running}
          data-testid="button-start-call"
        >
          Start call
        </Button>
      </footer>
    </div>
  );
}

function CheckRow({
  index,
  title,
  state,
  icon,
  testId,
}: {
  index: number;
  title: string;
  state: CheckState;
  icon?: React.ReactNode;
  testId: string;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-xl border bg-card p-4 shadow-sm",
        state.status === "fail" && "border-destructive/40 bg-destructive/5",
        state.status === "pass" && "border-emerald-500/30",
      )}
      data-testid={testId}
      data-status={state.status}
    >
      <div className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full border bg-background text-xs font-semibold">
        {state.status === "pass" ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        ) : state.status === "fail" ? (
          <XCircle className="h-5 w-5 text-destructive" />
        ) : state.status === "running" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <span>{index}</span>
        )}
      </div>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          {icon}
          <div className="text-sm font-semibold">{title}</div>
          {state.meta && (
            <span className="ml-1 rounded-full border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {state.meta}
            </span>
          )}
        </div>
        {state.detail && (
          <div className={cn("mt-1 text-xs", state.status === "fail" ? "text-destructive" : "text-muted-foreground")}>
            {state.detail}
          </div>
        )}
      </div>
    </li>
  );
}
