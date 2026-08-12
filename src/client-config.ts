import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, rename, stat, unlink } from "node:fs/promises";
import type { Config } from "./types.ts";
import { azureConfigDir } from "./config.ts";

const rootBegin = "# BEGIN AZURE CODEX OWNED";
const rootEnd = "# END AZURE CODEX OWNED";
const providerMarker = "# AZURE CODEX OWNED PROVIDER";

function codexHome(): string { return process.env.CODEX_HOME || join(homedir(), ".codex"); }
function codexConfigPath(): string { return join(codexHome(), "config.toml"); }
function catalogPath(): string { return join(codexHome(), "azure-models.json"); }
function restorePath(): string { return join(azureConfigDir(), "codex-typescript-backup.json"); }

export function mcpInvocation(executable = process.execPath): { command: string; args: string[] } {
  const script = process.argv[1];
  return script?.endsWith(".ts") ? { command: executable, args: [script, "mcp", "serve", "search"] } : { command: executable, args: ["mcp", "serve", "search"] };
}

async function readText(path: string): Promise<string> { return Bun.file(path).text().catch(() => ""); }
async function writeAtomic(path: string, text: string): Promise<void> {
  const mode = await stat(path).then((value) => value.mode & 0o777).catch(() => 0o600);
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await Bun.write(temporary, text);
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function removeTomlBlock(text: string, table: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[.*\]\s*$/.test(lines[end])) end++;
  lines.splice(start, end - start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function removeAzureRoot(text: string): string {
  let output = text;
  const start = output.indexOf(rootBegin);
  const end = output.indexOf(rootEnd);
  if (start >= 0 && end >= start) {
    output = `${output.slice(0, start)}${output.slice(end + rootEnd.length)}`;
  }
  output = output.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("model_provider =")) return !/\"(?:azure|acc)\"/.test(trimmed);
    if (trimmed.startsWith("model_catalog_json =")) return !/(?:azure|codex-models)/i.test(trimmed);
    if (trimmed.startsWith("openai_base_url =")) return !/(?:127\.0\.0\.1|azure)/i.test(trimmed);
    return true;
  }).join("\n");
  output = removeTomlBlock(output, "model_providers.azure");
  output = removeTomlBlock(output, "model_providers.acc");
  output = output.split(/\r?\n/).filter((line) => ![providerMarker, "# ACC CODEX OWNED PROVIDER"].includes(line.trim())).join("\n");
  output = output.replace(/\n{3,}/g, "\n\n").trim();
  return output ? `${output}\n` : "";
}

function catalogEntries(config: Config): Array<Record<string, unknown>> {
  return Object.entries(config.models)
    .filter(([, capability]) => capability.enabled && capability.catalog_visible !== false)
    .sort(([, left], [, right]) => (left.catalog_priority || 999) - (right.catalog_priority || 999))
    .map(([id, capability], index) => ({
      slug: id,
      display_name: capability.display_name || id,
      description: capability.description || `Azure model ${id}`,
      default_reasoning_level: Object.keys(capability.reasoning || {}).find((effort) => ["max", "xhigh", "high", "medium", "low", "minimal"].includes(effort)) || "minimal",
      supported_reasoning_levels: Object.keys(capability.reasoning || {}).map((effort) => ({ effort, description: effort })),
      visibility: "list",
      supported_in_api: true,
      priority: index + 1,
      modalities: capability.image_input_support ? ["text", "image"] : ["text"],
    }));
}

export async function configureCodex(config: Config, model?: string, baseURL = `http://127.0.0.1:${config.port}/v1`): Promise<{ configPath: string; catalogPath: string; backupPath: string }> {
  const configPath = codexConfigPath();
  const catalog = catalogPath();
  const backup = restorePath();
  const original = await readText(configPath);
  const selected = model || Object.keys(config.models).find((id) => config.models[id].enabled) || "";
  if (!selected || !config.models[selected]?.enabled) throw new Error(`unknown or disabled model: ${selected || "(none)"}`);
  let hasBackup = true;
  try { await Bun.file(backup).stat(); } catch { hasBackup = false; }
  if (!hasBackup) {
    const rootLines = original.split(/\r?\n/).filter((line) => /^\s*(model|model_reasoning_effort|web_search)\s*=/.test(line));
    await writeAtomic(backup, JSON.stringify({ root: rootLines }, null, 2) + "\n");
  }
  const root = [rootBegin, `model = ${JSON.stringify(selected)}`, `model_provider = "azure"`, `model_catalog_json = ${JSON.stringify(catalog)}`, `web_search = "disabled"`, rootEnd, ""].join("\n");
  const rest = removeAzureRoot(original).split(/\r?\n/).filter((line, index, lines) => {
    const firstTable = lines.findIndex((candidate) => /^\s*\[.*\]\s*$/.test(candidate));
    if (index > firstTable && firstTable >= 0) return true;
    return !/^\s*(model|model_reasoning_effort|web_search)\s*=/.test(line);
  }).join("\n");
  const provider = [providerMarker, "[model_providers.azure]", 'name = "Azure"', `base_url = ${JSON.stringify(baseURL.replace(/\/$/, ""))}`, 'wire_api = "responses"', "requires_openai_auth = true", "supports_websockets = false", ""].join("\n");
  await writeAtomic(catalog, JSON.stringify({ models: catalogEntries(config) }, null, 2) + "\n");
  await writeAtomic(configPath, `${root}${rest}${rest ? "\n" : ""}${provider}`);
  return { configPath, catalogPath: catalog, backupPath: backup };
}

export async function removeCodexRouting(): Promise<{ configPath: string; removed: boolean }> {
  const configPath = codexConfigPath();
  const original = await readText(configPath);
  if (!original.includes(rootBegin) && !original.includes("[model_providers.azure]") && !original.includes("[model_providers.acc]") && !original.includes("# ACC CODEX OWNED PROVIDER")) return { configPath, removed: false };
  const backup = restorePath();
  try {
    const saved = JSON.parse(await Bun.file(backup).text()) as { root?: string[] };
    if (Array.isArray(saved.root)) {
      const restored = removeAzureRoot(original);
      const root = saved.root.length ? `${saved.root.join("\n")}\n\n` : "";
      await writeAtomic(configPath, `${root}${restored}`);
      return { configPath, removed: true };
    }
  } catch { /* no TypeScript backup; fall through to marker removal */ }
  await writeAtomic(configPath, removeAzureRoot(original));
  return { configPath, removed: true };
}

export async function installClaudeSearch(executable: string, path = join(homedir(), "Library", "Application Support", "Claude-3p", "claude_desktop_config.json"), args = ["mcp", "serve", "search"]): Promise<string> {
  const original = await Bun.file(path).json() as Record<string, unknown>;
  const servers = (original.mcpServers && typeof original.mcpServers === "object" ? original.mcpServers : {}) as Record<string, unknown>;
  for (const name of Object.keys(servers)) if (/^(azure|acc)(?:[-_]|$)/i.test(name) || ["websearch", "mac-control", "osascript"].includes(name)) delete servers[name];
  servers["azure-search"] = { type: "stdio", command: executable, args };
  original.mcpServers = servers;
  const backup = `${path}.azure-backup-${Date.now()}`;
  await writeAtomic(backup, JSON.stringify(await Bun.file(path).json(), null, 2) + "\n");
  await writeAtomic(path, JSON.stringify(original, null, 2) + "\n");
  return backup;
}
