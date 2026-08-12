# Azure

Azure is a Bun/TypeScript local gateway for Claude and Codex. It translates
client protocols into OpenAI-compatible requests for configured providers.

Read [`Azure.md`](Azure.md) for the current client-routing and configuration
rules before changing Codex or Claude integration.

## Architecture

| Area | File |
| :--- | :--- |
| CLI and lifecycle | `src/cli.ts` |
| Configuration and model resolution | `src/config.ts` |
| Provider transport | `src/provider.ts` |
| Protocol translation | `src/protocol.ts` |
| Bun HTTP server and status page | `src/server.ts` |
| Azure Search MCP | `src/mcp.ts`, `src/search.ts` |
| Client configuration | `src/client-config.ts` |

## Private runtime paths

- **Binary**: `/Users/kabir/.local/bin/azure`
- **Config**: the split files in `/Users/kabir/.config/azure/` (`providers.json`,
  `claude/config.json`, and `codex/config.json`)
- **Provider environment**: `/Users/kabir/.config/azure/.env`

Never commit provider keys, request bodies, prompt content, or runtime logs.
Azure binds to loopback only (`127.0.0.1`).

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

The compiled executable is `dist/azure` and is ignored by Git.

## Client rules

- Azure is the only custom router managed by this repository.
- ACC is a separate project. Do not copy its config or credentials and do not
  add ACC labels, provider blocks, catalogs, or migration paths.
- Codex writes are atomic and limited to Azure-owned blocks.
- Claude-3p installation removes only Azure/ACC-owned MCP entries and preserves
  unrelated servers.
