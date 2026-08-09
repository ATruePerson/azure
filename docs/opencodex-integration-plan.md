# OpenCodex integration plan (historical)

> Superseded by the native direct integration. Kept only as historical design
> evidence; none of these commands or dependencies are current Azure behavior.

Status: implementation in progress on `feat/opencodex-codex-integration`.

## Decision

Keep Azure as the provider and routing layer. Add OpenCodex as an optional local
Codex compatibility layer in front of Azure:

```text
Codex CLI/App -> OpenCodex (127.0.0.1:10100) -> Azure (127.0.0.1:9999) -> configured upstream
```

OpenCodex uses its documented `openai-chat` adapter and Azure's existing
`/v1/chat/completions` endpoint. Azure continues to own provider credentials,
Claude routes, model fallbacks, rate limits, and the Responses translation
surface.

## Completion criteria

- Azure and OpenCodex bind to loopback only.
- The Azure-backed OpenCodex provider is generated from the live Azure `/v1/models`
  response, so no model IDs are invented.
- Setup backs up local configuration before changing it and never stores a
  provider key in OpenCodex.
- Restore leaves Codex history alone and returns native Codex configuration.
- A deterministic doctor command reports PASS, FAIL, or SKIPPED instead of
  treating HTTP 200 alone as proof of a working route.
- Existing Azure tests and behavior remain unchanged except for the explicit
  loopback binding hardening.

## Verification plan

1. Run the Azure baseline and final test suites.
2. Validate setup and config merging against a local fake Azure `/v1/models`
   server without using credentials or real provider calls.
3. Run the integration doctor against the live local services when available.
4. Run sanitized live smoke tests only for routes and providers that are
   already configured and reachable; report unavailable credentials as
   SKIPPED.
5. Review the final diff, ignored-secret rules, and untracked files before
   committing.

## External reference checked

The current OpenCodex documentation and source project were checked before
implementation. The package is `@bitkyc08/opencodex`, installed with npm, and
the project is MIT licensed. OpenCodex state lives under `~/.opencodex`, and
Codex injection is reversible through `ocx restore` or `ocx stop`.
