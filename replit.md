# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Hold-to-talk contract (Conversation.tsx).** The mic must stay open until the user physically releases. Auto-release fires only on terminal session states (`error` / `closed` / `closing`) or when the assistant is *actually playing audio* (`assistantSpeaking && assistantLevel > 0`); never on `assistantSpeaking` alone (it races the model's `response.create`) and never on `reconnecting` (transient by design).
- **Pointer hold uses `setPointerCapture` + `pointerup`/`pointercancel` only — no window `blur` listener.** The training UI runs inside the Replit preview iframe, where clicking the workspace chat blurs the iframe window; a blur listener there cut holds off mid-sentence. The keyboard (Space) hold path *does* use `blur` as a fallback because alt-tabbing otherwise strands the mic.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
