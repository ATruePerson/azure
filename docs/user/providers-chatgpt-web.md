# ChatGPT Web

ChatGPT Web is an unofficial provider backed by the `codex-chatgpt-web` launcher. Azure Code
does not automate the launcher, store its credentials, or call ChatGPT directly. It starts the
same Codex app-server harness as the native Codex provider and filters the catalog to models named
`chatgpt-web/*`.

## Requirements

- Install and start the [codex-chatgpt-web launcher](https://github.com/miuuyy/codex-chatgpt-web).
- Sign in through the launcher's browser flow.
- Install the launcher's ChatGPT Web models.
- Run the launcher and Azure Code server on the same host. Remote and mobile clients can then use
  the provider through that server.
- Configure the Codex binary path and `CODEX_HOME` in the ChatGPT Web provider when they are not
  available on the server's `PATH` or default home.

Add **ChatGPT Web** in Settings, refresh provider status, and select a `chatgpt-web/*` model. The
provider has its own continuation identity but shares the configured Codex home, so Codex hooks,
plugins, skills, MCP, attachments, approvals, interaction modes, and full-harness behavior remain
available.

## Browser-only mode

Browser-only mode can send messages and receive streamed replies, but it cannot use local tools.
Use full-harness mode when the task needs files, terminals, MCP, or other local computer access.

## Troubleshooting

If no models appear, start the launcher, install its models, restart the Codex app once, and refresh
provider status. If the provider remains unavailable, verify that the launcher and Azure Code are
running on the same machine and that the configured Codex home is the one used by the launcher.

This integration is unofficial and depends on the launcher's compatibility with the Codex
app-server protocol. Keep the launcher updated and do not treat it as an OpenAI-supported product.
