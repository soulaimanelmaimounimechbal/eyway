---
name: Azure App Service single-app deploy
description: How this pnpm monorepo deploys as ONE full app (frontend + backend) to a single Azure App Service.
---

# Deploying the monorepo as one full app to Azure App Service

The product is two artifacts (`training` static frontend + `api-server` Express
backend) that Replit serves together via its path router. Azure App Service has
no such router, so to serve the **full app on one Web App** the api-server itself
serves the built frontend, and CI ships one self-contained package.

## Why these choices (non-obvious)
- **Keep `@azure/*` external in esbuild** (`artifacts/api-server/build.mjs`). The
  bundle inlines everything (express, pg, drizzle, `@workspace/*`) EXCEPT
  `@azure/*` and optional native bits (`pg-native`). Attempting to bundle
  `@azure/ai-voicelive` fails at runtime with `ERR_MODULE_NOT_FOUND` — the voice
  SDK does not bundle. So the runtime needs a real `node_modules` with
  `@azure/ai-voicelive` + `@azure/core-auth`.
- **`pnpm deploy` needs `--prod --legacy --node-linker=hoisted`**. `--legacy` is
  required because pnpm v10 refuses non-injected workspace deploys by default.
  `--node-linker=hoisted` is REQUIRED too: pnpm's default isolated layout makes
  top-level packages **symlinks into `.pnpm/`**, and Azure's zip deploy does NOT
  preserve symlinks — so externalized deps like `@azure/ai-voicelive` vanish at
  runtime with `ERR_MODULE_NOT_FOUND` even though they were "installed". Hoisted
  produces real directories that survive the upload. `pnpm --filter
  @workspace/api-server --prod --legacy --node-linker=hoisted deploy <out>`
  yields built `dist/` + a real (non-symlinked) `node_modules`. Then copy
  `artifacts/training/dist/public` → `<out>/public`.
- **api-server serves frontend** only when a `public/` with `index.html` sits next
  to `dist/index.mjs` (gated by `fs.existsSync`), so it's a no-op in Replit
  dev/prod. SPA fallback is a catch-all `app.use` middleware that skips `/api` and
  non-GET/HEAD. Override dir with `PUBLIC_DIR`.
- **Frontend build requires env**: `vite.config.ts` THROWS if `BASE_PATH` or
  `PORT` are unset even for `build`. CI sets `BASE_PATH=/ PORT=8080`.

## DB connection: two supported forms (see `lib/db/src/index.ts`)
- `DATABASE_URL` (preferred; used in Replit). On Azure it MUST end with
  `?sslmode=require` (TLS required; the pg Pool adds no ssl on this path).
- OR Azure's auto-injected split settings: `AZURE_POSTGRESQL_HOST/PORT/USER/
  PASSWORD/DATABASE/SSL`. `createPool()` falls back to these when `DATABASE_URL`
  is absent, defaulting SSL on (`rejectUnauthorized:false`) unless
  `AZURE_POSTGRESQL_SSL` is an explicit falsy/"disable" value. Either form works;
  don't set both.

## Other Azure-side settings the user must configure (not in code)
- App settings (env): `AZURE_VOICE_LIVE_API_KEY`, `AZURE_VOICE_LIVE_ENDPOINT`,
  plus one of the DB forms above. Do NOT set `PORT` (Linux App Service injects it;
  the app reads `process.env.PORT`).
- **Enable Web Sockets = On** (Configuration → General settings). Off by default;
  the voice feature uses a WS upgrade at `/api/voice-live` and will not work
  without it.
- Startup command `NODE_ENV=production node dist/index.mjs` (set by the workflow's
  `webapps-deploy` `startup-command`). **`NODE_ENV=production` is REQUIRED**:
  `logger.ts` only attaches the `pino-pretty` transport when NODE_ENV !==
  "production". That transport runs in a worker thread whose path
  (`thread-stream-worker.mjs`) is baked at BUILD time as the Actions runner's
  absolute path (`/home/runner/work/ey-way/...`), which does not exist on Azure →
  `MODULE_NOT_FOUND` at startup. In production pino logs plain JSON to stdout with
  no worker, so forcing NODE_ENV=production avoids the worker entirely. Azure does
  NOT set NODE_ENV by default for custom startup commands. Belt-and-suspenders:
  also add `NODE_ENV=production` as an App Setting.
- Recommend `SCM_DO_BUILD_DURING_DEPLOYMENT=false` since node_modules ships in the
  package (no Oryx rebuild needed).
- `lib/db/src/index.ts` throws at import only if NEITHER `DATABASE_URL` NOR the
  required Azure split vars (`AZURE_POSTGRESQL_HOST/USER/PASSWORD/DATABASE`) are
  set, so at least one DB form must exist before the server can boot.
- The `training_sessions` table must be pushed to the Azure Postgres once
  (`drizzle-kit push` against the prod DATABASE_URL) — it won't exist there.

**Why:** the repo's `preinstall` guard rejects npm; Azure's auto-generated
workflow used `npm install` and failed with "Use pnpm instead". The fix is a
pnpm-based workflow, NOT switching the repo to npm (which would drop the
`minimumReleaseAge` supply-chain protection and the catalog/workspace setup).
