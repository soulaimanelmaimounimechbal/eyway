# @workspace/api-server

Express + WebSocket server for the Social Styles training app. Hosts the
Azure Voice Live proxy and a small set of operability endpoints.

## Voice Live operability endpoints

All endpoints live under `/api/voice-live`. Secrets are never returned.

### `POST /api/voice-live/token`
Mints a short-lived HMAC token that the browser uses to upgrade the WS
proxy at `/api/voice-live`. Same-origin enforced.

### `POST /api/voice-live/telemetry`
Accepts a small, allow-listed JSON event from the frontend and logs it
at `info` level under `{ telemetry: true, ... }`. Same-origin enforced.
Payload is capped at 4KB and unknown fields are dropped.

Allowed `event` values: `preflight_started`, `preflight_passed`,
`preflight_failed`, `call_started`, `first_audio_ms`, `voice_fallback`,
`reconnect_attempted`, `reconnect_succeeded`, `call_ended`, `error`.

Each event includes `sessionId` (per-call UUID minted in the browser)
and `buildHash` (the Vite build identifier) so log lines can be grouped.
No PII, no transcripts.

### `GET /api/voice-live/health`
Returns the effective Azure config (host, model, api-version — no
secrets) plus a token-mint check and a one-shot upstream probe with
the default voice. Returns `200 { ok: true, checks: [...] }` when
healthy, `503` with details on failure.

### `GET /api/voice-live/smoke`
Per-persona dry-run probe. Iterates each persona's primary voice plus
its fallbacks (mirrors `artifacts/training/src/lib/agents.ts`) and
returns a `{ persona, ok, voice, kind, message, elapsedMs }` row for
each. Returns `200` if all personas pass, `503` otherwise.

**Gated.** Disabled in `NODE_ENV=production` unless the request carries
an `X-Debug-Token` header that matches `VOICE_LIVE_DEBUG_TOKEN`. Outside
production it is always available. When disabled, returns `404`.

### Debug UI

The training app exposes a hidden debug page at `?debug=1` (e.g.
`https://<host>/?debug=1`) that calls `/health` and `/smoke` and
renders the results as a table. Use after env changes to verify each
persona in one click.

## Environment variables

| Var                              | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `AZURE_VOICE_LIVE_ENDPOINT`      | Azure Voice Live endpoint URL                              |
| `AZURE_VOICE_LIVE_API_KEY`       | Azure key (server-side only)                               |
| `AZURE_VOICE_LIVE_MODEL`         | Override default model (`gpt-4o-realtime-preview`)         |
| `AZURE_VOICE_LIVE_API_VERSION`   | Override default api version (`2025-05-01-preview`)        |
| `VOICE_LIVE_DEBUG_TOKEN`         | Shared secret that unlocks `/smoke` in production          |
| `LOG_LEVEL`                      | pino log level (default `info`)                            |

## Example

```sh
curl -s $REPLIT_DEV_DOMAIN/api/voice-live/health | jq
```

```json
{
  "ok": true,
  "config": { "endpointHost": "…", "model": "…", "apiVersion": "…" },
  "checks": [
    { "name": "token", "ok": true },
    { "name": "upstream_probe", "ok": true,
      "detail": "en-US-Ava:DragonHDLatestNeural", "elapsedMs": 612 }
  ]
}
```
