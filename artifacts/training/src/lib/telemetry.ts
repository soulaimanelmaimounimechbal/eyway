// Client-side structured telemetry. Compact JSON events posted to the
// server at key moments in the user-facing flow. No PII, no transcripts.
//
// Transport: navigator.sendBeacon when available (best-effort, survives
// page unload), falling back to fetch with keepalive. We never await the
// post and we never throw — telemetry must not break the product.

export type TelemetryEvent =
  | "preflight_started"
  | "preflight_passed"
  | "preflight_failed"
  | "call_started"
  | "first_audio_ms"
  | "voice_fallback"
  | "reconnect_attempted"
  | "reconnect_succeeded"
  | "call_ended"
  | "error";

const ALLOWED: Record<TelemetryEvent, true> = {
  preflight_started: true,
  preflight_passed: true,
  preflight_failed: true,
  call_started: true,
  first_audio_ms: true,
  voice_fallback: true,
  reconnect_attempted: true,
  reconnect_succeeded: true,
  call_ended: true,
  error: true,
};

const ENDPOINT = `${import.meta.env.BASE_URL}api/voice-live/telemetry`;
// Vite injects MODE/BASE_URL automatically; a real build hash isn't wired
// into this scaffold, so fall back to MODE so we can still distinguish
// dev vs preview vs prod traffic.
const BUILD_HASH =
  (import.meta.env as Record<string, string | undefined>).VITE_BUILD_HASH ?? import.meta.env.MODE;

function newSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch { /* fall through */ }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let currentSessionId: string | null = null;

/** Start a new logical session (call/preflight). Call on Preflight mount. */
export function newTelemetrySession(): string {
  currentSessionId = newSessionId();
  return currentSessionId;
}

export function getTelemetrySessionId(): string {
  if (!currentSessionId) currentSessionId = newSessionId();
  return currentSessionId;
}

export interface TelemetryPayload {
  // Tightly scoped — must be JSON-serializable scalars/short strings only.
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Emit a telemetry event. Best-effort; swallows all errors. Caller does
 * not need to await. Payload must be a flat object of JSON scalars.
 */
export function emit(event: TelemetryEvent, payload: TelemetryPayload = {}): void {
  if (!ALLOWED[event]) return;
  const body = {
    event,
    sessionId: getTelemetrySessionId(),
    buildHash: BUILD_HASH,
    ts: Date.now(),
    ...sanitize(payload),
  };
  try {
    const json = JSON.stringify(body);
    if (json.length > 4_000) return; // hard ceiling; structured events should be small
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([json], { type: "application/json" });
      const ok = navigator.sendBeacon(ENDPOINT, blob);
      if (ok) return;
    }
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
      keepalive: true,
    }).catch(() => { /* swallow */ });
  } catch {
    /* never throw from telemetry */
  }
}

function sanitize(payload: TelemetryPayload): TelemetryPayload {
  const out: TelemetryPayload = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "event" || k === "sessionId" || k === "buildHash" || k === "ts") continue;
    if (v == null) continue;
    if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
