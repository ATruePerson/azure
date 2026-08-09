# Azure Working Context

This is the durable handoff for Azure-specific work that is easy to forget between
tasks. `AGENTS.md` remains the main repository guide.

## Live paths

- Source: `/Users/kabir/Documents/GitHub/azure`
- Commands: `/Users/kabir/.local/bin/azure` and `/Users/kabir/.local/bin/azure-proxy`
- Runtime config: `/Users/kabir/.config/azure/config.json`
- Secrets: `/Users/kabir/.config/azure/.env`
- Codex config: `/Users/kabir/.codex/config.toml`
- Request metrics: `/Users/kabir/.config/azure/test_runs.jsonl`

## Codex Desktop contract (experimental / work in progress)

The integration remains incomplete and may break when Codex changes its model
catalog, request shape, or desktop behavior. Preserve the reversible
`azure codex --restore` path and do not describe this surface as production-ready.

- `azure codex` must open the existing `/Applications/ChatGPT.app` directly with
  macOS `open`. Never invoke the bundled
  `/Applications/ChatGPT.app/Contents/Resources/codex app` command: when a
  separate app bundle is absent, that command downloads another 587 MB installer
  and creates `/Applications/Codex.app`.
- When a command needs to start the background gateway, it prefers the sibling
  `azure-proxy` binary. This keeps `azure-stop` and `azure-restart` able to find and
  manage the process; do not regress to launching the `azure` command itself.
- Azure backs up the existing Codex config, writes an ownership-marked direct Azure
  Responses provider, and preserves unrelated projects, MCPs, and preferences.
- Codex 0.144.2 enables hosted web search by default even when a model catalog
  does not advertise it. Azure therefore writes `web_search = "disabled"` only
  while its provider is active; `azure codex --restore` restores the exact prior
  setting.
- `azure codex --restore` restores the original subscription config and removes the
  generated catalog and backup state.
- Azure writes a Codex-compatible `model_catalog_json` generated from
  `config.json.models`. The installed Codex CLI must parse this file before a
  release is considered verified.
- Codex stores the chosen stable model ID and reasoning effort in the task. Azure
  resolves both values on every request. Never read a global "active model" to
  rewrite another task's request.

## Codex model registry

The Codex menu uses deterministic `provider/upstream-model` IDs generated from
enabled Azure capabilities plus authenticated native-provider discovery. The
Claude family aliases `opus`, `sonnet`, and `haiku` stay in the separate Claude
Code registry and never appear in Codex. A direct Codex ID routes exactly to its
named provider/model and gets no implicit Claude alias fallback.

Unsupported efforts return 400 before a provider call. A fallback is used only
through the capability registry's explicit fallback lists, and
the response headers report requested model/effort plus actual provider,
backend model, effort, and fallback state.

Big Pickle advertises the 262K context available through HY3. Its primary
route remains capped at 131K. Azure estimates compacted Responses payloads at a
conservative three bytes per token, respects a smaller client output limit, and
skips routes that cannot safely hold the request. Requests beyond HY3's context
can continue through Gemini's million-token fallback instead of returning an
empty oversized-request error.

## Azure identity

[`persona.go`](persona.go) is the only Azure-owned identity source. Normal
identity is `I'm Kabir's Second Brain.` The current provider/model is included
in the model-visible prompt so it can be disclosed only when explicitly asked.
Azure does not inject the retired route-specific provider imitation prompts.
Codex, project, tool, safety, developer, and user instructions remain separate.
The shared identity core is paired with exactly one client adapter: Codex
Responses requests receive the Codex adapter, while Anthropic Messages requests
receive the Claude Code adapter. Neither client receives the other adapter.

## Plugins, Sites, and scheduled tasks

- Claude Code can load Azure's local MCP bundle from
  `~/.config/azure/mcp.json`. `azure claude` supplies that file through
  `--mcp-config --strict-mcp-config`; it does not rewrite `~/.claude.json`.
  Strict mode prevents legacy global servers with overlapping tools from
  shadowing the Azure bundle. The safe default bundle contains `azure-websearch`
  and `azure-mac-control`. Obsidian is a separate plugin bundle under
  `plugins/obsidian` and is not installed or served by Azure core. Unrestricted
  `azure-osascript` is opt-in through
  `azure mcp install --include-raw-osascript`.
- Claude-3p is a separate desktop client with its own config at
  `~/Library/Application Support/Claude-3p/claude_desktop_config.json`.
  `azure mcp install --claude-3p` merges the Azure servers there, removes only the
  legacy custom entries, preserves unrelated servers and preferences, and
  creates a backup. Add `--include-raw-osascript` when that unrestricted tool
  is explicitly wanted in Claude-3p. Add `--include-obsidian` to register the
  standalone vault-locked Obsidian MCP server; the plugin's skills and binary
  remain separate from Azure core.
- `azure-mac-control` addresses Notes by nested `folderPath`, supports folder
  `Instructions` notes, and returns recent note IDs with counts 1, 3, or 7.
  Write tools preserve existing note HTML where possible and replace/delete
  require explicit confirmation. Apps opened by a call are closed afterward;
  pre-existing apps are left running.
- Plugins and MCP servers are controlled by Codex. Azure preserves function tool
  definitions, strict schemas, tool choice, parallel calls, call IDs, results,
  multi-turn loops, images, files, and Responses streaming events. Codex's
  free-form `custom` tools are translated through a one-string function wrapper
  for Chat Completions upstreams, then restored as native `custom_tool_call`
  items and streaming events. Codex namespace groups are flattened to
  collision-safe function names for upstreams, then restored with their
  original namespace and child name on both unary and streaming responses.
  Unsupported provider-hosted tools, including web
  search, fail before a provider is contacted with the exact backend and tool.
- Sites 0.1.27 is a Codex plugin. Its design picker is an MCP tool and its save/
  deploy operations are a Codex connector. Tool calls can pass through Azure;
  connector authentication and deployment do not pass through the model
  provider. Never claim a Sites deployment was tested unless one was created.
- Scheduled local jobs store model ID and effort, but the current automation
  schema has no custom `model_provider` field. A task using `sonnet`
  therefore does not prove it used Azure. Do not advertise scheduled Azure support
  until Codex persists the custom provider too.

## July 14, 2026 failure

The first desktop attempt used the bundled `codex app` installer and created a
duplicate `/Applications/Codex.app`; it was verified byte-for-byte against the
real app and removed with Kabir's approval. The app showed a blank custom model
menu. Two Opus requests reached Azure, failed over from GLM 5.2 to MiniMax M3, and
ended with HTTP 504 because the fallback emitted no response before the
first-token timeout. A later live check showed GLM could also stall before
returning HTTP headers, which bypassed the first-token guard; Azure now applies the
same timeout while waiting for headers so fallback can begin.

The blank picker and timeout were separate problems. The old catalog used
slash-prefixed IDs and a static three-model table. Routing also read the globally
configured Codex model and could overwrite a task's request. The capability
registry and per-request stable IDs replace that path.

## Provider details that bite

- NVIDIA reasoning models are text-only unless a live capability check proves
  otherwise. MiniMax M3 is the current NVIDIA vision exception.
- MiniMax M3 rejects `reasoning_budget`; let it reason natively.
- `big-pickle` is a reasoning model and can spend a small output limit entirely
  on reasoning. It completed simple tools but every repeated multi-tool coding
  workflow failed upstream. HY3 sits immediately behind it as fallback.
- NVIDIA GLM-5.2 repeatedly timed out during the July 16 benchmark. It remains
  unassigned.
- `tencent/hy3:free` completed all 27 curated runs at OpenRouter reasoning
  effort `high`, including 20K, 50K, and 80K contexts. The normalized Codex
  effort exposed for all three public models is `max`.
- Full evidence and rerun commands live in
  [`benchmarks/model-routing`](benchmarks/model-routing/README.md).

## Verification

```bash
make test
curl -sS http://localhost:9999/health
tail -n 10 /Users/kabir/.config/azure/test_runs.jsonl
```

For a live model check, send a tiny `/v1/responses` request and verify the
`X-Azure-*` response headers plus the final JSONL row. Use a temporary Codex home
for catalog parser tests. Do not change global Codex settings just to test.

## Native Codex lifecycle and auth

The supported path is `Codex -> Azure loopback -> exact provider/model`.
`azure codex setup/start/stop/status/doctor/restore/remove` do not execute or
configure OpenCodex. Process ownership is recorded only when `start` launches
Azure, so `stop` refuses to kill an unrelated process. Config changes are atomic,
timestamp-backed up, ownership-marked, and exactly restorable.

Native Kimi and xAI credentials live in macOS Keychain and refresh lazily with
single-flight locking, rotation, expiry skew, and one replay after a 401.
Anthropic API keys remain the stable path. Existing official Claude/Grok
credentials are read only after an explicit import command; normal startup does
not inspect or migrate them.
