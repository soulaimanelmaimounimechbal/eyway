// Persist a completed training session to the API server for later analytics.
// Best-effort: we never await it in the UI path and never throw — a failed
// save must not break the user's flow or block navigation to the outcome.
import { getTelemetrySessionId } from "./telemetry";
import type { TranscriptEntry } from "./voice-client";

const ENDPOINT = `${import.meta.env.BASE_URL}api/sessions`;

export interface SaveSessionInput {
  style: string;
  intensity: string;
  selfReportedStyle?: string;
  selfNote?: string;
  tier: string;
  userTurns: number;
  avgWords?: number;
  hits: string[];
  durationMs?: number;
  transcript: TranscriptEntry[];
}

export function saveTrainingSession(input: SaveSessionInput): void {
  try {
    const body = JSON.stringify({
      ...input,
      clientSessionId: getTelemetrySessionId(),
    });
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      /* swallow — analytics persistence must not break the product */
    });
  } catch {
    /* never throw from session persistence */
  }
}
