import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Intro from "@/pages/Intro";
import Scenario from "@/pages/Scenario";
import SelfReflection, { type SelfReflectionData } from "@/pages/SelfReflection";
import SelectClient from "@/pages/SelectClient";
import Preflight from "@/pages/Preflight";
import Conversation from "@/pages/Conversation";
import Outcome, { type Tier } from "@/pages/Outcome";
import Summary from "@/pages/Summary";
import Debug from "@/pages/Debug";
import { AGENTS, DEFAULT_INTENSITY, type Intensity, type SocialStyle } from "@/lib/agents";
import { scoreTranscript, type TranscriptEntry } from "@/lib/voice-client";
import { saveTrainingSession } from "@/lib/session-store";

const queryClient = new QueryClient();

type Step =
  | "intro"
  | "scenario"
  | "self"
  | "select"
  | "preflight"
  | "conversation"
  | "outcome"
  | "summary";

interface SessionResult {
  tier: Tier;
  hits: string[];
  userTurns: number;
  transcript: TranscriptEntry[];
}

function App() {
  // Hidden debug page: only mounts when ?debug=1 is present so it never
  // accidentally ships in the user flow.
  const isDebug = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("debug") === "1";
  const [step, setStep] = useState<Step>("intro");
  const [selfData, setSelfData] = useState<SelfReflectionData>({ selfStyle: "", note: "" });
  const [style, setStyle] = useState<SocialStyle | null>(null);
  const [intensity, setIntensity] = useState<Intensity>(DEFAULT_INTENSITY);
  const [result, setResult] = useState<SessionResult | null>(null);

  // Guard: if we land on a step that requires state we don't have, navigate
  // back to the right place via effect (not during render).
  useEffect(() => {
    if ((step === "conversation" || step === "preflight") && !style) setStep("select");
    if ((step === "outcome" || step === "summary") && (!style || !result)) setStep("select");
  }, [step, style, result]);

  const content = useMemo(() => {
    switch (step) {
      case "intro":
        return <Intro onNext={() => setStep("scenario")} />;
      case "scenario":
        return <Scenario onBack={() => setStep("intro")} onNext={() => setStep("self")} />;
      case "self":
        return (
          <SelfReflection
            initial={selfData}
            onBack={() => setStep("scenario")}
            onNext={(d) => { setSelfData(d); setStep("select"); }}
          />
        );
      case "select":
        return (
          <SelectClient
            selected={style}
            onSelect={setStyle}
            intensity={intensity}
            onIntensityChange={setIntensity}
            onBack={() => setStep("self")}
            onNext={() => style && setStep("preflight")}
          />
        );
      case "preflight":
        if (!style) return null;
        return (
          <Preflight
            style={style}
            onBack={() => setStep("select")}
            onReady={() => setStep("conversation")}
          />
        );
      case "conversation":
        if (!style) return null;
        return (
          <Conversation
            style={style}
            intensity={intensity}
            onBack={() => setStep("preflight")}
            onDone={(transcript: TranscriptEntry[], durationMs: number) => {
              const agent = AGENTS[style];
              const scored = scoreTranscript(transcript, style, agent.keywords);
              setResult({ ...scored, transcript });
              saveTrainingSession({
                style,
                intensity,
                selfReportedStyle: selfData.selfStyle || undefined,
                selfNote: selfData.note || undefined,
                tier: scored.tier,
                userTurns: scored.userTurns,
                avgWords: scored.avgWords,
                hits: scored.hits,
                durationMs,
                transcript,
              });
              setStep("outcome");
            }}
          />
        );
      case "outcome":
        if (!style || !result) return null;
        return (
          <Outcome
            style={style}
            tier={result.tier}
            hits={result.hits}
            userTurns={result.userTurns}
            transcript={result.transcript}
            onNext={() => setStep("summary")}
            onTrySame={() => { setResult(null); setStep("preflight"); }}
            onTryDifferent={() => { setResult(null); setStyle(null); setStep("select"); }}
          />
        );
      case "summary":
        if (!style || !result) return null;
        return (
          <Summary
            style={style}
            tier={result.tier}
            onRestart={() => {
              setStyle(null);
              setResult(null);
              setStep("select");
            }}
          />
        );
    }
  }, [step, selfData, style, intensity, result]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="min-h-screen bg-background text-foreground">{isDebug ? <Debug /> : content}</div>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
