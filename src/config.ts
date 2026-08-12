import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, ModelCapability, ResolvedRoute, Route } from "./types.ts";

const forbiddenConfigKeys = ["fallbacks", "fallback_model", "fallback_models", "image_model", "image_fallback_models"];

function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandEnv(child)]));
  }
  return value;
}

function mergeSections(sections: unknown[]): Record<string, unknown> {
  return Object.assign({}, ...sections.filter((section): section is Record<string, unknown> => !!section && typeof section === "object"));
}

async function loadDotEnv(root: string): Promise<void> {
  const text = await Bun.file(join(root, ".env")).text().catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    process.env[match[1]] = value;
  }
}

function cleanRoute(route: Route): Route {
  const copy = { ...route };
  delete (copy as Route & { fallbacks?: unknown }).fallbacks;
  return copy;
}

export function azureConfigDir(): string {
  return process.env.AZURE_CONFIG_DIR || join(homedir(), ".config", "azure");
}

export async function loadConfig(root = azureConfigDir()): Promise<Config> {
  await loadDotEnv(root);
  const legacyPath = join(root, "config.json");
  let raw: string;
  const splitPaths = [join(root, "providers.json"), join(root, "claude", "config.json"), join(root, "codex", "config.json")];
  const splitAvailable = (await Promise.all(splitPaths.map(async (path) => { try { await Bun.file(path).stat(); return true; } catch { return false; } }))).every(Boolean);
  if (splitAvailable) {
    const [providers, claude, codex] = await Promise.all([
      Bun.file(join(root, "providers.json")).json(),
      Bun.file(join(root, "claude", "config.json")).json(),
      Bun.file(join(root, "codex", "config.json")).json(),
    ]);
    raw = JSON.stringify(mergeSections([providers, claude, codex]));
  } else {
    raw = await Bun.file(legacyPath).text();
  }
  for (const key of forbiddenConfigKeys) {
    if (raw.toLowerCase().includes(`"${key}"`)) throw new Error(`unsupported config key: ${key}`);
  }
  const config = expandEnv(JSON.parse(raw)) as Partial<Config>;
  const normalized: Config = {
    port: config.port || 9999,
    providers: config.providers || {},
    routes: config.routes || {},
    alias_routes: config.alias_routes || {},
    aliases: config.aliases || {},
    models: config.models || {},
    effort: config.effort || {},
    system_prepend: config.system_prepend || "",
  };
  validateConfig(normalized);
  return normalized;
}

export function validateConfig(config: Config): void {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("port must be 1-65535");
  if (!Object.keys(config.providers).length) throw new Error("at least one provider is required");
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.base_url || !/^https?:\/\//.test(provider.base_url)) throw new Error(`provider ${name} has an invalid base_url`);
    if (provider.adapter && !["openai", "anthropic"].includes(provider.adapter.toLowerCase())) throw new Error(`provider ${name} has an unsupported adapter`);
  }
  for (const [name, route] of Object.entries({ ...config.routes, ...config.alias_routes, ...(config.aliases || {}) })) {
    if (!config.providers[route.provider]) throw new Error(`route ${name} references unknown provider ${route.provider}`);
  }
  for (const [id, capability] of Object.entries(config.models)) {
    if (!capability.enabled) continue;
    if (capability.route && !config.routes[capability.route]) throw new Error(`model ${id} references unknown route ${capability.route}`);
    if (!capability.route && (!capability.provider || !capability.model)) throw new Error(`model ${id} needs provider/model or route`);
    if (capability.provider && !config.providers[capability.provider]) throw new Error(`model ${id} references unknown provider ${capability.provider}`);
  }
}

export function resolveRoute(config: Config, id: string): ResolvedRoute {
  const capability: ModelCapability | undefined = config.models[id];
  if (capability && !capability.enabled) throw new Error(`model ${id} is disabled`);
  if (capability?.route) {
    const route = config.routes[capability.route];
    if (!route) throw new Error(`model ${id} route is missing`);
    return { ...cleanRoute(route), id, capability };
  }
  if (capability?.provider && capability.model) return { id, provider: capability.provider, model: capability.model, capability };
  const legacyAlias = id.toLowerCase().match(/(?:^|\/)claude-(fable|mythos|opus|sonnet|haiku)(?:$|[-/])/i)?.[1];
  const alias = legacyAlias === "mythos" ? "fable" : legacyAlias;
  const route: Route | undefined = config.alias_routes[id] || config.aliases?.[id] || config.routes[id] || (alias ? config.alias_routes[alias] || config.aliases?.[alias] : undefined);
  if (!route) throw new Error(`unknown model: ${id}`);
  return { ...cleanRoute(route), id };
}

export function resolveEffort(route: ResolvedRoute, requested?: string): Record<string, unknown> {
  const effort = requested || route.reasoning_effort;
  if (!effort) return {};
  const target = route.reasoning?.[effort];
  if (!target) return route.reasoning_locked ? {} : { reasoning_effort: effort };
  return { ...(target.effort ? { reasoning_effort: target.effort } : {}), ...(target.extra_body || {}) };
}

export class ConfigStore {
  private current?: Config;
  private modified = "";
  constructor(private readonly root = azureConfigDir()) {}
  async get(): Promise<Config> {
    const paths = ["config.json", "providers.json", join("claude", "config.json"), join("codex", "config.json")];
    const stamp = (await Promise.all(paths.map(async (path) => {
      const file = await Bun.file(join(this.root, path)).stat().catch(() => undefined);
      return file ? `${file.mtimeMs}:${file.size}` : "0";
    }))).join(":");
    if (!this.current || stamp !== this.modified) {
      this.current = await loadConfig(this.root);
      this.modified = stamp;
    }
    return this.current;
  }
}
