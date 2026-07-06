# Deploying to Azure App Service

This pnpm monorepo ships as **one** Azure Web App: the `api-server` (Express)
serves the built `training` frontend from a `public/` folder next to the server
bundle. There are two supported deploy paths — pick one.

## Option A — Local Git (`git push azure`)

Azure/Kudu builds the app on App Service. The repo blocks `npm` (a `preinstall`
guard), so a custom Kudu script (`.deployment` → `deploy.sh`) builds with pnpm
instead of Oryx's default `npm install`.

```bash
# one-time: add the Azure remote (from the portal → Deployment Center → Local Git)
git remote add azure <your-kudu-git-url>

# deploy
git push azure main:master
```

`deploy.sh` (run automatically by Kudu) installs with pnpm, builds the backend
and frontend, assembles a self-contained package (bundled server + a real,
non-symlinked `node_modules` with the externalized `@azure/*` deps + the built
frontend under `public/`), and publishes it to `wwwroot`.

## Option B — GitHub Actions

Push to `main` and `.github/workflows/main_ey-way.yml` builds and deploys via
OIDC. Same packaging as Option A.

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
- With Option A you may leave `SCM_DO_BUILD_DURING_DEPLOYMENT` unset; the
  `.deployment` command already replaces Oryx's default build.

## One-time database setup

The `training_sessions` table (including its `assessment` column) must exist in
the Azure Postgres. Push the schema once against the prod connection string:

```bash
DATABASE_URL='<prod-url>?sslmode=require' pnpm --filter @workspace/db run push
```
