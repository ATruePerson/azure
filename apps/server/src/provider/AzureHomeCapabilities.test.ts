// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  discoverAzureHomeCapabilities,
  discoverEnabledAzureSkillPaths,
  resolveAzureHomeCapabilityIcon,
  setAzureHomeSkillEnabled,
} from "./AzureHomeCapabilities.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("Azure home capability discovery", () => {
  it("reports a missing Azure home without reading other client homes", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-missing-"));
    await NodeFSP.rm(directory, { recursive: true, force: true });
    await expect(discoverAzureHomeCapabilities(directory)).resolves.toMatchObject({
      homeStatus: "missing",
    });
  });

  it("lists bounded regular registry entries and rejects symlink escapes", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "skills", "focused"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(home, "skills", "focused", "SKILL.md"), "focused");
    await NodeFSP.mkdir(NodePath.join(home, "plugins", "valid", ".azure-plugin"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(home, "plugins", "valid", ".azure-plugin", "plugin.json"),
      "{}",
    );
    await NodeFSP.mkdir(NodePath.join(home, "hooks"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(home, "hooks", "run.json"), "{}");
    await NodeFSP.mkdir(NodePath.join(home, "mcp"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(home, "hooks", "run.json"),
      NodePath.join(home, "mcp", "escaped.json"),
    );

    await expect(discoverAzureHomeCapabilities(home)).resolves.toMatchObject({
      homeStatus: "available",
      skills: [{ id: "focused", detail: "Available" }],
      plugins: [{ id: "valid", detail: "Available" }],
      hooks: [{ id: "run", detail: "Available" }],
      mcpServers: [],
    });
  });

  it("rejects symlinked category directories", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "real-skills", "escaped"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(home, "real-skills", "escaped", "SKILL.md"), "escaped");
    await NodeFSP.symlink(NodePath.join(home, "real-skills"), NodePath.join(home, "skills"));

    await expect(discoverAzureHomeCapabilities(home)).resolves.toMatchObject({
      homeStatus: "available",
      skills: [],
    });
  });

  it("lists symlinked entries from an explicitly trusted root", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    const shared = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-shared-"));
    directories.push(home, shared);
    await Promise.all(
      ["hooks", "plugins", "skills", "mcp"].map((name) => NodeFSP.mkdir(NodePath.join(home, name))),
    );
    await NodeFSP.mkdir(NodePath.join(shared, "focused"));
    await NodeFSP.writeFile(NodePath.join(shared, "focused", "SKILL.md"), "focused");
    await NodeFSP.mkdir(NodePath.join(shared, "minimal", ".codex-plugin"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(shared, "minimal", ".codex-plugin", "plugin.json"), "{}");
    await NodeFSP.writeFile(NodePath.join(shared, "hook.json"), "{}");
    await NodeFSP.writeFile(
      NodePath.join(shared, "mcp.json"),
      JSON.stringify({ mcpServers: { mcp: {} } }),
    );
    await NodeFSP.symlink(
      NodePath.join(shared, "focused"),
      NodePath.join(home, "skills", "focused"),
    );
    await NodeFSP.symlink(
      NodePath.join(shared, "minimal"),
      NodePath.join(home, "plugins", "minimal"),
    );
    await NodeFSP.symlink(
      NodePath.join(shared, "hook.json"),
      NodePath.join(home, "hooks", "hook.json"),
    );
    await NodeFSP.symlink(
      NodePath.join(shared, "mcp.json"),
      NodePath.join(home, "mcp", "mcp.json"),
    );

    await expect(discoverAzureHomeCapabilities(home, [shared])).resolves.toMatchObject({
      homeStatus: "available",
      hooks: [{ id: "hook", detail: "Available" }],
      plugins: [{ id: "minimal", detail: "Available" }],
      skills: [{ id: "focused", detail: "Available" }],
      mcpServers: [{ id: "mcp__mcp", detail: "Available" }],
    });
  });

  it("persists skill toggles and exposes only enabled skill paths", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "skills", "focused"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(home, "skills", "focused", "SKILL.md"), "focused");

    await expect(setAzureHomeSkillEnabled("focused", false, home)).resolves.toMatchObject({
      skills: [{ id: "focused", enabled: false, canToggle: true }],
    });
    await expect(discoverEnabledAzureSkillPaths(home)).resolves.toEqual([]);

    await expect(setAzureHomeSkillEnabled("focused", true, home)).resolves.toMatchObject({
      skills: [{ id: "focused", enabled: true, canToggle: true }],
    });
    await expect(discoverEnabledAzureSkillPaths(home)).resolves.toEqual([
      NodePath.join(home, "skills", "focused"),
    ]);
  });

  it("discovers trusted plugin and skill logos without exposing their paths", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "plugins", "branded", ".codex-plugin"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(home, "plugins", "branded", ".codex-plugin", "plugin.json"),
      JSON.stringify({ interface: { logo: "logo.svg" } }),
    );
    await NodeFSP.writeFile(
      NodePath.join(home, "plugins", "branded", ".codex-plugin", "logo.svg"),
      "<svg />",
    );
    await NodeFSP.mkdir(NodePath.join(home, "skills", "branded", "agents"), {
      recursive: true,
    });
    await NodeFSP.writeFile(NodePath.join(home, "skills", "branded", "SKILL.md"), "skill");
    await NodeFSP.writeFile(
      NodePath.join(home, "skills", "branded", "agents", "openai.yaml"),
      "icon_small: icon.svg\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(home, "skills", "branded", "agents", "icon.svg"),
      "<svg />",
    );

    await expect(discoverAzureHomeCapabilities(home)).resolves.toMatchObject({
      plugins: [{ id: "branded", icon: { category: "plugins", id: "branded" } }],
      skills: [{ id: "branded", icon: { category: "skills", id: "branded" } }],
    });
    await expect(
      resolveAzureHomeCapabilityIcon({ category: "plugins", id: "branded", azureHome: home }),
    ).resolves.toBe(NodePath.join(home, "plugins", "branded", ".codex-plugin", "logo.svg"));
  });
});
