// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  AzureCapabilityKind,
  CapabilityControl,
  CodexCapabilities,
  CodexCapabilityItem,
} from "@t3tools/contracts";
import { parse as parseYaml } from "yaml";

const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_ICON_BYTES = 512 * 1024;
const SAFE_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const CAPABILITY_STATE_FILE = "capabilities-state.json";
const SKILL_STATE_FILE = "skills-state.json";

type RegistryKind = "hooks" | "plugins" | "skills" | "mcpServers";
type IconCategory = "hooks" | "plugins" | "skills" | "mcp";
type DisabledCapabilities = Record<AzureCapabilityKind, Set<string>>;

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

async function readDisabledCapabilities(azureHome: string): Promise<DisabledCapabilities> {
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
    return disabled;
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
      // Missing state means every discovered capability is enabled.
    }
    return disabled;
  }
}

async function writeDisabledCapabilities(
  azureHome: string,
  disabled: DisabledCapabilities,
): Promise<void> {
  const statePath = NodePath.join(azureHome, CAPABILITY_STATE_FILE);
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await NodeFSP.writeFile(
    temporaryPath,
    `${JSON.stringify({ version: 1, disabled: Object.fromEntries(Object.entries(disabled).map(([kind, values]) => [kind, [...values].sort()])) }, null, 2)}\n`,
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
  const azureHome = input.azureHome ?? NodePath.join(NodeOS.homedir(), ".azure");
  const roots = input.trustedRoots ?? [
    NodePath.join(NodeOS.homedir(), ".codex"),
    NodePath.join(NodeOS.homedir(), ".config", "azure"),
    NodePath.join(NodeOS.homedir(), "Developer", "AI"),
  ];
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
                  NodePath.join(path, ".azure-plugin/plugin.json"),
                  NodePath.join(path, ".codex-plugin/plugin.json"),
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

export async function discoverAzureHomeCapabilities(
  azureHome = NodePath.join(NodeOS.homedir(), ".azure"),
  trustedRoots: ReadonlyArray<string> = [
    NodePath.join(NodeOS.homedir(), ".codex"),
    NodePath.join(NodeOS.homedir(), ".config", "azure"),
    NodePath.join(NodeOS.homedir(), "Developer", "AI"),
  ],
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
  const disabled = await readDisabledCapabilities(azureHome);
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
  return { homeStatus: status, hooks, plugins, skills, mcpServers };
}

export async function setAzureHomeCapabilityEnabled(
  kind: AzureCapabilityKind,
  id: string,
  enabled: boolean,
  azureHome = NodePath.join(NodeOS.homedir(), ".azure"),
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

  const disabled = await readDisabledCapabilities(azureHome);
  const targetKind = item.control?._tag === "plugin" ? "plugins" : kind;
  const targetId = item.control?._tag === "plugin" ? item.control.pluginId : id;
  const target = disabled[targetKind];
  if (enabled) {
    target.delete(targetId);
  } else {
    target.add(targetId);
  }
  await writeDisabledCapabilities(azureHome, disabled);
  return discoverAzureHomeCapabilities(azureHome);
}

export async function setAzureHomeSkillEnabled(
  skillId: string,
  enabled: boolean,
  azureHome = NodePath.join(NodeOS.homedir(), ".azure"),
): Promise<CodexCapabilities> {
  return setAzureHomeCapabilityEnabled("skills", skillId, enabled, azureHome);
}

export async function discoverEnabledAzureSkillPaths(
  azureHome = NodePath.join(NodeOS.homedir(), ".azure"),
): Promise<ReadonlyArray<string>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome);
  return capabilities.skills
    .filter((skill) => skill.detail === "Available" && skill.enabled)
    .map((skill) => NodePath.join(azureHome, "skills", skill.id));
}

/** Build the small OpenCode config projection owned by Azure capabilities. */
export async function discoverEnabledAzureOpenCodeConfig(
  azureHome = NodePath.join(NodeOS.homedir(), ".azure"),
): Promise<Record<string, unknown>> {
  const capabilities = await discoverAzureHomeCapabilities(azureHome);
  const config: Record<string, unknown> = {};
  const skills = capabilities.skills
    .filter((skill) => skill.detail === "Available" && skill.enabled)
    .map((skill) => NodePath.join(azureHome, "skills", skill.id));
  if (skills.length > 0) config.skills = { paths: skills };

  const plugins: string[] = [];
  for (const plugin of capabilities.plugins.filter(
    (entry) => entry.detail === "Available" && entry.enabled,
  )) {
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
  for (const server of capabilities.mcpServers.filter(
    (entry) => entry.detail === "Available" && entry.enabled,
  )) {
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
