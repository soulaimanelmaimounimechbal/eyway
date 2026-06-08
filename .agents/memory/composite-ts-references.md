---
name: Composite TS project references in the monorepo
description: Why dependent-package typecheck fails after editing a shared lib's exports, and how to fix it.
---

Shared libs under `lib/*` (e.g. `@workspace/db`) are TypeScript **composite** projects
(`composite: true`, `emitDeclarationOnly: true`) that emit `.d.ts` into `dist/`. Artifacts
like `artifacts/api-server` consume them via tsconfig `references`, so they typecheck against
the **built `dist/*.d.ts`**, not the live `src`.

**Rule:** After adding/changing exports or schema in a `lib/*` package, rebuild its declarations
before typechecking dependents:
```
cd lib/<pkg> && pnpm exec tsc -b
```
**Why:** Without the rebuild, the stale `dist/*.d.ts` still reflects the old exports, and the
dependent package fails with `error TS2305: Module '@workspace/<pkg>' has no exported member 'X'`,
even though `src` is correct.

**How to apply:** Whenever you edit `lib/db/src/schema/*` (or any `lib/*` public surface) and a
downstream artifact's `typecheck` then reports a missing export, rebuild the lib's `-b` output
first instead of hunting for an import bug.
