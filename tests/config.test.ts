import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveRoute, validateConfig } from "../src/config.ts";

test("loads the private split provider, Claude, and Codex layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-config-"));
  delete process.env.DOTENV_KEY;
  await Bun.write(`${root}/.env`, "DOTENV_KEY=from-dotenv\n");
  await Bun.write(`${root}/providers.json`, JSON.stringify({ port: 9999, providers: { test: { base_url: "https://provider.test", api_key: "${DOTENV_KEY}" } } }));
  await Bun.write(`${root}/claude/config.json`, JSON.stringify({ alias_routes: { sonnet: { provider: "test", model: "sonnet" } } }));
  await Bun.write(`${root}/codex/config.json`, JSON.stringify({ models: { fast: { display_name: "Fast", provider: "test", model: "fast", enabled: true, tool_call_support: true, streaming_support: true, image_input_support: false, file_input_support: false, max_context: 1000, max_output: 100 } } }));
  const config = await loadConfig(root);
  expect(config.providers.test.api_key).toBe("from-dotenv");
  expect(resolveRoute(config, "sonnet").model).toBe("sonnet");
  expect(resolveRoute(config, "anthropic/claude-sonnet").model).toBe("sonnet");
  expect(resolveRoute(config, "fast").model).toBe("fast");
});

test("rejects fallback keys and unknown providers", () => {
  expect(() => validateConfig({ port: 9999, providers: { test: { base_url: "https://provider.test" } }, routes: {}, alias_routes: {}, models: {}, effort: {} })).not.toThrow();
  expect(() => validateConfig({ port: 9999, providers: { test: { base_url: "https://provider.test" } }, routes: { bad: { provider: "missing", model: "x" } }, alias_routes: {}, models: {}, effort: {} })).toThrow(/unknown provider/);
  expect(() => validateConfig({ port: 9999, providers: { test: { base_url: "https://provider.test", adapter: "unknown" } }, routes: {}, alias_routes: {}, models: {}, effort: {} })).toThrow(/adapter/);
});
