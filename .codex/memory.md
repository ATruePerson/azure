# Azure Project Memory

Updated 2026-08-13. This is project context and repair history, not operating instructions. Verify branch, dirty state, runtime, and installed artifacts before acting.

## Project State

- Active development checkout: `/Users/kabir/Documents/GitHub/Azure`
- Repository: `ATruePerson/azure`
- Working branch: `azure` (renamed from `azure-code`)
- Rebrand complete: "T3 Code" → "Azure", `t3.json` → `azure.json`, `.t3`/`.azure-code` → `.azure`

## Critical Fixes (2026-08-13)

### 1. Azure Capabilities Not Loading in Dev Mode
**Root cause**: Worktree `.azure/{mcp,skills,hooks,plugins}` are symlinks to `~/.azure/*`, but `~/.azure` was NOT in `DEFAULT_TRUSTED_ROOTS`. All capabilities silently failed to load.
**Fix** (`apps/server/src/provider/AzureHomeCapabilities.ts`):
- Added `~/.azure` to `DEFAULT_TRUSTED_ROOTS`
- Replaced inline 3-entry trusted-root lists with constant reference in `discoverAzureHomeCapabilities` and `resolveAzureHomeCapabilityIcon`

### 2. Skill Merge Bug on Provider Probe Refresh
**Root cause**: `mergeProviderSnapshot` in `ProviderRegistry.ts` only merged `models`, dropping `skills` on provider probe refresh. Nvidia/OpenRouter/OpenCode Zen lost Azure skills after probe refresh.
**Fix**: `mergeProviderSnapshot` now preserves/merges skills (dedupe by name).

### 3. Full `t3.json` → `azure.json` Rename
- All symbols: `T3_*` → `Azure_*` (e.g., `T3_PROJECT_FILE_NAME` → `AZURE_PROJECT_FILE_NAME`)
- Files: `t3ProjectFile.ts` → `azureProjectFile.ts`, `T3ProjectFileLoader.ts` → `AzureProjectFileLoader.ts`, `useT3ProjectFileScripts.ts` → `useAzureProjectFileScripts.ts`
- Subpath export: `@azure/shared/t3ProjectFile` → `@azure/shared/azureProjectFile`
- 25+ importers updated across server, web, marketing
- Schema URL: `https://azure.codes/schema/azure.json`

### 4. Branding: "Azure Code" → "Azure"
- `apps/web/src/branding.ts`: `APP_BASE_NAME = "Azure"`
- `apps/desktop/src/app/DesktopEnvironment.ts`: `APP_BASE_NAME = "Azure"`, dir names `.azure-code` → `.azure`
- `apps/desktop/src/app/DesktopStatePaths.ts`: `DESKTOP_BASE_DIR_NAME = ".azure"`

### 5. ChatComposer `/` Trigger Works Anywhere
- `detectComposerTrigger` in `apps/web/src/composer-logic.ts` now detects `/` after space/tab/newline, not just line start

### 6. Schedule Task Button in Sidebar
- Added next to "New thread" button in `apps/web/src/components/Sidebar.tsx`
- Fixed duplicated `CalendarClockIcon` bug (matched "New thread" pattern: icon in TooltipTrigger children, self-closing SidebarMenuButton in render prop)

### 7. Plugin Slash Commands Separate in `/` Menu
- Added optional `source` field to `ServerProviderSlashCommand` in `packages/contracts/src/server.ts`
- OpenCodeProvider passes `command.source` through ("command", "plugin", "skill")
- `ComposerCommandMenu.tsx` groups provider slash commands: Built-in → Provider → Plugins

## Verification Commands

```bash
vp test run <files>           # focused tests only (CI runs full suite)
vp run -r typecheck           # full typecheck
vp run -r test                # full test suite
vp fmt && vp lint             # format + lint
```

**Never** run `vp check` or full suite unless asked. CI owns that.

## Testing Gotchas

- Seed worktree `.t3/userdata` from `~/.t3/userdata` via `VACUUM INTO`:
  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```
- Server is event-sourced: wait on receipts/worker drains, never sleeps/polling
- Integration tests need real client (`test-t3-app` for web); ask before browser automation

## Kill/Process Safety

- **Never** `pkill -f`, `pgrep | kill` by name/path. Your agent process has worktree path in argv.
- Kill only PID you captured at spawn, or port owner: `ss -H -ltnp` then confirm `/proc/<pid>/cwd`
- Never open `~/.t3/userdata` read-write. Copy to worktree `.t3/userdata` via `VACUUM INTO`.
- Never set `VITE_HTTP_URL`/`VITE_WS_URL` for dev. Vite proxies `/api`, `/ws`, `/oauth`, `/.well-known`.

## Provider Capability Architecture

- `~/.azure` = canonical capability home for skills, plugins, hooks, MCP
- Worktree `.azure/*` → symlinks to `~/.azure/*`
- `AzureHomeCapabilities.ts` discovers; `DEFAULT_TRUSTED_ROOTS` must include `~/.azure`
- `ProviderRegistry.ts` merges Azure skills into EVERY provider snapshot
- `ProviderService.ts` expands `$skill` and runs portable hooks centrally
- Native providers (Codex, Claude) → authenticated Azure MCP endpoint
- Direct OpenAI-compatible (Nvidia, OpenRouter, OpenCode Zen) → same endpoint, tool loops
- **Never** copy/symlink capabilities into provider homes; never fall back to OpenCode for Nvidia/OpenRouter

## References

- `notes.md` — provider capability handoff (read before Azure skills/plugins/hooks/MCP work)
- `docs/internals/glossary.md` — full glossary with file links
- `.repos/effect-smol/LLMS.md` — Effect patterns (read before `apps/server` changes)