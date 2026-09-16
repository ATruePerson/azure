// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { spawn } from "node:child_process";

import type {
  AzureCapabilityKind,
  CapabilityControl,
  CodexCapabilities,
  CodexCapabilityItem,
  ServerProviderSkill,
} from "@azure/contracts";
import { parse as parseYaml } from "yaml";

const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const SAFE_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const CAPABILITY_STATE_FILE = "capabilities-state.json";
const SKILL_STATE_FILE = "skills-state.json";
const defaultAzureHome = () =>
  process.env.AZURE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".azure");
const DEFAULT_TRUSTED_ROOTS = [
  NodePath.join(NodeOS.homedir(), ".codex"),
  NodePath.join(NodeOS.homedir(), ".azure"),
  NodePath.join(NodeOS.homedir(), ".config", "azure"),
  NodePath.join(NodeOS.homedir(), "Developer", "AI"),
  NodePath.join(NodeOS.homedir(), "Documents"),
] as const;
const SKILL_TOKEN = /\$([A-Za-z0-9][A-Za-z0-9._-]{0,127})/gu;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1024;
const MAX_HOOK_TIMEOUT_MS = 30_000;

type RegistryKind = "hooks" | "plugins" | "skills" | "mcpServers";
type IconCategory = "hooks" | "plugins" | "skills" | "mcp";
type DisabledCapabilities = Record<AzureCapabilityKind, Set<string>>;
type ProjectOnlyMap = Record<AzureCapabilityKind, Record<string, string[]>>;

interface CapabilityState {
  readonly disabled: DisabledCapabilities;
  readonly projectOnly: ProjectOnlyMap;
}

function emptyProjectOnly(): ProjectOnlyMap {
  return { hooks: {}, plugins: {}, skills: {}, mcp: {} };
}

interface PluginManifest {
  readonly path: string;
  readonly contents: Record<string, unknown>;
}

export interface AzurePortableSkill {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly root: string;
  readonly contents: string;
  readonly enabled: boolean;
  readonly source: "azure" | "plugin";
  readonly description?: string;
}

export interface AzureMcpServerDescriptor {
  readonly id: string;
  readonly name: string;
  readonly toolPrefix: string;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type AzurePortableHookEvent = "SessionStart" | "UserPromptSubmit";

export interface AzurePortableHook {
  readonly id: string;
  readonly name: string;
  readonly event: AzurePortableHookEvent;
  readonly matcher?: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly pluginRoot: string;
}

export interface AzurePortableHookResult {
  readonly hook: AzurePortableHook;
  readonly outcome: "success" | "error" | "cancelled";
  readonly output?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly additionalContext?: string;
}

export class AzureSkillResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AzureSkillResolutionError";
  }
}

function item(
  id: string,
  label: string,
  detail: string,
  enabled: boolean | undefined = undefined,
  canToggle = false,
  icon?: { readonly category: IconCategory; readonly id: string },
  control?: CapabilityControl,
): CodexCapabilityItem {
  return {
    id,
    label,
    detail,
    ...(enabled === undefined ? {} : { enabled, restartRequired: true }),
    canToggle,
    ...(icon ? { icon } : {}),
    ...(control ? { control } : {}),
  };
}

function emptyDisabledCapabilities(): DisabledCapabilities {
  return { hooks: new Set(), plugins: new Set(), skills: new Set(), mcp: new Set() };
}

function mcpCapabilityId(fileId: string, serverName: string): string {
  const safeServer = serverName.replace(/[^A-Za-z0-9._-]/gu, "_");
  return `${fileId}__${safeServer}`.slice(0, 128);
}

function readMcpServers(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const servers = (value as Record<string, unknown>).mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" && key.trim() ? [[key, entry] as const] : [],
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
}

async function readPluginManifest(
  directory: string,
  trustedRoots: ReadonlyArray<string>,
  key?: "hooks" | "skills",
): Promise<PluginManifest | undefined> {
  let fallback: PluginManifest | undefined;
  for (const path of [
    NodePath.join(directory, "plugin.json"),
    NodePath.join(directory, ".azure-plugin", "plugin.json"),
    NodePath.join(directory, ".codex-plugin", "plugin.json"),
    NodePath.join(directory, ".claude-plugin", "plugin.json"),
  ]) {
    if (!(await isBoundedTrustedRegularFile(path, trustedRoots))) continue;
    try {
      const contents = JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
      if (contents && typeof contents === "object" && !Array.isArray(contents)) {
        const manifest = { path, contents: contents as Record<string, unknown> };
        if (!fallback) fallback = manifest;
        if (!key || key in manifest.contents) return manifest;
      }
    } catch {
      // Continue to another supported manifest location.
    }
  }
  return fallback;
}

function manifestPath(
  manifest: PluginManifest,
  value: unknown,
  pluginRoot: string,
): string | undefined {
  if (typeof value !== "string" || !value.trim() || NodePath.isAbsolute(value)) return undefined;
  for (const base of [pluginRoot, NodePath.dirname(manifest.path)]) {
    const candidate = NodePath.resolve(base, value);
    if (isWithinRoot(candidate, pluginRoot)) return candidate;
  }
  return undefined;
}

function manifestPaths(
  manifest: PluginManifest,
  value: unknown,
  pluginRoot: string,
): ReadonlyArray<string> {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    const path = manifestPath(manifest, entry, pluginRoot);
    return path ? [path] : [];
  });
}

function skillFrontmatter(contents: string): {
  readonly name?: string;
  readonly description?: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1] ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    return {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    };
  } catch {
    return {};
  }
}

function normalizedMcpDescriptor(
  id: string,
  name: string,
  value: unknown,
): AzureMcpServerDescriptor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const safeName = name.replace(/[^A-Za-z0-9._-]/gu, "_");
  const url = typeof source.url === "string" ? source.url.trim() : "";
  if (url && source.type !== "stdio" && source.type !== "local") {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
      return {
        id,
        name,
        toolPrefix: safeName,
        transport: "http",
        url: parsed.toString(),
        ...(() => {
          const headers = stringRecord(source.headers);
          return headers ? { headers } : {};
        })(),
      };
    } catch {
      return undefined;
    }
  }
  const command = Array.isArray(source.command)
    ? stringArray(source.command)
    : typeof source.command === "string" && source.command.trim()
      ? [source.command.trim()]
      : [];
  if (command.length === 0) return undefined;
  const args = [...command.slice(1), ...stringArray(source.args)];
  const env = stringRecord(source.env) ?? stringRecord(source.environment);
  return {
    id,
    name,
    toolPrefix: safeName,
    transport: "stdio",
    command: command[0]!,
    ...(args.length > 0 ? { args } : {}),
    ...(env ? { env } : {}),
  };
}

function normalizeOpenCodeMcpServer(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.type === "local" || source.type === "remote") return { ...source };
  if (typeof source.url === "string" && source.url.trim()) {
    return {
      type: "remote",
      url: source.url,
      ...(source.headers && typeof source.headers === "object" ? { headers: source.headers } : {}),
    };
  }
  const command = Array.isArray(source.command)
    ? source.command.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : typeof source.command === "string" && source.command.trim()
      ? [source.command]
      : [];
  if (command.length === 0) return null;
  return {
    type: "local",
    command,
    ...(source.environment && typeof source.environment === "object"
      ? { environment: source.environment }
      : {}),
  };
}

function matchesProjectScope(
  projectRoots: ReadonlyArray<string> | undefined,
  cwd?: string,
): boolean {
  if (!projectRoots || projectRoots.length === 0) return true;
  if (!cwd?.trim()) return false;
  const normalized = NodePath.resolve(cwd);
  return projectRoots.some((root) => {
    const resolved = NodePath.resolve(root);
    return normalized === resolved || normalized.startsWith(`${resolved}${NodePath.sep}`);
  });
}

function isEnabledInScope(item: CodexCapabilityItem, cwd?: string): boolean {
  return (
    item.detail === "Available" &&
    Boolean(item.enabled) &&
    matchesProjectScope(item.projectRoots, cwd)
  );
}

function readProjectOnlyMap(value: unknown): ProjectOnlyMap {
  const projectOnly = emptyProjectOnly();
  if (!value || typeof value !== "object" || Array.isArray(value)) return projectOnly;
  for (const kind of ["hooks", "plugins", "skills", "mcp"] as const) {
    const entries = (value as Record<string, unknown>)[kind];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [id, roots] of Object.entries(entries)) {
      if (!SAFE_ENTRY_NAME.test(id) || !Array.isArray(roots)) continue;
      const paths = roots.filter(
        (root): root is string => typeof root === "string" && root.trim().length > 0,
      );
      if (paths.length > 0) projectOnly[kind][id] = paths;
    }
  }
  return projectOnly;
}

async function readCapabilityState(azureHome: string): Promise<CapabilityState> {
  const disabled = emptyDisabledCapabilities();
  try {
    const raw = JSON.parse(
      await NodeFSP.readFile(NodePath.join(azureHome, CAPABILITY_STATE_FILE), "utf8"),
    ) as unknown;
    const record =
      raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const source = record.disabled;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      for (const kind of ["hooks", "plugins", "skills", "mcp"] as const) {
        const values = (source as Record<string, unknown>)[kind];
        if (Array.isArray(values)) {
          disabled[kind] = new Set(
            values.filter(
              (value): value is string => typeof value === "string" && SAFE_ENTRY_NAME.test(value),
            ),
          );
        }
      }
    }
    return { disabled, projectOnly: readProjectOnlyMap(record.projectOnly) };
  } catch {
    try {
      const raw = JSON.parse(
        await NodeFSP.readFile(NodePath.join(azureHome, SKILL_STATE_FILE), "utf8"),
      ) as unknown;
      const values =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as { disabledSkills?: unknown }).disabledSkills
          : undefined;
      if (Array.isArray(values)) {
        disabled.skills = new Set(
          values.filter(
            (value): value is string => typeof value === "string" && SAFE_ENTRY_NAME.test(value),
          ),
        );
      }
    } catch {
      // Missing state means every discovered capability is enabled globally.
    }
    return { disabled, projectOnly: emptyProjectOnly() };
  }
}

async function writeCapabilityState(azureHome: string, state: CapabilityState): Promise<void> {
  const statePath = NodePath.join(azureHome, CAPABILITY_STATE_FILE);
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  const projectOnly = Object.fromEntries(
    (["hooks", "plugins", "skills", "mcp"] as const).map((kind) => [
      kind,
      Object.fromEntries(
        Object.entries(state.projectOnly[kind]).filter(([, roots]) => roots.length > 0),
      ),
    ]),
  );
  await NodeFSP.writeFile(
    temporaryPath,
    `${JSON.stringify(
      {
        version: 2,
        disabled: Object.fromEntries(
          Object.entries(state.disabled).map(([kind, values]) => [kind, [...values].sort()]),
        ),
        projectOnly,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await NodeFSP.rename(temporaryPath, statePath);
}

function isWithinRoot(path: string, root: string): boolean {
  const relative = NodePath.relative(root, path);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      relative !== "..")
  );
}

async function metadataForTrustedPath(path: string, trustedRoots: ReadonlyArray<string>) {
  try {
    const metadata = await NodeFSP.lstat(path);
    if (!metadata.isSymbolicLink()) return metadata;
    const target = await NodeFSP.realpath(path);
    if (!trustedRoots.some((root) => isWithinRoot(target, root))) return null;
    return NodeFSP.stat(path);
  } catch {
    return null;
  }
}

async function isBoundedTrustedRegularFile(
  path: string,
  trustedRoots: ReadonlyArray<string>,
): Promise<boolean> {
  const metadata = await metadataForTrustedPath(path, trustedRoots);
  return metadata?.isFile() === true && metadata.size <= MAX_ENTRY_BYTES;
}

function iconPathFromManifest(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const interfaceRecord =
    record.interface && typeof record.interface === "object" && !Array.isArray(record.interface)
      ? (record.interface as Record<string, unknown>)
      : record;
  for (const key of ["logo", "logoUrl", "logoUrlDark", "composerIcon", "composerIconUrl"]) {
    const candidate = interfaceRecord[key];
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    if (candidate.includes("://") || NodePath.isAbsolute(candidate)) continue;
    return candidate;
  }
  return null;
}

async function iconPathFromPlugin(
  directory: string,
  trustedRoots: ReadonlyArray<string>,
): Promise<string | null> {
  for (const manifest of [
    NodePath.join(directory, "plugin.json"),
    NodePath.join(directory, ".azure-plugin", "plugin.json"),
    NodePath.join(directory, ".codex-plugin", "plugin.json"),
    NodePath.join(directory, ".claude-plugin", "plugin.json"),
  ]) {
    if (!(await isBoundedTrustedRegularFile(manifest, trustedRoots))) continue;
    try {
      const relative = iconPathFromManifest(JSON.parse(await NodeFSP.readFile(manifest, "utf8")));
      if (!relative) continue;
      const candidate = NodePath.resolve(NodePath.dirname(manifest), relative);
      if (!isWithinRoot(candidate, directory)) continue;
      const metadata = await metadataForTrustedPath(candidate, trustedRoots);
      if (
        metadata?.isFile() &&
        metadata.size <= MAX_ICON_BYTES &&
        IMAGE_EXTENSIONS.has(NodePath.extname(candidate).toLowerCase())
      ) {
        return candidate;
      }
    } catch {
      // A malformed manifest must not prevent the rest of the registry loading.
    }
  }
  for (const name of ["logo.svg", "logo.png", "icon.svg", "icon.png"]) {
    const candidate = NodePath.join(directory, name);
    const metadata = await metadataForTrustedPath(candidate, trustedRoots);
    if (
      metadata?.isFile() &&
      metadata.size <= MAX_ICON_BYTES &&
      IMAGE_EXTENSIONS.has(NodePath.extname(candidate).toLowerCase())
    ) {
      return candidate;
    }
  }
  return null;
}

async function iconPathFromSkill(
  directory: string,
  trustedRoots: ReadonlyArray<string>,
): Promise<string | null> {
  const manifest = NodePath.join(directory, "agents", "openai.yaml");
  if (!(await isBoundedTrustedRegularFile(manifest, trustedRoots))) {
    for (const name of ["logo.svg", "logo.png", "icon.svg", "icon.png"]) {
      const candidate = NodePath.join(directory, name);
      const metadata = await metadataForTrustedPath(candidate, trustedRoots);
      if (
        metadata?.isFile() &&
        metadata.size <= MAX_ICON_BYTES &&
        IMAGE_EXTENSIONS.has(NodePath.extname(candidate).toLowerCase())
      ) {
        return candidate;
      }
    }
    return null;
  }
  try {
    const parsed = parseYaml(await NodeFSP.readFile(manifest, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const relative =
      typeof record.icon_small === "string"
        ? record.icon_small
        : typeof record.icon_large === "string"
          ? record.icon_large
          : null;
    if (!relative || NodePath.isAbsolute(relative)) return null;
    const candidate = NodePath.resolve(NodePath.dirname(manifest), relative);
    if (!isWithinRoot(candidate, directory)) return null;
    const metadata = await metadataForTrustedPath(candidate, trustedRoots);
    return metadata?.isFile() &&
      metadata.size <= MAX_ICON_BYTES &&
      IMAGE_EXTENSIONS.has(NodePath.extname(candidate).toLowerCase())
      ? candidate
      : null;
  } catch {
    return null;
  }
}

async function capabilityDirectory(
  azureHome: string,
  category: "plugins" | "skills",
  id: string,
  trustedRoots: ReadonlyArray<string>,
): Promise<string | null> {
  if (!SAFE_ENTRY_NAME.test(id)) return null;
  const path = NodePath.join(azureHome, category, id);
  const metadata = await metadataForTrustedPath(path, trustedRoots);
  return metadata?.isDirectory() ? path : null;
}

export async function resolveAzureHomeCapabilityIcon(input: {
  readonly category: IconCategory;
  readonly id: string;
  readonly azureHome?: string;
  readonly trustedRoots?: ReadonlyArray<string>;
}): Promise<string | null> {
  const azureHome = input.azureHome ?? defaultAzureHome();
  const roots = input.trustedRoots ?? DEFAULT_TRUSTED_ROOTS;
  const trustedRoots = await Promise.all(
    roots.map((root) => NodeFSP.realpath(root).catch(() => root)),
  );
  if (input.category === "skills") {
    const directory = await capabilityDirectory(azureHome, "skills", input.id, trustedRoots);
    return directory ? iconPathFromSkill(directory, trustedRoots) : null;
  }
  if (input.category === "mcp") return null;
  const directory = await capabilityDirectory(azureHome, "plugins", input.id, trustedRoots);
  return directory ? iconPathFromPlugin(directory, trustedRoots) : null;
}

async function discoverDirectory(
  root: string,
  kind: RegistryKind,
  trustedRoots: ReadonlyArray<string>,
  disabled: DisabledCapabilities,
): Promise<ReadonlyArray<CodexCapabilityItem>> {
  const directory = NodePath.join(root, kind === "mcpServers" ? "mcp" : kind);
  let entries;
  try {
    const metadata = await metadataForTrustedPath(directory, trustedRoots);
    if (!metadata?.isDirectory()) return [];
    entries = await NodeFSP.readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered = await Promise.all(
    entries
      .filter((entry) => SAFE_ENTRY_NAME.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = NodePath.join(directory, entry.name);
        const metadata = await metadataForTrustedPath(path, trustedRoots);
        if (entry.isSymbolicLink() && metadata === null) return null;
        if (kind === "skills" || kind === "plugins") {
          if (!metadata?.isDirectory())
            return item(entry.name, entry.name, "Broken registry entry");
          const manifests =
            kind === "skills"
              ? [NodePath.join(path, "SKILL.md")]
              : [
                  NodePath.join(path, "plugin.json"),
                  NodePath.join(path, ".azure-plugin/plugin.json"),
                  NodePath.join(path, ".codex-plugin/plugin.json"),
                  NodePath.join(path, ".claude-plugin/plugin.json"),
                ];
          const available = (
            await Promise.all(
              manifests.map((manifest) => isBoundedTrustedRegularFile(manifest, trustedRoots)),
            )
          ).some(Boolean);
          const iconPath =
            kind === "skills"
              ? await iconPathFromSkill(path, trustedRoots)
              : await iconPathFromPlugin(path, trustedRoots);
          return item(
            entry.name,
            entry.name,
            available ? "Available" : "Broken registry entry",
            kind === "skills"
              ? !disabled.skills.has(entry.name)
              : !disabled.plugins.has(entry.name),
            true,
            iconPath ? { category: kind, id: entry.name } : undefined,
            kind === "skills"
              ? { _tag: "azure-skill" }
              : { _tag: "azure-capability", kind: "plugins" },
          );
        }
        if (!metadata?.isFile() || !entry.name.endsWith(".json"))
          return item(entry.name, entry.name, "Broken registry entry");
        if (kind === "mcpServers") {
          try {
            const names = Object.keys(
              readMcpServers(JSON.parse(await NodeFSP.readFile(path, "utf8"))),
            ).sort((left, right) => left.localeCompare(right));
            if (names.length === 0) {
              return item(
                entry.name.slice(0, -5),
                entry.name.slice(0, -5),
                "Broken registry entry",
              );
            }
            return names.map((name) => {
              const id = mcpCapabilityId(entry.name.slice(0, -5), name);
              return item(id, name, "Available", !disabled.mcp.has(id), true, undefined, {
                _tag: "azure-capability",
                kind: "mcp",
              });
            });
          } catch {
            return item(entry.name.slice(0, -5), entry.name.slice(0, -5), "Broken registry entry");
          }
        }
        return item(
          entry.name.slice(0, -".json".length),
          entry.name.slice(0, -".json".length),
          (await isBoundedTrustedRegularFile(path, trustedRoots))
            ? "Available"
            : "Broken registry entry",
          !disabled.hooks.has(entry.name),
          true,
          undefined,
          { _tag: "azure-capability", kind: "hooks" },
        );
      }),
  );
  return discovered
    .flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))
    .filter((entry): entry is CodexCapabilityItem => entry !== null);
}

function stampProjectRoots(
  items: ReadonlyArray<CodexCapabilityItem>,
  kind: AzureCapabilityKind,
  projectOnly: ProjectOnlyMap,
): CodexCapabilityItem[] {
  return items.map((entry) => {
    const scopeKind = entry.control?._tag === "plugin" ? "plugins" : kind;
    const scopeId = entry.control?._tag === "plugin" ? entry.control.pluginId : entry.id;
    const roots = projectOnly[scopeKind][scopeId];
    return roots && roots.length > 0 ? { ...entry, projectRoots: roots } : entry;
  });
}

export async function discoverAzureHomeCapabilities(
  azureHome = defaultAzureHome(),
  trustedRoots: ReadonlyArray<string> = DEFAULT_TRUSTED_ROOTS,
): Promise<CodexCapabilities> {
  let status: CodexCapabilities["homeStatus"] = "available";
  try {
    const metadata = await NodeFSP.lstat(azureHome);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) status = "unavailable";
  } catch (cause) {
    status = (cause as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
  }
  if (status !== "available") {
    return { homeStatus: status, hooks: [], plugins: [], skills: [], mcpServers: [] };
  }
  const resolvedTrustedRoots = await Promise.all(
    trustedRoots.map((root) => NodeFSP.realpath(root).catch(() => root)),
  );
  const { disabled, projectOnly } = await readCapabilityState(azureHome);
  const [rawHooks, plugins, skills, mcpServers] = await Promise.all([
    discoverDirectory(azureHome, "hooks", resolvedTrustedRoots, disabled),
    discoverDirectory(azureHome, "plugins", resolvedTrustedRoots, disabled),
    discoverDirectory(azureHome, "skills", resolvedTrustedRoots, disabled),
    discoverDirectory(azureHome, "mcpServers", resolvedTrustedRoots, disabled),
  ]);
  const pluginIds = new Set(plugins.map((plugin) => plugin.id));
  const hooks = rawHooks.map((hook) =>
    pluginIds.has(hook.id)
      ? {
          ...hook,
          description: `Controlled by the ${hook.id} plugin.`,
          icon: { category: "hooks" as const, id: hook.id },
          control: { _tag: "plugin" as const, pluginId: hook.id },
          enabled: plugins.find((plugin) => plugin.id === hook.id)?.enabled,
          restartRequired: true,
          controlledBy: { kind: "plugins" as const, id: hook.id },
          canToggle: true,
        }
      : hook,
  );
  return {
    homeStatus: status,
    hooks: stampProjectRoots(hooks, "hooks", projectOnly),
    plugins: stampProjectRoots(plugins, "plugins", projectOnly),
    skills: stampProjectRoots(skills, "skills", projectOnly),
    mcpServers: stampProjectRoots(mcpServers, "mcp", projectOnly),
  };
}

export async function setAzureHomeCapabilityEnabled(
  kind: AzureCapabilityKind,
  id: string,
  enabled: boolean,
  azureHome = defaultAzureHome(),
  projectRoots?: ReadonlyArray<string>,
): Promise<CodexCapabilities> {
  if (!SAFE_ENTRY_NAME.test(id)) {
    throw new Error("Invalid Azure capability id.");
  }
  const current = await discoverAzureHomeCapabilities(azureHome);
  const items =
    kind === "hooks"
      ? current.hooks
      : kind === "plugins"
        ? current.plugins
        : kind === "skills"
          ? current.skills
          : current.mcpServers;
  const item = items.find((entry) => entry.id === id);
  if (!item || item.detail !== "Available") {
    throw new Error("Azure capability is not available.");
  }

  const state = await readCapabilityState(azureHome);
  const targetKind = item.control?._tag === "plugin" ? "plugins" : kind;
  const targetId = item.control?._tag === "plugin" ? item.control.pluginId : id;
  const target = state.disabled[targetKind];
  if (enabled) {
    target.delete(targetId);
  } else {
    target.add(targetId);
  }
  if (projectRoots !== undefined) {
    const roots = [...new Set(projectRoots.map((root) => root.trim()).filter(Boolean))];
    if (roots.length === 0) {
      delete state.projectOnly[targetKind][targetId];
    } else {
      state.projectOnly[targetKind][targetId] = roots;
    }
  }
  await writeCapabilityState(azureHome, state);
  return discoverAzureHomeCapabilities(azureHome);
}

export async function setAzureHomeSkillEnabled(
  skillId: string,
  enabled: boolean,
  azureHome = defaultAzureHome(),
): Promise<CodexCapabilities> {
  return setAzureHomeCapabilityEnabled("skills", skillId, enabled, azureHome);
}

export async function discoverEnabledAzureSkillPaths(
  azureHome = defaultAzureHome(),
  cwd?: string,
): Promise<ReadonlyArray<string>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome);
  return capabilities.skills
    .filter((skill) => isEnabledInScope(skill, cwd))
    .map((skill) => NodePath.join(azureHome, "skills", skill.id));
}

/**
 * Resolve the enabled Azure skills once, with the same bounded/trusted-file
 * checks used by the capability registry. Provider snapshots only need the
 * metadata; turn routing uses the retained SKILL.md contents below.
 */
export async function discoverEnabledAzureSkills(
  azureHome = defaultAzureHome(),
  trustedRoots: ReadonlyArray<string> = DEFAULT_TRUSTED_ROOTS,
  cwd?: string,
): Promise<ReadonlyArray<AzurePortableSkill>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome, trustedRoots);
  const resolvedRoots = await Promise.all(
    trustedRoots.map((root) => NodeFSP.realpath(root).catch(() => root)),
  );
  const skills: AzurePortableSkill[] = [];

  for (const entry of capabilities.skills) {
    if (!isEnabledInScope(entry, cwd)) continue;
    const root = await capabilityDirectory(azureHome, "skills", entry.id, resolvedRoots);
    if (!root) continue;
    const path = NodePath.join(root, "SKILL.md");
    if (!(await isBoundedTrustedRegularFile(path, resolvedRoots))) continue;
    try {
      const contents = await NodeFSP.readFile(path, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_ENTRY_BYTES) continue;
      const metadata = skillFrontmatter(contents);
      const primaryName = metadata.name ?? entry.id;
      skills.push({
        id: entry.id,
        name: primaryName,
        path,
        root,
        contents,
        enabled: true,
        source: "azure",
        ...(metadata.description ? { description: metadata.description } : {}),
      });
      if (entry.id !== primaryName) {
        skills.push({
          id: entry.id,
          name: entry.id,
          path,
          root,
          contents,
          enabled: true,
          source: "azure",
          ...(metadata.description ? { description: metadata.description } : {}),
        });
      }
    } catch {
      // A capability can disappear between discovery and read. Ignore it.
    }
  }

  for (const plugin of capabilities.plugins) {
    if (!isEnabledInScope(plugin, cwd)) continue;
    const pluginRoot = await capabilityDirectory(azureHome, "plugins", plugin.id, resolvedRoots);
    if (!pluginRoot) continue;
    const manifest = await readPluginManifest(pluginRoot, resolvedRoots, "skills");
    const skillRoots = new Set<string>([
      NodePath.join(pluginRoot, "skills"),
      ...(manifest ? manifestPaths(manifest, manifest.contents.skills, pluginRoot) : []),
    ]);
    for (const skillsRoot of skillRoots) {
      let entries: ReadonlyArray<import("node:fs").Dirent>;
      try {
        entries = await NodeFSP.readdir(skillsRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (!SAFE_ENTRY_NAME.test(entry.name)) continue;
        const root = NodePath.join(skillsRoot, entry.name);
        const metadata = await metadataForTrustedPath(root, resolvedRoots);
        const path = NodePath.join(root, "SKILL.md");
        if (!metadata?.isDirectory() || !(await isBoundedTrustedRegularFile(path, resolvedRoots))) {
          continue;
        }
        try {
          const contents = await NodeFSP.readFile(path, "utf8");
          if (Buffer.byteLength(contents, "utf8") > MAX_ENTRY_BYTES) continue;
          const frontmatter = skillFrontmatter(contents);
          skills.push({
            id: `${plugin.id}:${entry.name}`,
            name: frontmatter.name ?? entry.name,
            path,
            root,
            contents,
            enabled: true,
            source: "plugin",
            ...(frontmatter.description ? { description: frontmatter.description } : {}),
          });
        } catch {
          // Ignore a plugin skill that cannot be read safely.
        }
      }
    }
  }
  return skills.toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function discoverEnabledAzureProviderSkills(
  azureHome = defaultAzureHome(),
): Promise<ReadonlyArray<ServerProviderSkill>> {
  return (await discoverEnabledAzureSkills(azureHome)).map((skill) => ({
    name: skill.name,
    path: skill.path,
    scope: "azure",
    enabled: true,
    ...(skill.description
      ? { description: skill.description, shortDescription: skill.description }
      : {}),
  }));
}

export interface AzurePortableAgent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly instructions: string;
  readonly path: string;
  readonly root: string;
}

export async function discoverEnabledAzureAgents(
  azureHome = defaultAzureHome(),
  trustedRoots: ReadonlyArray<string> = DEFAULT_TRUSTED_ROOTS,
): Promise<ReadonlyArray<AzurePortableAgent>> {
  const agentsDir = NodePath.join(azureHome, "agents");
  const resolvedRoots = await Promise.all(
    trustedRoots.map((root) => NodeFSP.realpath(root).catch(() => root)),
  );
  let entries: ReadonlyArray<import("node:fs").Dirent>;
  try {
    entries = await NodeFSP.readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AzurePortableAgent[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const root = NodePath.join(agentsDir, entry.name);
    const metadata = await metadataForTrustedPath(root, resolvedRoots);
    if (!metadata?.isDirectory()) continue;

    let files: ReadonlyArray<string>;
    try {
      files = await NodeFSP.readdir(root);
    } catch {
      continue;
    }

    const candidates = [
      files.find((f) => f.endsWith(".opencode.md")),
      files.find((f) => f.endsWith(".md") && !f.endsWith(".opencode.md")),
      files.find((f) => f.endsWith(".toml")),
    ].filter((f): f is string => Boolean(f));

    let name = entry.name;
    let description: string | undefined = undefined;
    let model: string | undefined = undefined;
    let instructions = "";
    let agentPath = root;

    for (const file of candidates) {
      const filePath = NodePath.join(root, file);
      if (!(await isBoundedTrustedRegularFile(filePath, resolvedRoots))) continue;
      try {
        const content = await NodeFSP.readFile(filePath, "utf8");
        if (file.endsWith(".md")) {
          const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
          if (fmMatch) {
            const fm = fmMatch[1] ?? "";
            const body = (fmMatch[2] ?? "").trim();
            const parsedName = fm.match(/name:\s*([^\r\n]+)/)?.[1]?.trim();
            const parsedDesc = fm.match(/description:\s*([^\r\n]+)/)?.[1]?.trim();
            const parsedModel = fm.match(/model:\s*([^\r\n]+)/)?.[1]?.trim();
            if (parsedName && name === entry.name) name = parsedName;
            if (parsedDesc && !description) description = parsedDesc;
            if (parsedModel && !model) model = parsedModel;
            if (body && !instructions) {
              instructions = body;
              agentPath = filePath;
            }
          } else if (!instructions) {
            instructions = content.trim();
            agentPath = filePath;
          }
        } else if (file.endsWith(".toml")) {
          const parsedName = content.match(/name\s*=\s*"([^"]+)"/)?.[1]?.trim();
          const parsedDesc = content.match(/description\s*=\s*"([^"]+)"/)?.[1]?.trim();
          const parsedModel = content.match(/model\s*=\s*"([^"]+)"/)?.[1]?.trim();
          if (parsedName && name === entry.name) name = parsedName;
          if (parsedDesc && !description) description = parsedDesc;
          if (parsedModel && !model) model = parsedModel;
          if (!instructions) {
            instructions = content.trim();
            agentPath = filePath;
          }
        }
      } catch {
        // Skip unreadable
      }
    }

    if (instructions || description) {
      agents.push({
        id: entry.name,
        name,
        ...(description ? { description } : {}),
        ...(model ? { model } : {}),
        instructions,
        path: agentPath,
        root,
      });
    }
  }

  return agents.toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function discoverEnabledAzureProviderAgents(
  azureHome = defaultAzureHome(),
): Promise<ReadonlyArray<ServerProviderSlashCommand>> {
  return (await discoverEnabledAzureAgents(azureHome)).map((agent) => ({
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    source: "agent",
  }));
}

async function discoverKnownAzureSkillNames(
  azureHome: string,
  trustedRoots: ReadonlyArray<string> = DEFAULT_TRUSTED_ROOTS,
): Promise<ReadonlySet<string>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome, trustedRoots);
  const resolvedRoots = await Promise.all(
    trustedRoots.map((root) => NodeFSP.realpath(root).catch(() => root)),
  );
  const names = new Set<string>();
  for (const skill of capabilities.skills) {
    if (skill.detail !== "Available") continue;
    const root = await capabilityDirectory(azureHome, "skills", skill.id, resolvedRoots);
    if (!root) continue;
    const path = NodePath.join(root, "SKILL.md");
    if (!(await isBoundedTrustedRegularFile(path, resolvedRoots))) continue;
    try {
      const metadata = skillFrontmatter(await NodeFSP.readFile(path, "utf8"));
      if (metadata.name) names.add(metadata.name);
      names.add(skill.id);
    } catch {
      // A capability can disappear between discovery and read.
    }
  }
  for (const plugin of capabilities.plugins) {
    if (plugin.detail !== "Available") continue;
    const pluginRoot = await capabilityDirectory(azureHome, "plugins", plugin.id, resolvedRoots);
    if (!pluginRoot) continue;
    const manifest = await readPluginManifest(pluginRoot, resolvedRoots, "skills");
    const skillRoots = new Set<string>([
      NodePath.join(pluginRoot, "skills"),
      ...(manifest ? manifestPaths(manifest, manifest.contents.skills, pluginRoot) : []),
    ]);
    for (const skillsRoot of skillRoots) {
      try {
        const entries = await NodeFSP.readdir(skillsRoot, { withFileTypes: true });
        for (const entry of entries) {
          if (!SAFE_ENTRY_NAME.test(entry.name)) continue;
          const path = NodePath.join(skillsRoot, entry.name, "SKILL.md");
          if (!(await isBoundedTrustedRegularFile(path, resolvedRoots))) continue;
          names.add(skillFrontmatter(await NodeFSP.readFile(path, "utf8")).name ?? entry.name);
        }
      } catch {
        // A malformed plugin must not block other skills.
      }
    }
  }
  return names;
}

/** Project skills win over Azure; Azure wins over provider-home skills. */
export function mergeAzureProviderSkills(
  providerSkills: ReadonlyArray<ServerProviderSkill>,
  azureSkills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  const skills = new Map<string, ServerProviderSkill>();
  for (const skill of providerSkills) {
    if (skill.scope !== "project") skills.set(skill.name, skill);
  }
  for (const skill of azureSkills) skills.set(skill.name, skill);
  for (const skill of providerSkills) {
    if (skill.scope === "project") skills.set(skill.name, skill);
  }
  return [...skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export function mergeAzureProviderSlashCommands(
  providerCommands: ReadonlyArray<ServerProviderSlashCommand> | undefined,
  azureAgents: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands = new Map<string, ServerProviderSlashCommand>();
  for (const cmd of providerCommands ?? []) {
    commands.set(cmd.name, cmd);
  }
  for (const agent of azureAgents) {
    commands.set(agent.name, agent);
  }
  return [...commands.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

function hookAdditionalContext(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const direct =
    typeof record.additionalContext === "string" ? record.additionalContext : undefined;
  if (direct?.trim()) return direct.trim();
  const nested = record.hookSpecificOutput;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? hookAdditionalContext(nested)
    : undefined;
}

function matchingHook(matcher: string | undefined, trigger: string): boolean {
  if (!matcher?.trim()) return true;
  try {
    return new RegExp(matcher, "u").test(trigger);
  } catch {
    return false;
  }
}

async function appendPortableHooks(input: {
  readonly hooks: AzurePortableHook[];
  readonly source: string;
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly trustedRoots: ReadonlyArray<string>;
}): Promise<void> {
  if (!(await isBoundedTrustedRegularFile(input.source, input.trustedRoots))) return;
  try {
    const parsed = JSON.parse(await NodeFSP.readFile(input.source, "utf8")) as unknown;
    const events =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).hooks
        : undefined;
    if (!events || typeof events !== "object" || Array.isArray(events)) return;
    for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
      const entries = (events as Record<string, unknown>)[event];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const matcher = typeof record.matcher === "string" ? record.matcher : undefined;
        const definitions = Array.isArray(record.hooks) ? record.hooks : [];
        for (const definition of definitions) {
          if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
          const command = definition as Record<string, unknown>;
          if (command.type !== "command" || typeof command.command !== "string") continue;
          const timeout = typeof command.timeout === "number" ? command.timeout * 1_000 : 5_000;
          input.hooks.push({
            id: `${input.pluginId}:${event}:${input.hooks.length + 1}`,
            name: input.pluginId,
            event,
            ...(matcher ? { matcher } : {}),
            command: command.command,
            timeoutMs: Math.min(MAX_HOOK_TIMEOUT_MS, Math.max(1, Math.floor(timeout))),
            pluginRoot: input.pluginRoot,
          });
        }
      }
    }
  } catch {
    // A malformed hook file must not block the turn.
  }
}

export async function discoverEnabledAzurePortableHooks(
  azureHome = defaultAzureHome(),
  trustedRoots: ReadonlyArray<string> = DEFAULT_TRUSTED_ROOTS,
  cwd?: string,
): Promise<ReadonlyArray<AzurePortableHook>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome, trustedRoots);
  const resolvedRoots = await Promise.all(
    trustedRoots.map((root) => NodeFSP.realpath(root).catch(() => root)),
  );
  const hooks: AzurePortableHook[] = [];
  const loadedSources = new Set<string>();
  const appendOnce = async (input: {
    readonly source: string;
    readonly pluginId: string;
    readonly pluginRoot: string;
  }) => {
    const identity = await NodeFSP.realpath(input.source).catch(() => input.source);
    if (loadedSources.has(identity)) return;
    loadedSources.add(identity);
    await appendPortableHooks({ hooks, trustedRoots: resolvedRoots, ...input });
  };
  for (const item of capabilities.hooks) {
    if (!isEnabledInScope(item, cwd)) continue;
    const source = NodePath.join(azureHome, "hooks", `${item.id}.json`);
    const pluginRoot =
      (await capabilityDirectory(azureHome, "plugins", item.id, resolvedRoots)) ?? azureHome;
    await appendOnce({ source, pluginId: item.id, pluginRoot });
  }
  for (const plugin of capabilities.plugins) {
    if (!isEnabledInScope(plugin, cwd)) continue;
    const pluginRoot = await capabilityDirectory(azureHome, "plugins", plugin.id, resolvedRoots);
    if (!pluginRoot) continue;
    const manifest = await readPluginManifest(pluginRoot, resolvedRoots, "hooks");
    const source = manifest
      ? manifestPath(manifest, manifest.contents.hooks, pluginRoot)
      : undefined;
    if (!source) continue;
    await appendOnce({ source, pluginId: plugin.id, pluginRoot });
  }
  return hooks;
}

export async function runAzurePortableHooks(input: {
  readonly event: AzurePortableHookEvent;
  readonly trigger: string;
  readonly cwd?: string;
  readonly prompt?: string;
  readonly azureHome?: string;
}): Promise<ReadonlyArray<AzurePortableHookResult>> {
  const azureHome = input.azureHome ?? defaultAzureHome();
  const hooks = await discoverEnabledAzurePortableHooks(
    azureHome,
    DEFAULT_TRUSTED_ROOTS,
    input.cwd,
  );
  const dataRoot = NodePath.join(azureHome, "plugin-data");
  await NodeFSP.mkdir(dataRoot, { recursive: true, mode: 0o700 }).catch(() => undefined);
  return Promise.all(
    hooks
      .filter((hook) => hook.event === input.event && matchingHook(hook.matcher, input.trigger))
      .map(
        (hook) =>
          new Promise<AzurePortableHookResult>((resolve) => {
            const command = hook.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", hook.pluginRoot);
            const child = spawn(command, {
              cwd: input.cwd,
              shell: true,
              env: {
                PATH: process.env.PATH ?? "",
                HOME: process.env.HOME ?? "",
                TMPDIR: process.env.TMPDIR ?? "",
                CLAUDE_PLUGIN_ROOT: hook.pluginRoot,
                PLUGIN_DATA: dataRoot,
              },
              stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            let settled = false;
            const append = (current: string, chunk: Buffer) => {
              const next = `${current}${chunk.toString("utf8")}`;
              return Buffer.byteLength(next, "utf8") > MAX_HOOK_OUTPUT_BYTES
                ? Buffer.from(next, "utf8").subarray(0, MAX_HOOK_OUTPUT_BYTES).toString("utf8")
                : next;
            };
            const finish = (result: AzurePortableHookResult) => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              resolve(result);
            };
            // @effect-diagnostics-next-line globalTimers:off -- child-process deadline.
            const timeout = setTimeout(() => {
              child.kill("SIGTERM");
              finish({ hook, outcome: "cancelled", stderr: "Timed out while running hook." });
            }, hook.timeoutMs);
            child.stdout.on("data", (chunk: Buffer) => {
              stdout = append(stdout, chunk);
            });
            child.stderr.on("data", (chunk: Buffer) => {
              stderr = append(stderr, chunk);
            });
            child.on("error", () =>
              finish({ hook, outcome: "error", stderr: "Hook failed to start." }),
            );
            child.on("close", (exitCode) => {
              const output = stdout.trim();
              let additionalContext: string | undefined;
              let malformedOutput = false;
              const looksLikeJson = output.startsWith("{") || output.startsWith("[");
              if (looksLikeJson) {
                try {
                  additionalContext = hookAdditionalContext(JSON.parse(output));
                } catch {
                  malformedOutput = true;
                }
              } else {
                additionalContext = output || undefined;
              }
              finish({
                hook,
                outcome: exitCode === 0 && !malformedOutput ? "success" : "error",
                ...(output ? { stdout: output, output } : {}),
                ...(malformedOutput
                  ? {
                      stderr: [stderr.trim(), "Hook returned malformed JSON output."]
                        .filter(Boolean)
                        .join(" "),
                    }
                  : stderr.trim()
                    ? { stderr: stderr.trim() }
                    : {}),
                ...(exitCode === null ? {} : { exitCode }),
                ...(exitCode === 0 && !malformedOutput && additionalContext
                  ? { additionalContext }
                  : {}),
              });
            });
            child.stdin.end(
              JSON.stringify({
                hook_event_name: input.event,
                prompt: input.prompt ?? "",
                cwd: input.cwd,
                session_id: "azure",
              }),
            );
          }),
      ),
  );
}

/** Explicit `$skill` is portable; unknown dollar tokens deliberately stay text. */
export async function resolveAzureExplicitSkills(input: {
  readonly prompt: string | undefined;
  readonly azureHome?: string;
  readonly cwd?: string;
}): Promise<{
  readonly prompt: string | undefined;
  readonly selected: ReadonlyArray<AzurePortableSkill>;
}> {
  if (!input.prompt || !input.prompt.includes("$")) return { prompt: input.prompt, selected: [] };
  const azureHome = input.azureHome ?? defaultAzureHome();
  const [capabilities, skills, knownSkills] = await Promise.all([
    discoverAzureHomeCapabilities(azureHome),
    discoverEnabledAzureSkills(azureHome, DEFAULT_TRUSTED_ROOTS, input.cwd),
    discoverKnownAzureSkillNames(azureHome),
  ]);
  const selectedByName = new Map<string, AzurePortableSkill>();
  for (const skill of skills) {
    selectedByName.set(skill.name, skill);
    if (skill.id && !selectedByName.has(skill.id)) {
      selectedByName.set(skill.id, skill);
    }
  }
  const disabled = new Set(
    capabilities.skills
      .filter((skill) => skill.detail === "Available" && !skill.enabled)
      .map((skill) => skill.id),
  );
  const selected: AzurePortableSkill[] = [];
  const seen = new Set<string>();
  const prompt = input.prompt.replace(SKILL_TOKEN, (token, name: string) => {
    const skill = selectedByName.get(name);
    if (skill) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        selected.push(skill);
      }
      return "";
    }
    if (disabled.has(name) || knownSkills.has(name)) {
      throw new AzureSkillResolutionError(
        `Azure skill '$${name}' is disabled. Enable it in Settings > Skills and start a new Azure session.`,
      );
    }
    return token;
  });
  const injected: string[] = [];
  let bytes = 0;
  for (const skill of selected) {
    const block = `<azure_skill name="${skill.name}" root="${skill.root}">\n${skill.contents}\n</azure_skill>`;
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (bytes + blockBytes > MAX_ENTRY_BYTES) {
      throw new AzureSkillResolutionError(
        "Selected Azure skills exceed the 64 KiB instruction limit.",
      );
    }
    bytes += blockBytes;
    injected.push(block);
  }
  return {
    prompt: injected.length > 0 ? `${injected.join("\n\n")}\n\n${prompt.trimStart()}` : prompt,
    selected,
  };
}

export async function discoverEnabledAzureMcpServers(
  azureHome = defaultAzureHome(),
  cwd?: string,
): Promise<ReadonlyArray<AzureMcpServerDescriptor>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome);
  const trustedRoots = await Promise.all(
    DEFAULT_TRUSTED_ROOTS.map((root) => NodeFSP.realpath(root).catch(() => root)),
  );
  const enabled = new Set(
    capabilities.mcpServers
      .filter((server) => isEnabledInScope(server, cwd))
      .map((server) => server.id),
  );
  if (enabled.size === 0) return [];
  let files: ReadonlyArray<import("node:fs").Dirent>;
  try {
    files = await NodeFSP.readdir(NodePath.join(azureHome, "mcp"), { withFileTypes: true });
  } catch {
    return [];
  }
  const descriptors: AzureMcpServerDescriptor[] = [];
  for (const file of files.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!file.name.endsWith(".json") || !SAFE_ENTRY_NAME.test(file.name.slice(0, -5))) continue;
    const fileId = file.name.slice(0, -5);
    const path = NodePath.join(azureHome, "mcp", file.name);
    if (!(await isBoundedTrustedRegularFile(path, trustedRoots))) continue;
    try {
      const source = readMcpServers(JSON.parse(await NodeFSP.readFile(path, "utf8")));
      for (const [name, value] of Object.entries(source)) {
        const id = mcpCapabilityId(fileId, name);
        if (!enabled.has(id)) continue;
        const descriptor = normalizedMcpDescriptor(id, name, value);
        if (descriptor) descriptors.push(descriptor);
      }
    } catch {
      // A malformed MCP entry is already represented as unavailable in Settings.
    }
  }
  return descriptors;
}

/** Build the small OpenCode config projection owned by Azure capabilities. */
export async function discoverEnabledAzureOpenCodeConfig(
  azureHome = defaultAzureHome(),
  cwd?: string,
): Promise<Record<string, unknown>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome);
  const config: Record<string, unknown> = {};
  const skills = (await discoverEnabledAzureSkills(azureHome, DEFAULT_TRUSTED_ROOTS, cwd)).map(
    (skill) => skill.root,
  );
  if (skills.length > 0) config.skills = { paths: skills };

  const plugins: string[] = [];
  for (const plugin of capabilities.plugins.filter((entry) => isEnabledInScope(entry, cwd))) {
    const pluginRoot = NodePath.join(azureHome, "plugins", plugin.id);
    try {
      const parsed = JSON.parse(
        await NodeFSP.readFile(NodePath.join(pluginRoot, "opencode.json"), "utf8"),
      ) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const entries = (parsed as Record<string, unknown>).plugin;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (typeof entry === "string" && entry.trim() && !NodePath.isAbsolute(entry)) {
              const resolved = NodePath.resolve(pluginRoot, entry);
              if (isWithinRoot(resolved, pluginRoot)) plugins.push(resolved);
            }
          }
        }
      }
    } catch {
      // A plugin without an OpenCode manifest remains discoverable but is not projected.
    }
  }
  if (plugins.length > 0) config.plugin = [...new Set(plugins)];

  const mcpServers: Record<string, unknown> = {};
  const enabledMcpByFile = new Map<string, Set<string>>();
  for (const server of capabilities.mcpServers.filter((entry) => isEnabledInScope(entry, cwd))) {
    const separator = server.id.indexOf("__");
    if (separator <= 0) continue;
    const fileId = server.id.slice(0, separator);
    const safeName = server.id.slice(separator + 2);
    const names = enabledMcpByFile.get(fileId) ?? new Set<string>();
    names.add(safeName);
    enabledMcpByFile.set(fileId, names);
  }
  for (const [fileId, enabledNames] of enabledMcpByFile) {
    try {
      const parsed = JSON.parse(
        await NodeFSP.readFile(NodePath.join(azureHome, "mcp", `${fileId}.json`), "utf8"),
      ) as unknown;
      const source = readMcpServers(parsed);
      for (const [name, value] of Object.entries(source)) {
        const safeName = name.replace(/[^A-Za-z0-9._-]/gu, "_");
        if (enabledNames.has(safeName)) {
          const normalized = normalizeOpenCodeMcpServer(value);
          if (normalized) mcpServers[name] = normalized;
        }
      }
    } catch {
      // Invalid MCP files are already reported as broken registry entries.
    }
  }
  if (Object.keys(mcpServers).length > 0) config.mcp = mcpServers;
  return config;
}
