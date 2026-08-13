// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderDriverKind } from "@azure/contracts";

import {
  executeAzureMemoryCommand,
  prependAzureProjectInstructions,
  readAzureMemoryContext,
} from "./AzureProjectInstructions.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("Azure project instructions", () => {
  it("injects into attachment-only turns and completes partial reads", async () => {
    const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-instructions-"));
    directories.push(cwd);
    const contents = Buffer.from("Use the project rules.");
    await NodeFSP.writeFile(NodePath.join(cwd, "AZURE.md"), contents);

    vi.mocked(NodeFSP.open).mockResolvedValueOnce({
      stat: async () => ({ isFile: () => true, size: contents.length }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(3, length);
        contents.copy(buffer, offset, position, position + bytesRead);
        return { buffer, bytesRead };
      },
      close: async () => undefined,
    } as never);

    await expect(
      prependAzureProjectInstructions({
        cwd,
        driver: ProviderDriverKind.make("customDriver"),
        prompt: undefined,
      }),
    ).resolves.toBe("Use the project rules.");
    expect(vi.mocked(NodeFSP.open).mock.results).toHaveLength(1);
  });

  it("writes, selects, and forgets explicit project memory", async () => {
    const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-memory-"));
    directories.push(cwd);

    await expect(
      executeAzureMemoryCommand({ cwd, prompt: "/remember project use the purple API client" }),
    ).resolves.toMatchObject({ action: "remember", scope: "project" });
    await expect(
      NodeFSP.readFile(NodePath.join(cwd, ".azure", "memory.md"), "utf8"),
    ).resolves.toContain("use the purple API client");
    await expect(
      readAzureMemoryContext({ cwd, prompt: "Which API client should I use?" }),
    ).resolves.toContain("use the purple API client");
    await expect(
      executeAzureMemoryCommand({ cwd, prompt: "/forget use the purple API client" }),
    ).resolves.toMatchObject({ action: "forget", scope: "project" });
    await expect(
      NodeFSP.readFile(NodePath.join(cwd, ".azure", "memory.md"), "utf8"),
    ).resolves.not.toContain("use the purple API client");
  });
});
