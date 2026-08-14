# Azure provider capabilities handoff

Updated: 2026-08-13 — symlink trust fix + skill merge fix; provider subset green (105 tests).

Read this before changing Azure skills, plugins, hooks, MCP, or a direct provider runtime.

---

## �� Brand rename complete (2026-08-13)

- `8825fd534` — Azure MCP tool loop, capability home, ChatGPT Web provider + 7 test fixes
- `146add272` — full `t3` → `azure` rename (1523 files)
- 7 failing tests fixed (Option/stream, hasAzureMcpToolCall, mockClear, ChatGptWebDriver expectations)
- Provider subset green post-rename (105 focused tests pass)

**Verified**: ESM `@azure/contracts` resolves; MCP subset 8/14 skipped; ProviderRegistry 44/0; AzureHomeCapabilities 12/0.

---

## Goal

Make `~/.azure` the canonical capability home for every provider. Nvidia, OpenRouter, and OpenCode Zen use Azure skills, plugins, hooks, and MCP without requiring OpenCode.

---

## Implemented

- `AzureHomeCapabilities.ts` — discovers skills/plugins/hooks/MCP; merges skills (project > Azure > provider-home); resolves `$skill`; runs portable hooks; normalizes MCP descriptors
- `ProviderRegistry.ts` — merges Azure skills into every provider snapshot
- `ProviderService.ts` — resolves explicit `$skill`, runs portable hooks centrally
- `AzureMcpGateway.ts` / `McpHttpServer.ts` — Azure-owned MCP gateway (stdio + HTTP), tool namespacing, client reuse, failed-server isolation
- `OpenAICompatibleRuntime.ts` — Nvidia/OpenRouter/OpenCode Zen list Azure MCP tools, run tool loops (16 rounds, 64 KiB)
- `@modelcontextprotocol/sdk` dependency added
- Settings UI explains portable capabilities

---

## �� Fix (2026-08-13) — Capability symlink trust + skill merge

**Problem**: Worktree `.azure/{mcp,skills,hooks,plugins}` symlinks to `~/.azure/*` were rejected by default trusted-roots (only `~/.codex`, `~/.config/azure`, `~/Developer/AI`). All capabilities silently failed to load in dev mode.

**Root cause**: `discoverAzureHomeCapabilities` and `resolveAzureHomeCapabilityIcon` had inline 3-entry trusted-root defaults; `DEFAULT_TRUSTED_ROOTS` constant wasn't referenced.

**Fix** (`AzureHomeCapabilities.ts`):

- Added `~/.azure` to `DEFAULT_TRUSTED_ROOTS`
- Replaced inline lists with constant reference in `discoverAzureHomeCapabilities` and `resolveAzureHomeCapabilityIcon`

**Skill merge bug** (`ProviderRegistry.ts`):

- `mergeProviderSnapshot` only merged `models`, dropping `skills` on provider probe refresh
- Fixed to preserve/merge skills (dedupe by name)

**Verification**:

- Added regression test: "lists symlinked entries resolving into the canonical ~/.azure home via default trusted roots"
- 105 tests pass (105/0)
- Live discovery: `discoverEnabledAzureMcpServers("<worktree>/.azure")` returns `azure-search` stdio descriptor
- Stdio server works: `initialize` → `azure-search`; `tools/list` → `web_search` + `web_fetch`
- Nvidia skills now appear in Composer after fix

---

## Remaining before complete

5. **Nvidia smoke test** (requires Nvidia API key + `vp run dev`):
   - `AZURE_HOME=~/.azure ./node_modules/.bin/vp run dev --home-dir ~/<worktree>/.t3`
   - Pair, set Nvidia `stepfun-ai/step-3.7-flash`, enable `azure-search` MCP at `~/.azure/mcp/main.json`
   - Send turn listing skills, invoke `$skill`, run read-only `azure-search` call
   - Expect: Ponytail hook context, MCP tool loop returns search result, ends on assistant text within 16 rounds

6. Portable checks for each authenticated provider instance

7. Reproduce Nvidia `startSession` error before changing session behavior

8. Build/sign/relaunch checks

---

## Guardrails

- Preserve unrelated dirty Codex/ChatGPT work; never reset/clean it
- `SubagentStart` native-only; portable v1 = manifest skills + `SessionStart`/`UserPromptSubmit` hooks
- 64 KiB caps / 30s hook ceiling are deliberate boundaries
- One MCP server failing must not hide others' tools or block a turn
- Use existing `request.opened`/`request.resolved`/`respondToRequest` for approvals

---

## Brand-rename follow-ups (deferred)

1. Re-point `origin` git remote to real fork (`ATruePerson/azure.git`)
2. Mobile module dir renames (`git mv` + pnpm install regen)
3. MCP server `"t3-code"` internal id rename (kebab through source + tests)
4. Live-CI external env-var rebinding (Clerk / Cloudflare / Relay / PostHog / GitHub Actions)
5. `AGENTS.md` brand-voice cleanup (local, gitignored)
6. Marketing bare-`t3` CLI prose; legal-proper-noun polish (T3 Tools, Inc. / T3 Connect)

---

## OpenCode note

OpenCode's native adapter independently attaches the authenticated Azure MCP endpoint. Verify its native tool listing/result path; do not replace with OpenAI-compatible loop.

---

## How pieces connect

1. Azure capability discovery reads only from `~/.azure` (or `AZURE_HOME` in tests)
2. `ProviderRegistry` merges Azure skills into each provider snapshot
3. `ProviderService` expands `$skill` and runs portable hooks centrally
4. Native providers use authenticated Azure MCP endpoint; direct OpenAI-compatible providers connect to same endpoint and run tool loops

Do not copy/symlink capabilities into provider homes. Do not import/launch/fallback to OpenCode for Nvidia/OpenRouter/OpenCode Zen.
