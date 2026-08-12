import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCodex, installClaudeSearch, removeCodexRouting } from "../src/client-config.ts";
import type { Config } from "../src/types.ts";

const config: Config = { port: 9999, providers: { test: { base_url: "https://provider.test" } }, routes: {}, alias_routes: {}, models: { fast: { display_name: "Fast", provider: "test", model: "fast", enabled: true, tool_call_support: true, streaming_support: true, image_input_support: false, file_input_support: false, max_context: 1000, max_output: 100 } }, effort: {} };

test("Codex setup and remove preserve unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-codex-"));
  process.env.CODEX_HOME = root;
  process.env.AZURE_CONFIG_DIR = `${root}/azure`;
  await Bun.write(`${root}/config.toml`, 'model = "native"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n');
  await Bun.write(`${root}/azure/.keep`, "");
  await configureCodex(config, "fast");
  const configured = await Bun.file(`${root}/config.toml`).text();
  expect(configured).toContain('model_provider = "azure"');
  expect(configured).toContain('[projects."/tmp"]');
  await removeCodexRouting();
  const removed = await Bun.file(`${root}/config.toml`).text();
  expect(removed).not.toContain("model_provider = \"azure\"");
  expect(removed).toContain('model = "native"');
  expect(removed).toContain('[projects."/tmp"]');
});

test("Claude install removes only Azure-owned servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-claude-"));
  const path = `${root}/claude.json`;
  await Bun.write(path, JSON.stringify({ mcpServers: { "azure-websearch": { command: "acc" }, unrelated: { command: "keep" } } }));
  await installClaudeSearch("/tmp/azure", path);
  const updated = await Bun.file(path).json() as any;
  expect(updated.mcpServers["azure-search"].args).toEqual(["mcp", "serve", "search"]);
  expect(updated.mcpServers.unrelated.command).toBe("keep");
  expect(updated.mcpServers["azure-websearch"]).toBeUndefined();
});

test("Codex rejects an unknown model before writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-codex-invalid-"));
  process.env.CODEX_HOME = root;
  process.env.AZURE_CONFIG_DIR = `${root}/azure`;
  const path = `${root}/config.toml`;
  await Bun.write(path, 'model = "native"\n');
  await expect(configureCodex(config, "missing")).rejects.toThrow(/unknown|disabled/);
  expect(await Bun.file(path).text()).toBe('model = "native"\n');
});
