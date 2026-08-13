// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  discoverAzureHomeCapabilities,
  discoverEnabledAzurePortableHooks,
  discoverEnabledAzureMcpServers,
  discoverEnabledAzureProviderSkills,
  discoverEnabledAzureSkillPaths,
  mergeAzureProviderSkills,
  resolveAzureHomeCapabilityIcon,
  resolveAzureExplicitSkills,
  runAzurePortableHooks,
  setAzureHomeCapabilityEnabled,
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

  it("projects enabled Azure and portable-plugin skills and expands only known skill tokens", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "skills", "focused"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(home, "skills", "focused", "SKILL.md"),
      "---\nname: focused\ndescription: Focus well\n---\nUse focus.",
    );
    await NodeFSP.mkdir(NodePath.join(home, "plugins", "portable", ".codex-plugin"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(home, "plugins", "portable", ".codex-plugin", "plugin.json"),
      JSON.stringify({ skills: "./skills" }),
    );
    await NodeFSP.mkdir(NodePath.join(home, "plugins", "portable", "skills", "plugin-skill"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(home, "plugins", "portable", "skills", "plugin-skill", "SKILL.md"),
      "---\nname: plugin-skill\n---\nPortable instructions.",
    );

    await expect(discoverEnabledAzureProviderSkills(home)).resolves.toEqual([
      expect.objectContaining({ name: "focused", scope: "azure" }),
      expect.objectContaining({ name: "plugin-skill", scope: "azure" }),
    ]);
    await expect(
      resolveAzureExplicitSkills({ prompt: "$focused $unknown work", azureHome: home }),
    ).resolves.toMatchObject({
      prompt: expect.stringContaining("$unknown work"),
      selected: [expect.objectContaining({ name: "focused" })],
    });

    await setAzureHomeSkillEnabled("focused", false, home);
    await expect(
      resolveAzureExplicitSkills({ prompt: "$focused", azureHome: home }),
    ).rejects.toThrow("is disabled");

    await setAzureHomeCapabilityEnabled("plugins", "portable", false, home);
    await expect(
      resolveAzureExplicitSkills({ prompt: "$plugin-skill", azureHome: home }),
    ).rejects.toThrow("is disabled");
  });

  it("caps combined explicit skill instructions at 64 KiB", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    for (const name of ["first", "second"]) {
      await NodeFSP.mkdir(NodePath.join(home, "skills", name), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(home, "skills", name, "SKILL.md"),
        `---\nname: ${name}\n---\n${"x".repeat(40 * 1024)}`,
      );
    }

    await expect(
      resolveAzureExplicitSkills({ prompt: "$first $second", azureHome: home }),
    ).rejects.toThrow("64 KiB");
  });

  it("discovers manifest hooks once and runs them without provider credentials", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    const plugin = NodePath.join(home, "plugins", "portable");
    await NodeFSP.mkdir(NodePath.join(plugin, ".codex-plugin"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(plugin, "hooks"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({ hooks: "./hooks/portable.json" }),
    );
    await NodeFSP.writeFile(
      NodePath.join(plugin, "hooks", "portable.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "startup",
              hooks: [
                {
                  type: "command",
                  command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
                    'process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:process.env.AZURE_TEST_PROVIDER_KEY ? "leak" : "safe"}}))',
                  )}`,
                },
              ],
            },
          ],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "printf ignored" }] }],
          SubagentStart: [{ hooks: [{ type: "command", command: "printf native-only" }] }],
        },
      }),
    );
    await NodeFSP.mkdir(NodePath.join(home, "hooks"), { recursive: true });
    await NodeFSP.symlink(
      NodePath.join(plugin, "hooks", "portable.json"),
      NodePath.join(home, "hooks", "portable.json"),
    );
    const prior = process.env.AZURE_TEST_PROVIDER_KEY;
    process.env.AZURE_TEST_PROVIDER_KEY = "not-for-hooks";
    try {
      await expect(discoverEnabledAzurePortableHooks(home, [home])).resolves.toMatchObject([
        { event: "SessionStart", name: "portable" },
        { event: "UserPromptSubmit", name: "portable" },
      ]);
      await expect(
        runAzurePortableHooks({ azureHome: home, event: "SessionStart", trigger: "startup" }),
      ).resolves.toMatchObject([{ outcome: "success", additionalContext: "safe" }]);
    } finally {
      if (prior === undefined) delete process.env.AZURE_TEST_PROVIDER_KEY;
      else process.env.AZURE_TEST_PROVIDER_KEY = prior;
    }
  });

  it("fails open when a hook returns malformed JSON", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "hooks"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(home, "hooks", "malformed.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: "printf '{broken'",
                },
              ],
            },
          ],
        },
      }),
    );

    await expect(
      runAzurePortableHooks({ azureHome: home, event: "UserPromptSubmit", trigger: "submit" }),
    ).resolves.toMatchObject([
      {
        outcome: "error",
        stderr: expect.stringContaining("malformed JSON"),
      },
    ]);
  });

  it("normalizes only enabled stdio and HTTP MCP server descriptors", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-home-"));
    directories.push(home);
    await NodeFSP.mkdir(NodePath.join(home, "mcp"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(home, "mcp", "main.json"),
      JSON.stringify({
        mcpServers: {
          search: { type: "stdio", command: "azure", args: ["mcp", "serve"] },
          remote: {
            url: "https://mcp.example.test/tools",
            headers: { Authorization: "Bearer test" },
          },
        },
      }),
    );
    await expect(discoverEnabledAzureMcpServers(home)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "remote", transport: "http", toolPrefix: "remote" }),
        expect.objectContaining({ name: "search", transport: "stdio", command: "azure" }),
      ]),
    );
  });

  it("keeps project skills ahead of Azure, and Azure ahead of provider-home skills", () => {
    const merged = mergeAzureProviderSkills(
      [
        { name: "same", path: "/home/SKILL.md", enabled: true, scope: "user" },
        { name: "same", path: "/project/SKILL.md", enabled: true, scope: "project" },
      ],
      [{ name: "same", path: "/azure/SKILL.md", enabled: true, scope: "azure" }],
    );
    expect(merged).toEqual([
      expect.objectContaining({ name: "same", path: "/project/SKILL.md", scope: "project" }),
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
