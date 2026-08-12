# Azure

Azure is a local, loopback-only provider gateway for Claude and Codex. It
routes Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses to the
providers configured in `~/.config/azure`.

## Quick start

```sh
bun install
bun run typecheck
bun test
bun run build
./dist/azure doctor
./dist/azure
```

The default configuration is split so secrets stay private:

```text
~/.config/azure/providers.json
~/.config/azure/claude/config.json
~/.config/azure/codex/config.json
~/.config/azure/.env
```

Provider keys may be written as `${PROVIDER_KEY}` references. Azure binds to
`127.0.0.1` only and never exposes provider credentials in its status page,
catalog, or logs.

## Commands

```text
azure                   Start the gateway
azure setup             Validate the Azure configuration
azure doctor            Validate providers, routes, and models
azure models            List enabled models
azure claude            Start Azure and launch Claude Code
azure codex setup       Configure Codex to use Azure
azure codex remove      Remove Azure/ACC-owned Codex routing
azure codex status      Show safe Codex routing status
azure mcp install       Install Azure Search in Claude-3p
azure mcp serve search  Serve Azure Search over MCP stdio
azure mcp doctor        Validate Azure Search
```

## Azure Search

Azure Search is the bundled MCP server. It provides `web_search` across public
web, Hacker News, GitHub, Polymarket, and Reddit, plus guarded `web_fetch` for
readable public HTTP(S) pages. Private-network targets, redirects, binaries,
oversized responses, and invalid URLs are rejected.

## Development

```sh
bun run typecheck
bun test
bun run build
```

The repository is TypeScript-first and uses Bun for the runtime, tests, and
standalone executable. The compiled binary is intentionally not tracked.
