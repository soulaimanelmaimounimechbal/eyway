import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProgressDots } from "@/components/ProgressDots";
import { AGENTS, DEFAULT_INTENSITY, type Intensity, type SocialStyle } from "@/lib/agents";
import { VoiceClient, type TranscriptEntry, type VoiceState } from "@/lib/voice-client";
import { Mic, MicOff, PhoneOff, Loader2, MessageSquareWarning, Lightbulb, X, Hand, MousePointerClick } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  evaluateTurn,
  pickNudge,
  TURN_SIGNAL_CLASSES,
  type CoachingNudge,
  type TurnEvaluation,
} from "@/lib/coaching";
import { emit } from "@/lib/telemetry";

const MAX_TURNS = 10;
const MAX_SECONDS = 300;
const WARN_SECONDS = 30;

type PttMode = "hold" | "tap";
const PTT_MODE_KEY = "training.pttMode";
function loadPttMode(): PttMode {
  try {
    const v = localStorage.getItem(PTT_MODE_KEY);
    if (v === "hold" || v === "tap") return v;
  } catch { /* noop */ }
  return "hold";
}

type EndReason = "manual" | "back" | "time_up" | "turns_up" | "terminal";

export default function Conversation({
  style,
  intensity = DEFAULT_INTENSITY,
  onDone,
  onBack,
}: {
  style: SocialStyle;
  intensity?: Intensity;
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
  const [warning, setWarning] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [micLevel, setMicLevel] = useState(0);
  const [assistantLevel, setAssistantLevel] = useState(0);
  const [silenceHint, setSilenceHint] = useState(false);
  const [micActive, setMicActive] = useState(false);
  const [pttMode, setPttMode] = useState<PttMode>(loadPttMode);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const micEngagedAtRef = useRef<number | null>(null);
  const turnIndexRef = useRef(0);
  const [warningShownAt30s, setWarningShownAt30s] = useState(false);
  const [showSignals, setShowSignals] = useState(true);
  const [nudge, setNudge] = useState<CoachingNudge | null>(null);
  const firedNudgesRef = useRef<Set<string>>(new Set());
  const lastNudgeAtRef = useRef(0);
  const nudgeDismissTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const endedRef = useRef(false);
  const firstAudioEmittedRef = useRef(false);
  const wasReconnectingRef = useRef(false);

  useEffect(() => {
    const c = new VoiceClient(agent, intensity, {
      onStateChange: (s) => {
        setState(s);
        if (s === "listening" || s === "reconnecting") setError(null);
        if (s === "reconnecting" && !wasReconnectingRef.current) {
          wasReconnectingRef.current = true;
          emit("reconnect_attempted", { persona: style });
        } else if (wasReconnectingRef.current && (s === "listening" || s === "ready")) {
          wasReconnectingRef.current = false;
          emit("reconnect_succeeded", { persona: style });
        }
      },
      onTranscript: setTranscript,
      onError: (msg, kind) => {
        if (kind === "config") {
          setError(`Setup issue — try a different persona or contact your admin. (${msg})`);
        } else if (kind === "lost_connection") {
          setError(`Connection lost — review what we captured. (${msg})`);
        } else {
          setError(msg);
        }
        emit("error", { kind: kind ?? "fatal", message: msg, persona: style });
      },
      onWarning: (msg, kind) => {
        setWarning(msg);
        window.setTimeout(() => setWarning((cur) => (cur === msg ? null : cur)), 4000);
        if (kind === "voice_fallback") {
          // Message looks like "voice fell back to <name>"; extract the target
          // voice for telemetry without parsing.
          const to = msg.split("voice fell back to ").pop()?.trim() ?? "";
          emit("voice_fallback", { from: agent.voice, to, persona: style });
        }
      },
      onSpeakingChange: setAssistantSpeaking,
      onMicLevel: setMicLevel,
      onAssistantLevel: (level) => {
        setAssistantLevel(level);
        if (!firstAudioEmittedRef.current && level > 0 && startedAtRef.current) {
          firstAudioEmittedRef.current = true;
          emit("first_audio_ms", { ms: Date.now() - startedAtRef.current, persona: style });
        }
      },
      onSilenceHint: setSilenceHint,
    });
    clientRef.current = c;
    startedAtRef.current = Date.now();
    emit("call_started", { persona: style, voice: agent.voice, intensity });
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

  const completedUserTurns = useMemo(
    () => transcript.filter((t) => t.role === "user" && t.done && t.text.trim()),
    [transcript],
  );
  const userTurns = completedUserTurns.length;

  // Per-turn evaluations (memoised so the transcript map doesn't recompute
  // for every animation-frame state change).
  const turnEvalsByText = useMemo(() => {
    const m = new Map<string, TurnEvaluation>();
    for (const t of completedUserTurns) m.set(t.text, evaluateTurn(t, agent));
    return m;
  }, [completedUserTurns, agent]);

  // Coaching nudge: fire after every 2 user turns when the last two were
  // both off-style, with a 30s cool-down and never repeat the same nudge.
  useEffect(() => {
    if (userTurns < 2 || userTurns % 2 !== 0) return;
    if (assistantSpeaking) return; // wait until the assistant has finished
    if (nudge) return; // one nudge on screen at a time
    if (Date.now() - lastNudgeAtRef.current < 30_000) return;
    const candidate = pickNudge(completedUserTurns, agent, firedNudgesRef.current);
    if (!candidate) return;
    firedNudgesRef.current.add(candidate.id);
    lastNudgeAtRef.current = Date.now();
    setNudge(candidate);
    if (nudgeDismissTimerRef.current) window.clearTimeout(nudgeDismissTimerRef.current);
    nudgeDismissTimerRef.current = window.setTimeout(() => {
      setNudge(null);
      nudgeDismissTimerRef.current = null;
    }, 12_000);
  }, [userTurns, assistantSpeaking, nudge, completedUserTurns, agent]);

  useEffect(() => {
    return () => {
      if (nudgeDismissTimerRef.current) window.clearTimeout(nudgeDismissTimerRef.current);
    };
  }, []);

  function dismissNudge() {
    setNudge(null);
    if (nudgeDismissTimerRef.current) {
      window.clearTimeout(nudgeDismissTimerRef.current);
      nudgeDismissTimerRef.current = null;
    }
  }
  const remaining = Math.max(0, MAX_SECONDS - seconds);
  const timeUp = remaining <= 0;
  const turnsUp = userTurns >= MAX_TURNS;
  const inWarningZone = remaining > 0 && remaining <= WARN_SECONDS;
  const shouldAutoEnd = (timeUp || turnsUp) && !assistantSpeaking;
  const isTerminal = state === "closed" || state === "error";

  const endCall = useCallback(async (reason: EndReason) => {
    if (endedRef.current) return;
    endedRef.current = true;
    const finalTranscript = clientRef.current?.getTranscript() ?? transcript;
    const turns = finalTranscript.filter((t) => t.role === "user" && t.done && t.text.trim()).length;
    const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
    emit("call_ended", { reason, turns, durationMs, persona: style });
    const c = clientRef.current;
    if (c) await c.stop();
    onDoneRef.current(finalTranscript);
  }, [transcript, style]);

  // Surface the 30-second warning toast once.
  useEffect(() => {
    if (inWarningZone && !warningShownAt30s) {
      setWarningShownAt30s(true);
      setWarning("30 seconds left — wrap up your final point");
      window.setTimeout(() => {
        setWarning((cur) => (cur && cur.startsWith("30 seconds left") ? null : cur));
      }, 4000);
    }
  }, [inWarningZone, warningShownAt30s]);

  // Auto-end when either cap is hit and assistant has finished speaking.
  useEffect(() => {
    if (!shouldAutoEnd) return;
    void endCall(timeUp ? "time_up" : "turns_up");
  }, [shouldAutoEnd, timeUp, endCall]);

  const engageMic = useCallback(() => {
    const c = clientRef.current;
    if (!c || micActive) return;
    if (assistantSpeaking || state !== "listening") return;
    c.engageMic();
    setMicActive(true);
    micEngagedAtRef.current = Date.now();
    turnIndexRef.current += 1;
    emit("mic_engaged", { turnIndex: turnIndexRef.current, persona: style });
  }, [micActive, assistantSpeaking, state, style]);

  const releaseMic = useCallback(() => {
    const c = clientRef.current;
    if (!c || !micActive) return;
    c.releaseMic();
    setMicActive(false);
    const startedAt = micEngagedAtRef.current;
    micEngagedAtRef.current = null;
    const durationMs = startedAt ? Date.now() - startedAt : 0;
    emit("mic_released", { turnIndex: turnIndexRef.current, durationMs, persona: style });
  }, [micActive, style]);

  // Persist push-to-talk mode choice across sessions.
  useEffect(() => {
    try { localStorage.setItem(PTT_MODE_KEY, pttMode); } catch { /* noop */ }
  }, [pttMode]);

  // Switching modes mid-call must not leave the mic stuck open.
  useEffect(() => {
    if (micActive) releaseMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pttMode]);

  // Space-bar hold binding (hold-to-talk mode only). Ignore when the user
  // is typing in a text field or the call isn't in a usable state.
  useEffect(() => {
    if (pttMode !== "hold") return;
    const isTypingTarget = (t: EventTarget | null) => {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      engageMic();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      releaseMic();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [pttMode, engageMic, releaseMic]);

  // Auto-release if the call goes away or the assistant starts speaking
  // (the user has clearly finished their turn).
  useEffect(() => {
    if (micActive && (assistantSpeaking || state !== "listening")) {
      releaseMic();
    }
  }, [micActive, assistantSpeaking, state, releaseMic]);

  function toggleTap() {
    if (micActive) releaseMic();
    else engageMic();
  }

  function requestEnd(reason: EndReason) {
    if (isTerminal || userTurns >= 2) {
      void endCall(reason);
      return;
    }
    setConfirmEnd(true);
  }

  function handleBack() {
    // Back is no longer a silent escape — it always routes through endCall so
    // we never lose the captured transcript. endCall ends the session and
    // navigates to Outcome via onDone, so we must NOT also call onBack() (that
    // would race the navigation and yank the user off the Outcome screen).
    // Same confirm gating as the End CTA: skip only when terminal or ≥2 turns.
    if (isTerminal || userTurns >= 2) {
      void endCall("back");
      return;
    }
    setConfirmEnd(true);
  }

  const pinnedAssistantText = useMemo(() => {
    if (!assistantSpeaking) return null;
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].role === "assistant") return transcript[i].text;
    }
    return null;
  }, [transcript, assistantSpeaking]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col p-6 sm:p-10">
      <header className="flex items-center justify-between gap-3">
        <button
          onClick={handleBack}
          className="text-sm text-muted-foreground hover-elevate rounded px-2 py-1"
          data-testid="button-back"
        >
          ← Back
        </button>
        <ProgressDots step={4} total={8} label="Step 5 of 8" />
        <Button
          size="sm"
          variant="destructive"
          onClick={() => requestEnd("manual")}
          data-testid="button-end-call-header"
          className="gap-2"
        >
          <PhoneOff className="h-4 w-4" />
          End call &amp; get feedback
        </Button>
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
            <div
              className={cn(
                "font-mono text-lg tabular-nums",
                inWarningZone && "text-amber-600 dark:text-amber-400",
                timeUp && "text-destructive",
              )}
              data-testid="call-timer"
            >
              {formatTime(seconds)} / {formatTime(MAX_SECONDS)}
            </div>
          </div>
        </div>

        <CallStateBadge state={state} assistantSpeaking={assistantSpeaking} micActive={micActive} pttMode={pttMode} />

        <div className="grid flex-1 gap-4 md:grid-cols-[1fr_300px]">
          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <div className="flex h-full max-h-[55vh] flex-col">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">Live transcript</h3>
                <div className="flex items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-muted-foreground" data-testid="toggle-signals">
                    <input
                      type="checkbox"
                      className="h-3 w-3 cursor-pointer accent-primary"
                      checked={showSignals}
                      onChange={(e) => setShowSignals(e.target.checked)}
                    />
                    Show signals
                  </label>
                  <AssistantVisualizer level={assistantLevel} active={assistantSpeaking} />
                </div>
              </div>
              <div className="flex-1 space-y-3 overflow-y-auto pr-2" data-testid="transcript-list">
                {transcript.length === 0 && (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    Connecting and warming up your microphone…
                  </div>
                )}
                {transcript.map((t, i) => {
                  const evalForTurn = t.role === "user" && t.done ? turnEvalsByText.get(t.text) : undefined;
                  const sig = evalForTurn?.signal;
                  return (
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
                      <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-70">
                        {showSignals && sig && (
                          <span
                            className={cn("inline-block h-1.5 w-1.5 rounded-full", TURN_SIGNAL_CLASSES[sig].dot)}
                            data-testid={`turn-signal-${sig}`}
                            title={`Signal: ${TURN_SIGNAL_CLASSES[sig].label}`}
                          />
                        )}
                        <span>{t.role === "assistant" ? agent.name : "You"}</span>
                      </div>
                      {t.text || "…"}
                    </div>
                  );
                })}
                <div ref={transcriptEndRef} />
              </div>
              {pinnedAssistantText && (
                <div
                  className="mt-3 rounded-xl border-2 border-primary/30 bg-primary/5 p-4 shadow-inner"
                  data-testid="pinned-utterance"
                  style={{
                    boxShadow: `0 0 0 ${Math.round(assistantLevel * 6)}px hsl(var(--primary) / ${0.08 + assistantLevel * 0.18})`,
                    transition: "box-shadow 80ms linear",
                  }}
                >
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-primary/80">
                    {agent.name} · speaking
                  </div>
                  <div className="text-base font-medium leading-snug">{pinnedAssistantText}</div>
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wider text-muted-foreground">Your mic</div>
                <div
                  className="inline-flex overflow-hidden rounded-full border text-[11px] font-semibold"
                  role="radiogroup"
                  aria-label="Push-to-talk mode"
                  data-testid="ptt-mode-toggle"
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={pttMode === "hold"}
                    onClick={() => setPttMode("hold")}
                    className={cn(
                      "inline-flex items-center gap-1 px-2.5 py-1 hover-elevate",
                      pttMode === "hold" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground",
                    )}
                    data-testid="button-ptt-mode-hold"
                  >
                    <Hand className="h-3 w-3" /> Hold
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={pttMode === "tap"}
                    onClick={() => setPttMode("tap")}
                    className={cn(
                      "inline-flex items-center gap-1 px-2.5 py-1 hover-elevate",
                      pttMode === "tap" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground",
                    )}
                    data-testid="button-ptt-mode-tap"
                  >
                    <MousePointerClick className="h-3 w-3" /> Tap
                  </button>
                </div>
              </div>
              <PushToTalkButton
                mode={pttMode}
                micActive={micActive}
                disabled={state !== "listening" || assistantSpeaking}
                onEngage={engageMic}
                onRelease={releaseMic}
                onTapToggle={toggleTap}
              />
              <MicVisualizer level={micLevel} muted={!micActive} />
              {silenceHint && micActive && (
                <div
                  className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-100"
                  data-testid="silence-hint"
                >
                  <MessageSquareWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>We're not picking up your voice — speak up or check your mic.</span>
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Stat label="Turns" value={`${userTurns} / ${MAX_TURNS}`} warn={turnsUp} />
                <Stat
                  label="Time"
                  value={formatTime(remaining)}
                  warn={timeUp}
                  amber={inWarningZone}
                />
              </div>
              {(timeUp || turnsUp) && (
                <div className="mt-2 text-xs text-destructive">
                  {turnsUp ? "Turn limit reached" : "Time's up"} — wrapping up…
                </div>
              )}
            </div>
            {nudge ? (
              <div
                className="rounded-2xl border border-primary/40 bg-primary/5 p-4 shadow-sm"
                data-testid="coaching-nudge"
                data-nudge-id={nudge.id}
                role="status"
                aria-live="polite"
              >
                <div className="flex items-start gap-2">
                  <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="flex-1">
                    <div className="text-xs font-semibold uppercase tracking-wider text-primary">Coaching nudge</div>
                    <p className="mt-1 text-sm leading-snug text-foreground">{nudge.text}</p>
                  </div>
                  <button
                    onClick={dismissNudge}
                    className="rounded p-1 text-muted-foreground hover-elevate"
                    aria-label="Dismiss nudge"
                    data-testid="button-dismiss-nudge"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border bg-card p-4 shadow-sm">
                <h4 className="text-sm font-semibold">Guidance</h4>
                <p className="mt-2 text-sm text-muted-foreground">
                  {pttMode === "hold"
                    ? "Hold the Speak button (or press and hold Space) while you talk. Release when you're done."
                    : "Tap to start speaking, tap again when you're done."}
                </p>
                <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                  <li>· Up to {MAX_TURNS} of your turns or 5 minutes</li>
                  <li>· End the call whenever you feel done</li>
                  <li>· They react to your style, not just your words</li>
                </ul>
              </div>
            )}
          </aside>
        </div>

        {warning && (
          <div
            className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100"
            data-testid="warning-banner"
          >
            {warning}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" data-testid="error-banner">
            {error}
          </div>
        )}
      </main>

      <footer className="flex items-center justify-between pt-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {state === "connecting" ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Connecting…</>
          ) : micActive ? (
            <><Mic className="h-4 w-4 text-emerald-500" /> Mic live</>
          ) : state === "listening" ? (
            <><MicOff className="h-4 w-4" /> {pttMode === "hold" ? "Mic off — hold to speak" : "Mic off — tap to speak"}</>
          ) : (
            <><MicOff className="h-4 w-4" /> Mic off</>
          )}
        </div>
        <Button
          size="lg"
          variant="destructive"
          onClick={() => requestEnd("manual")}
          data-testid="button-end-call"
        >
          <PhoneOff className="mr-2 h-4 w-4" />
          {isTerminal && userTurns === 0 ? "Review what we captured" : "End call & get feedback"}
        </Button>
      </footer>

      {confirmEnd && (
        <ConfirmEndDialog
          userTurns={userTurns}
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false);
            void endCall("manual");
          }}
        />
      )}
    </div>
  );
}

function ConfirmEndDialog({
  userTurns,
  onCancel,
  onConfirm,
}: { userTurns: number; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      data-testid="confirm-end-dialog"
    >
      <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-xl">
        <h3 className="text-lg font-semibold">End the call already?</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {userTurns === 0
            ? "You haven't spoken yet — we won't have anything to score. End anyway?"
            : "You've only had one exchange. Feedback gets sharper after a few more turns."}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} data-testid="button-cancel-end">
            Keep going
          </Button>
          <Button variant="destructive" onClick={onConfirm} data-testid="button-confirm-end">
            End anyway
          </Button>
        </div>
      </div>
    </div>
  );
}

function PushToTalkButton({
  mode,
  micActive,
  disabled,
  onEngage,
  onRelease,
  onTapToggle,
}: {
  mode: PttMode;
  micActive: boolean;
  disabled: boolean;
  onEngage: () => void;
  onRelease: () => void;
  onTapToggle: () => void;
}) {
  // Pointer-based hold: we attach pointerup/cancel to window so a release
  // outside the button still ends the turn — otherwise dragging off the
  // button would strand the mic open.
  useEffect(() => {
    if (mode !== "hold" || !micActive) return;
    const end = () => onRelease();
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, [mode, micActive, onRelease]);

  const baseClass =
    "mt-3 flex w-full select-none items-center justify-center gap-2 rounded-2xl border-2 px-4 py-4 text-sm font-semibold transition-colors";
  const stateClass = disabled
    ? "cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60"
    : micActive
    ? "border-emerald-500 bg-emerald-500 text-white shadow-md"
    : "border-primary/40 bg-primary/5 text-primary hover-elevate";

  const label = disabled
    ? "Mic unavailable"
    : micActive
    ? mode === "hold" ? "Listening… release to send" : "Listening… tap to send"
    : mode === "hold" ? "Hold to speak" : "Tap to speak";
  const hint = mode === "hold" ? "or hold Space" : null;

  if (mode === "hold") {
    return (
      <button
        type="button"
        disabled={disabled}
        onPointerDown={(e) => { if (disabled) return; e.preventDefault(); onEngage(); }}
        // pointerup handled at window level (see effect above) so releases
        // outside the button bounds still commit the turn.
        onContextMenu={(e) => e.preventDefault()}
        className={cn(baseClass, stateClass)}
        data-testid="button-ptt-hold"
        data-active={micActive}
        aria-pressed={micActive}
      >
        {micActive ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
        <span>{label}</span>
        {hint && !micActive && <span className="ml-1 text-[10px] font-normal opacity-70">({hint})</span>}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { if (!disabled) onTapToggle(); }}
      className={cn(baseClass, stateClass)}
      data-testid="button-ptt-tap"
      data-active={micActive}
      aria-pressed={micActive}
    >
      {micActive ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
      <span>{label}</span>
    </button>
  );
}

function MicVisualizer({ level, muted }: { level: number; muted: boolean }) {
  // Five bars whose heights are clamped slices of the rolling level, with a
  // small per-bar offset so the silhouette feels alive instead of flat.
  const bars = [0.6, 0.9, 1.1, 0.85, 0.55];
  return (
    <div
      className="mt-2 flex h-10 items-end justify-center gap-1"
      data-testid="mic-visualizer"
      data-level={Math.round(level * 100)}
    >
      {bars.map((mult, i) => {
        const h = Math.max(8, Math.min(100, Math.round(level * 120 * mult)));
        return (
          <span
            key={i}
            className={cn(
              "w-1.5 rounded-full transition-[height] duration-75",
              muted ? "bg-destructive/30" : "bg-emerald-500/70",
            )}
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}

function AssistantVisualizer({ level, active }: { level: number; active: boolean }) {
  const bars = [0.5, 0.8, 1, 0.8, 0.5];
  return (
    <div
      className="flex h-6 items-end gap-0.5"
      data-testid="assistant-visualizer"
      aria-hidden
    >
      {bars.map((mult, i) => {
        const h = active ? Math.max(10, Math.min(100, Math.round(level * 140 * mult))) : 10;
        return (
          <span
            key={i}
            className={cn(
              "w-1 rounded-full transition-[height] duration-100",
              active ? "bg-primary" : "bg-muted-foreground/30",
            )}
            style={{ height: `${h}%` }}
          />
        );
      })}
    </div>
  );
}

function Stat({
  label,
  value,
  warn,
  amber,
}: { label: string; value: string; warn?: boolean; amber?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-mono text-base tabular-nums",
          amber && !warn && "text-amber-600 dark:text-amber-400",
          warn && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function CallStateBadge({
  state,
  assistantSpeaking,
  micActive,
  pttMode,
}: { state: VoiceState; assistantSpeaking: boolean; micActive: boolean; pttMode: PttMode }) {
  // Effective label collapses the underlying state machine into the
  // user-meaningful modes. With push-to-talk the mic is muted by default,
  // so the "ready to listen" idle state is the dominant one between turns.
  let label = "Idle";
  let tone: "neutral" | "live" | "thinking" | "speaking" | "warn" | "bad" = "neutral";
  let pulse = false;

  if (state === "connecting") { label = "Connecting…"; tone = "thinking"; pulse = true; }
  else if (state === "reconnecting") { label = "Reconnecting…"; tone = "warn"; pulse = true; }
  else if (state === "closing") { label = "Ending…"; tone = "neutral"; }
  else if (state === "closed") { label = "Call ended"; tone = "neutral"; }
  else if (state === "error") { label = "Connection error"; tone = "bad"; }
  else if (assistantSpeaking) { label = "Speaking"; tone = "speaking"; pulse = true; }
  else if (state === "listening" || state === "ready") {
    if (micActive) { label = "Listening…"; tone = "live"; pulse = true; }
    else { label = pttMode === "hold" ? "Mic off — hold to speak" : "Mic off — tap to speak"; tone = "neutral"; }
  }

  const toneClass = {
    neutral: "border-border bg-muted text-muted-foreground",
    live: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    thinking: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    speaking: "border-primary/40 bg-primary/10 text-primary",
    warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    bad: "border-destructive/40 bg-destructive/10 text-destructive",
  }[tone];

  const dotClass = {
    neutral: "bg-muted-foreground/50",
    live: "bg-emerald-500",
    thinking: "bg-sky-500",
    speaking: "bg-primary",
    warn: "bg-amber-500",
    bad: "bg-destructive",
  }[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2.5 self-start rounded-full border px-4 py-1.5 text-sm font-semibold shadow-sm",
        toneClass,
      )}
      data-testid="call-state-badge"
      data-state={state}
    >
      <span className="relative inline-flex h-2.5 w-2.5">
        {pulse && (
          <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-70", dotClass)} />
        )}
        <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", dotClass)} />
      </span>
      <span className="tracking-wide">{label}</span>
    </div>
  );
}

function formatTime(s: number) {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const r = v % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
