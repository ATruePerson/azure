# Azure Code — Agent Context

## What This Is

Azure Code is an **agent harness control surface** — a Mac desktop app (Electron) and web UI that lets you manage AI coding agents (Claude Code, Codex, Cursor, Grok Build, OpenCode) running on your machine. Not an IDE, not an agent itself — a remote control for agents.

## Monorepo Layout

pnpm workspace, Vite+ (`vp`) tooling, TypeScript 6, Effect-TS throughout.

```
apps/
  server/       # Node backend — agent lifecycle, relay, auth
  web/          # Vite SPA — primary browser UI
  desktop/      # Electron shell wrapping the web app (Mac target)
  marketing/    # Marketing site
  test-fixtures/

packages/
  contracts/        # Shared API types/schemas (Effect Schema)
  shared/           # Cross-platform utilities
  client-runtime/   # Client-side runtime helpers (subpath exports only — no root import)
  effect-acp/       # Effect wrappers for agent control protocol
  effect-codex-app-server/  # Codex-specific Effect layer
  ssh/              # SSH tunneling support
  tailscale/        # Tailscale integration

native/
  resource-monitor/   # Rust (Cargo) — system resource monitoring
  libghostty-vt/      # Ghostty terminal emulation bindings

scripts/        # Build, release, dev-runner, etc.
```

## Tech Stack

- **Runtime**: Node 24.13+
- **Language**: TypeScript 6 (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`)
- **Framework**: Effect-TS 4.x (beta) — used *everywhere* for services, errors, schemas, concurrency
- **Build**: Vite+ (`vp`) — replaces Turbo. Use `vp` commands, not `npx turbo`.
- **Package manager**: pnpm 11 with workspace catalogs
- **Auth**: Clerk (publishable key in `.env.example`)
- **Desktop**: Electron (Mac)
- **Native**: Rust crates (`resource-monitor`, `libghostty-vt`)
- **Testing**: Vitest via `vp run -r test`
- **Linting**: OxLint + custom Azure plugins (`oxlint-plugin-azure`, `oxlint-plugin-t3code`)
- **Formatting**: `vp fmt` (Prettier-based, runs on staged files)

## Key Conventions

### Effect-TS
This codebase is heavily Effect-idiomatic. Follow existing patterns:
- Use `Effect.gen` for sequencing, not raw `.pipe()` chains for complex logic
- Services, Layers, and tagged errors everywhere
- `@effect/platform-node` for platform I/O, not raw Node APIs
- `@effect/language-service` plugin enforces many rules (no global `Date`, `console`, `Math.random`, `fetch`, `setTimeout` — use Effect equivalents)

### Imports
- **Always** use explicit subpath imports for `@azure/client-runtime` (no root import)
- Namespace Node builtins: `import * as NodeFS from "node:fs"` (enforced by `azure/namespace-node-imports`)
- `verbatimModuleSyntax` is on — use `import type` for type-only imports

### Code Style
- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- No floating promises (currently warning, treat as error)
- Staged files auto-formatted via `vp fmt`

### Testing
- Vitest, with `@effect/vitest` for Effect-based tests
- Test timeouts set to 60s
- Run: `pnpm test` or `vp run -r test`

### Dev Workflow
- `pnpm dev` — full stack (server + web)
- `pnpm dev:server` — backend only
- `pnpm dev:web` — frontend only
- `pnpm dev:desktop` — Electron app
- `pnpm dev:share` — with remote sharing enabled
- Dependencies: `vp i` (not `pnpm install` directly for most tasks)

## Lint Rules to Know

Custom OxLint rules enforced:
- `azure/no-global-process-runtime` — error
- `azure/no-inline-schema-compile` — warn
- `azure/no-manual-effect-runtime-in-tests` — error
- `azure/namespace-node-imports` — error
- No importing from `@azure/client-runtime` root

## File Patterns

- Route trees are auto-generated (`routeTree.gen.ts`) — don't edit
- `.env` files are gitignored; `.env.example` has safe defaults
- `AGENTS.md`, `CLAUDE.md`, `.codex/`, `.claude/` are all gitignored (project uses `.agents/skills/` for agent config)
- Worktrees supported via `worktrees/` dir and `azure.json` scripts

## Don't

- Don't use `turbo` — this project uses Vite+ (`vp`)
- Don't import from `@azure/client-runtime` without a subpath
- Don't use global Node builtins without namespace imports
- Don't use `console.log` / `Date.now()` / `Math.random()` / `fetch` / `setTimeout` directly — use Effect services
- Don't edit `routeTree.gen.ts`
- Don't add server-side secrets to `.env.example`
