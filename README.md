# azure

[![CI](https://github.com/ATruePerson/azure/actions/workflows/ci.yml/badge.svg)](https://github.com/ATruePerson/azure/actions/workflows/ci.yml)
[![Go Reference](https://pkg.go.dev/badge/github.com/ATruePerson/azure.svg)](https://pkg.go.dev/github.com/ATruePerson/azure)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

A local gateway for Claude Code and experimental Codex Desktop integration. It
accepts Anthropic Messages and OpenAI Responses requests, translates them to OpenAI-compatible chat
completions, then routes them to the provider and model you choose.

Use it to keep your normal client while routing to NVIDIA NIM, Gemini,
OpenRouter, OpenCode, or another OpenAI-compatible provider.

## Quick start

```bash
# Install the latest release. No Go toolchain needed.
curl -fsSL https://raw.githubusercontent.com/ATruePerson/azure/main/scripts/install.sh | sh

# Save provider keys and create ~/.config/azure/config.json.
azure setup

# Start Claude Code through Azure.
azure claude

# Or try the experimental Codex Desktop integration.
azure codex
```

`azure setup` stores keys in `~/.config/azure/.env` and creates a config file if
one does not exist. `azure claude` starts the gateway when needed and launches
Claude Code with the right connection. `azure codex` creates or preserves a
durable raw and sanitized subscription baseline, switches it to Azure, and
reopens the existing ChatGPT desktop app.

## Commands

| Command | What it does |
| --- | --- |
| `azure setup` | Save provider keys and create the first config file. |
| `azure doctor` | Check whether configured provider keys work. |
| `azure models` | List built-in model aliases and your config aliases. |
| `azure bench` | Benchmark configured personas and fallbacks. |
| `azure claude [args]` | Start Azure and launch Claude Code through it. |
| `azure codex setup` | Back up Codex and point it directly at Azure. |
| `azure codex start` | Start an owned Azure process and verify Responses readiness. |
| `azure codex status` | Show safe config, catalog, process, and provider status. |
| `azure codex doctor` | Run non-destructive direct-integration checks. |
| `azure codex restore` | Restore the durable sanitized subscription baseline. |
| `azure codex remove` | Remove active Azure/OpenCodex routing through the same sanitized restore path. |
| `azure auth login/status/logout` | Manage native provider login without printing secrets. |
| `azure mcp install` | Install Azure's safe bundled MCP config. |
| `azure mcp doctor` | Check bundled MCP tools and config. |
| `azure` | Run the gateway directly. |
| `azure -tui` | Run the gateway with the terminal dashboard. |
| `azure -ui` | Run the gateway and open the web dashboard. |

### Bundled local tools

Azure includes two safe-by-default local MCP servers for Claude Code:

- `azure-websearch` (**Azure Web Search**): keyless multi-source search plus guarded readable-page fetch.
- `azure-mac-control` (**Azure Mac Control**): Calendar, Reminders, notifications, and path-based Apple
  Notes tools. Notes can be addressed as `Stillness/Sleep`; IDs are optional
  when a folder path and exact title identify the note. `notes_recent` returns
  the newest 1, 3, or 7 notes from a specific folder.

Obsidian is deliberately separate from Azure core. Its standalone Codex plugin,
server, skills, and build instructions live in [`plugins/obsidian`](plugins/obsidian/README.md).

`azure claude` creates `~/.config/azure/mcp.json` when missing and passes it through
Claude Code's `--mcp-config` option in strict mode. That keeps older global MCP
servers from shadowing Azure's tools without rewriting Claude's global config.
Install or refresh it directly with:

```bash
azure mcp install
azure mcp doctor
```

The separate Claude-3p desktop app reads its own config. Merge Azure into that
config, remove only the three legacy custom servers, and preserve unrelated
servers and preferences with:

```bash
azure mcp install --claude-3p
```

Obsidian remains a separate plugin, but Azure can register its standalone,
vault-locked MCP server in Claude-3p when requested:

```bash
azure mcp install --claude-3p --include-obsidian
```

This adds Claude's `obsidian` MCP entry without moving or copying the plugin.
The plugin's skills and server stay together under `plugins/obsidian`.

The unrestricted `azure-osascript` server is bundled but disabled by default.
Enable it only when you need arbitrary AppleScript or JXA:

```bash
azure mcp install --include-raw-osascript
# Claude-3p, including raw osascript:
azure mcp install --claude-3p --include-raw-osascript
```

`web_fetch` accepts only public HTTP(S) destinations and rejects private/local
network targets, error pages, oversized responses, unsupported binary content,
redirect loops, and timeouts. Mac apps opened by `azure-mac-control` are closed
after the call; apps already running before the call are left alone.

### Codex Desktop (experimental)

This integration is a work in progress and can still break on app or protocol
changes. Keep `azure codex restore` as the escape hatch back to the normal
subscription connection.

`azure codex setup` generates a deterministic catalog of real, provider-prefixed
IDs such as `nvidia/z-ai/glm-5.2`, `opencode/big-pickle`, or an authenticated
provider's discovered IDs. Codex connects directly to Azure's `/v1/responses`
endpoint. The Codex catalog never advertises Claude aliases (`fable`, `opus`,
`sonnet`, `haiku`); those remain available only to Claude Code.

Choose one directly when scripting:

```bash
azure codex setup --model nvidia/z-ai/glm-5.2
azure codex start
```

The catalog contains only the efforts declared for each model. Unsupported
choices are rejected before Azure contacts a provider. Model and effort arrive on
every request, so separate Codex tasks stay independent. `azure codex restore`
removes active Azure/OpenCodex routing and writes the durable sanitized
subscription baseline while retaining the raw snapshot for recovery.

Codex real-model IDs route to that exact provider and model. Each request goes
directly to the selected provider with no automatic fallback or rerouting.

Codex's free-form custom tools are bridged through Chat Completions without
changing their native Responses call or streaming shape. Provider-hosted tools
such as web search are not Azure capabilities and return a clear backend-specific
error if Codex sends one. Codex 0.144.2 enables web search by default, so
`azure codex` disables it only for the active Azure connection; `azure codex restore`
returns the previous subscription-safe setting.

### Native provider login

Kimi uses device authorization. xAI/Grok browser OAuth is experimental because
an endorsed third-party flow could not be confirmed; `XAI_API_KEY` remains the
stable alternative. Anthropic uses `ANTHROPIC_API_KEY` as the stable inference
path. `--import-claude-code` makes an explicit, read-only Azure copy but is not
advertised for inference, and unsupported subscription impersonation is not
implemented.

```bash
azure auth login kimi
azure auth login xai
azure auth login anthropic
azure auth status
```

OAuth credentials are stored in macOS Keychain. A private file store is used
only when explicitly enabled with `AZURE_AUTH_STORE=file` and an absolute
`AZURE_AUTH_FILE_DIR`. OpenCodex is no longer installed, started, configured, or
required by Azure. Existing user-installed OpenCodex files are left untouched.
`azure codex setup` safely migrates an active port-10100 connection while
preserving unrelated Codex providers; it does not read or move OpenCodex auth.

## Configuration

Azure reads `~/.config/azure/config.json` by default. Claude aliases (`fable`,
`opus`, `sonnet`, `haiku`) each point to one direct provider/model route with no
automatic fallbacks. Provider errors return directly to the client — no silent
model or provider switching. Azure hot-reloads the config file on every request;
no restart needed for config-only changes.

Provider keys belong in `~/.config/azure/.env`, never in `config.json` or Git.
You can name any provider in `providers` as long as it exposes an
OpenAI-compatible `/chat/completions` endpoint.

Use a direct provider path to bypass family routing for one request:

```
<anything>/<provider>/<model...>
```

For example, `anthropic/nvidia/z-ai/glm-5.2` uses the `nvidia` provider from
your config and sends it `z-ai/glm-5.2`.

Thinking budgets map to the closest `reasoning_effort` value in your config:

```json
"effort": {
  "low":       { "budget": 2000,  "reasoning": "low" },
  "medium":    { "budget": 6000,  "reasoning": "low" },
  "high":      { "budget": 16000, "reasoning": "medium" },
  "xhigh":     { "budget": 24000, "reasoning": "high" },
  "max":       { "budget": 32000, "reasoning": "high" },
  "ultracode": { "budget": 48000, "reasoning": "high" }
}
```

## What it handles

- Anthropic Messages, OpenAI Responses, and OpenAI Chat Completions endpoints.
- Streaming responses, parallel tool calls, tool results, images, and file parts.
- Codex model discovery and multi-turn tool calls.
- Per-provider rate limiting and retrying.
- Live terminal and web dashboards with request logs.
- Config validation before the gateway starts.

## Model traits

Known provider and model behaviors to be aware of:

- **nemotron-ultra (550B) is slow.** A 32000-token reasoning budget can hang 6+
  minutes on a trivial prompt. At 8000 it answers in ~99s. Only a model swap
  fixes the speed.
- **big-pickle** (opencode) is a codename for `deepseek-v4-flash` — a reasoning
  model that returns EMPTY content if `max_tokens` is too low (it spends the
  entire budget on `reasoning_content`). Always set `max_tokens` high enough to
  leave room for visible output.
- **NVIDIA reasoning models** (nemotron, deepseek, glm) are text-only. Do not
  send images to these routes.
- **Gemini 3.x multi-turn tools work** — the proxy injects
  `skip_thought_signature_validator` automatically. The old rule restricting
  Gemini to single-turn requests is obsolete.
- **MiniMax M3** rejects `reasoning_budget` — it reasons natively without one.
  Its tool support is partial (`DEGRADED function cannot be invoked`), so it is
  excluded from requests carrying tools.

## Routing architecture

Azure supports two routing paths:

**Claude aliases** (`anthropic/claude-fable`, `anthropic/claude-opus`,
`anthropic/claude-sonnet`, `anthropic/claude-haiku`). Each alias maps to one
direct provider and model. Provider errors are returned as-is — no automatic
fallback or model switching. These four are the only Claude aliases;
`claude-writer` is obsolete.

**Codex model IDs** (e.g. `nvidia/z-ai~sglm-5.2`, `opencode/big-pickle`). Codex
uses exact provider-prefixed stable IDs from the `models` section of
`config.json`. Each ID routes to exactly one provider/model with no alias lookup
or fallback chain. Codex never uses Claude aliases.

**Direct provider path.** Any request to
`anthropic/<provider>/<model>` (e.g. `anthropic/nvidia/z-ai/glm-5.2`) bypasses
alias and family routing and uses the named provider directly.

## Identity

Azure identifies itself as `I'm Kabir's Second Brain.` It does not inject
provider-specific imitation prompts. The current provider and model are included
in the prompt visible to the model so they can be disclosed only when the user
explicitly asks. Codex and Claude Code each receive their own client-specific
adapter — neither receives the other's identity wrapper.

## Security

Azure has no authentication and listens on loopback only (`127.0.0.1`). Do not
change it to a LAN or internet-facing address. If another local process can
reach that port, it can use your provider keys through Azure.

- Keep `~/.config/azure/.env` private. `chmod 600 ~/.config/azure/.env` is a good
  default on a shared machine.
- Azure does not provide TLS. Do not expose it to the internet.
- Prompts, tool data, and images leave your machine for the provider selected
  by the route.
- The web endpoints allow cross-origin requests. That is useful for local tools,
  but makes network exposure riskier.

## From source

```bash
go install github.com/ATruePerson/azure@latest
# Note: Go module path is still github.com/ATruePerson/azure until the GitHub
# repo is renamed; rename the installed binary: mv "$(go env GOPATH)/bin/acc" "$(go env GOPATH)/bin/azure"
# Or in this repository:
go run . -config config.json
```

If you start the gateway yourself, point Anthropic clients at it:

```bash
export ANTHROPIC_BASE_URL=http://localhost:9999
```

The `-env` flag loads a dotenv file, defaulting to `~/.config/azure/.env`.
Existing environment variables win over values from that file.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Health check. Returns `azure-proxy ok`. |
| `GET /v1/models` | Model discovery for Anthropic and OpenAI clients. |
| `POST /v1/messages` | Anthropic Messages API. |
| `POST /v1/responses` | OpenAI Responses API, used by Codex. |
| `POST /v1/chat/completions` | OpenAI-compatible chat endpoint. |
| `GET /app` | Web dashboard. |

## Tests

```bash
make test
```

### Development

Azure is maintained by Kabir and developed with assistance from OpenAI Codex.

## License

Apache License 2.0. See [LICENSE](LICENSE).
