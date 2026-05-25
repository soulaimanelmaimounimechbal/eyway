import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, XCircle, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface SmokeResult {
  persona: string;
  ok: boolean;
  voice?: string;
  kind?: string;
  message?: string;
  elapsedMs: number;
}
interface SmokeReport {
  ok: boolean;
  config: { endpointHost: string; model: string; apiVersion: string };
  results: SmokeResult[];
}
interface HealthCheck { name: string; ok: boolean; detail?: string; elapsedMs?: number }
interface HealthReport {
  ok: boolean;
  config: { endpointHost: string; model: string; apiVersion: string };
  checks: HealthCheck[];
}

const BASE = import.meta.env.BASE_URL;

export default function Debug() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [smoke, setSmoke] = useState<SmokeReport | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [smokeErr, setSmokeErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    setHealthErr(null);
    setSmokeErr(null);
    try {
      const r = await fetch(`${BASE}api/voice-live/health`);
      const j = (await r.json()) as HealthReport;
      setHealth(j);
    } catch (err) {
      setHealthErr((err as Error).message);
    }
    try {
      const r = await fetch(`${BASE}api/voice-live/smoke`);
      if (r.status === 404) {
        setSmokeErr("Smoke endpoint disabled in this environment (set VOICE_LIVE_DEBUG_TOKEN and pass X-Debug-Token).");
      } else {
        const j = (await r.json()) as SmokeReport;
        setSmoke(j);
      }
    } catch (err) {
      setSmokeErr((err as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void run(); }, [run]);

  return (
    <div className="mx-auto w-full max-w-4xl p-6 sm:p-10">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Voice Live debug</h1>
        <button
          onClick={() => void run()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm hover-elevate disabled:opacity-60"
          data-testid="button-rerun"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Re-run
        </button>
      </header>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Health</h2>
        <div className="mt-3 rounded-2xl border bg-card p-4 shadow-sm">
          {healthErr && <div className="text-sm text-destructive">{healthErr}</div>}
          {health && (
            <>
              <ConfigLine config={health.config} ok={health.ok} />
              <ul className="mt-3 space-y-2" data-testid="health-checks">
                {health.checks.map((c) => (
                  <li key={`${c.name}-${c.detail ?? ""}`} className="flex items-start gap-3 text-sm">
                    {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" /> : <XCircle className="mt-0.5 h-4 w-4 text-destructive" />}
                    <div className="flex-1">
                      <div className="font-medium">{c.name}</div>
                      {c.detail && <div className="text-xs text-muted-foreground">{c.detail}</div>}
                    </div>
                    {typeof c.elapsedMs === "number" && (
                      <div className="font-mono text-[11px] text-muted-foreground">{c.elapsedMs}ms</div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!health && !healthErr && <div className="text-sm text-muted-foreground">Loading…</div>}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Per-persona smoke</h2>
        <div className="mt-3 rounded-2xl border bg-card p-4 shadow-sm">
          {smokeErr && <div className="text-sm text-destructive">{smokeErr}</div>}
          {smoke && (
            <>
              <ConfigLine config={smoke.config} ok={smoke.ok} />
              <table className="mt-3 w-full text-left text-sm" data-testid="smoke-results">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2">Persona</th>
                    <th className="py-2">Status</th>
                    <th className="py-2">Voice used</th>
                    <th className="py-2">Detail</th>
                    <th className="py-2 text-right">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {smoke.results.map((r) => (
                    <tr key={r.persona} className="border-b last:border-0">
                      <td className="py-2 font-medium">{r.persona}</td>
                      <td className="py-2">
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                          r.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-destructive/10 text-destructive",
                        )}>
                          {r.ok ? "pass" : (r.kind ?? "fail")}
                        </span>
                      </td>
                      <td className="py-2 font-mono text-xs">{r.voice ?? "—"}</td>
                      <td className="py-2 text-xs text-muted-foreground">{r.message ?? ""}</td>
                      <td className="py-2 text-right font-mono text-xs text-muted-foreground">{r.elapsedMs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!smoke && !smokeErr && <div className="text-sm text-muted-foreground">Loading…</div>}
        </div>
      </section>
    </div>
  );
}

function ConfigLine({ config, ok }: { config: { endpointHost: string; model: string; apiVersion: string }; ok: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-destructive/10 text-destructive",
      )}>
        {ok ? "ok" : "degraded"}
      </span>
      <span><span className="font-semibold text-foreground">host</span> {config.endpointHost}</span>
      <span><span className="font-semibold text-foreground">model</span> {config.model}</span>
      <span><span className="font-semibold text-foreground">api</span> {config.apiVersion}</span>
    </div>
  );
}
