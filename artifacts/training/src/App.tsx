import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Intro from "@/pages/Intro";
import Scenario from "@/pages/Scenario";
import SelectClient from "@/pages/SelectClient";
import Preflight from "@/pages/Preflight";
import Conversation from "@/pages/Conversation";
import Analyzing from "@/pages/Analyzing";
import Outcome, { type Tier } from "@/pages/Outcome";
import Summary from "@/pages/Summary";
import Debug from "@/pages/Debug";
import { AGENTS, DEFAULT_INTENSITY, type Intensity, type SocialStyle } from "@/lib/agents";
import { scoreTranscript, type TranscriptEntry } from "@/lib/voice-client";
import { evaluateConversation, type AiAssessment } from "@/lib/assessment";
import { saveTrainingSession } from "@/lib/session-store";

const queryClient = new QueryClient();

type Step =
  | "intro"
  | "scenario"
  | "select"
  | "preflight"
  | "conversation"
  | "analyzing"
  | "outcome"
  | "summary";

interface SessionResult {
  tier: Tier;
  hits: string[];
  userTurns: number;
  transcript: TranscriptEntry[];
  assessment?: AiAssessment;
}

function App() {
  // Hidden debug page: only mounts when ?debug=1 is present so it never
  // accidentally ships in the user flow.
  const isDebug = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("debug") === "1";
  const [step, setStep] = useState<Step>("intro");
  const [style, setStyle] = useState<SocialStyle | null>(null);
  const intensity: Intensity = DEFAULT_INTENSITY;
  const [result, setResult] = useState<SessionResult | null>(null);

  // Guard: if we land on a step that requires state we don't have, navigate
  // back to the right place via effect (not during render).
  useEffect(() => {
    if ((step === "conversation" || step === "preflight" || step === "analyzing") && !style) {
      setStep("select");
    }
    if ((step === "outcome" || step === "summary") && (!style || !result)) setStep("select");
  }, [step, style, result]);

  const content = useMemo(() => {
    switch (step) {
      case "intro":
        return <Intro onNext={() => setStep("scenario")} />;
      case "scenario":
        return <Scenario onBack={() => setStep("intro")} onNext={() => setStep("select")} />;
      case "select":
        return (
          <SelectClient
            selected={style}
            onSelect={setStyle}
            onBack={() => setStep("scenario")}
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
              // Show the analyzing screen while the LLM evaluates the call.
              setStep("analyzing");
              void (async () => {
                let assessment: AiAssessment | null = null;
                try {
                  assessment = await evaluateConversation({ style, intensity, transcript });
                } catch {
                  assessment = null;
                }
                // AI tier wins when available; otherwise fall back to the
                // deterministic scorer's tier.
                const tier = assessment?.tier ?? scored.tier;
                setResult({
                  tier,
                  hits: scored.hits,
                  userTurns: scored.userTurns,
                  transcript,
                  assessment: assessment ?? undefined,
                });
                saveTrainingSession({
                  style,
                  intensity,
                  tier,
                  userTurns: scored.userTurns,
                  avgWords: scored.avgWords,
                  hits: scored.hits,
                  durationMs,
                  transcript,
                  assessment,
                });
                setStep("outcome");
              })();
            }}
          />
        );
      case "analyzing":
        if (!style) return null;
        return <Analyzing style={style} />;
      case "outcome":
        if (!style || !result) return null;
        return (
          <Outcome
            style={style}
            tier={result.tier}
            hits={result.hits}
            userTurns={result.userTurns}
            transcript={result.transcript}
            assessment={result.assessment}
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
  }, [step, style, intensity, result]);

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
