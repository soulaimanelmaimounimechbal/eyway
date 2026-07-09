# Deploying to Azure App Service

This pnpm monorepo ships as **one** Azure Web App: the `api-server` (Express)
serves the built `training` frontend from a `public/` folder next to the server
bundle.

## Deploy: GitHub Actions

Deployment is fully automated by `.github/workflows/main_ey-way.yml`. Push to the
`main` branch of the connected GitHub repo and the workflow builds and deploys via
Azure OIDC login:

```bash
git push origin main
```

The workflow builds on a clean GitHub-hosted runner (no Azure filesystem quirks),
then:

1. `pnpm install --frozen-lockfile`
2. builds the backend (`@workspace/api-server`) and the frontend
   (`@workspace/training`, with `BASE_PATH=/ PORT=8080`)
3. assembles a self-contained package with
   `pnpm --filter @workspace/api-server --prod --legacy --node-linker=hoisted deploy deploy`
   (`--node-linker=hoisted` is required so the externalized `@azure/*` deps are real
   directories that survive the deploy, not symlinks)
4. co-locates the built frontend: `cp -r artifacts/training/dist/public deploy/public`
5. deploys the `deploy/` folder to the `ey-way` Web App with startup command
   `NODE_ENV=production node dist/index.mjs`

The workflow authenticates with Azure via OIDC using these GitHub repo secrets
(created when the repo is connected to Azure via Deployment Center → GitHub Actions):
`AZUREAPPSERVICE_CLIENTID_*`, `AZUREAPPSERVICE_TENANTID_*`, `AZUREAPPSERVICE_SUBSCRIPTIONID_*`.
If the **"Login to Azure"** step fails, the repo isn't connected to Azure yet.

## Required Azure-side settings (not in code)

Set these in the Azure Portal — they are **not** part of the deploy package:

- **Startup command:** `NODE_ENV=production node dist/index.mjs`
  (`NODE_ENV=production` is required — otherwise the logger loads a build-time
  worker path that does not exist on Azure and the app fails to boot.)
- **App setting** `NODE_ENV=production` (belt-and-suspenders).
- **Web Sockets = On** (Configuration → General settings). The voice feature
  upgrades to a WebSocket at `/api/voice-live` and won't work otherwise.
- **Database** — one of:
  - `DATABASE_URL` ending with `?sslmode=require`, or
  - the Azure split vars `AZURE_POSTGRESQL_HOST/PORT/USER/PASSWORD/DATABASE`.
  Don't set both.
- **Voice (realtime):** `AZURE_VOICE_LIVE_API_KEY`, `AZURE_VOICE_LIVE_ENDPOINT`.
- **End-of-call AI evaluation:** `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`
  (optional `AZURE_OPENAI_DEPLOYMENT`, defaults to `gpt-4o-mini`). Without these
  the app falls back to the deterministic scorer.
- Do **not** set `PORT` — Linux App Service injects it and the app reads it.

## One-time database setup

The `training_sessions` table (including its `assessment` column) must exist in
the Azure Postgres. Push the schema once against the prod connection string:

```bash
DATABASE_URL='<prod-url>?sslmode=require' pnpm --filter @workspace/db run push
```
