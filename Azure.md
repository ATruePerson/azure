# Azure runtime notes

Azure owns the local provider gateway and its private configuration under
`~/.config/azure`. The separate ACC project is not a runtime dependency and is
never copied or migrated automatically.

## Client routes

Codex and Claude may use Azure through the loopback endpoint. `azure codex
setup` writes only the Azure-owned TOML block and catalog, preserving unrelated
Codex settings. `azure codex remove` removes Azure and legacy ACC-owned routing
without touching native subscription settings.

Claude-3p receives one Azure MCP entry, `azure-search`, which invokes the
compiled `azure` executable. Unrelated MCP servers are preserved.

## Safety

- The HTTP gateway binds to `127.0.0.1`.
- Provider keys stay in `~/.config/azure/.env` or environment variables.
- Status pages and catalogs never include keys or prompt content.
- Config writes use temporary files and atomic replacement.
- Provider failures return a bounded status error; no silent provider fallback
  is introduced.
