// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

import type { ProviderDriverKind } from "@t3tools/contracts";

const MAX_AZURE_MD_BYTES = 64 * 1024;
const MAX_MEMORY_FILE_BYTES = 256 * 1024;
const MAX_MEMORY_CONTEXT_BYTES = 8 * 1024;
const MEMORY_DIR_NAME = "memories";

export type AzureMemoryScope = "global" | "project";

export interface AzureMemoryCommandResult {
  readonly action: "remember" | "forget" | "status" | "search";
  readonly scope: AzureMemoryScope;
  readonly message: string;
  readonly candidates?: ReadonlyArray<string>;
}

type MemoryEntry = { readonly heading: string; readonly text: string };

function memoryRoot(cwd: string | undefined, scope: AzureMemoryScope): string | undefined {
  if (scope === "global") return NodePath.join(NodeOS.homedir(), ".azure", MEMORY_DIR_NAME);
  return cwd ? NodePath.join(cwd, ".azure") : undefined;
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<string | undefined> {
  try {
    const entry = await NodeFSP.lstat(filePath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) return undefined;
    const handle = await NodeFSP.open(
      filePath,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return undefined;
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function atomicWriteMemory(filePath: string, contents: string): Promise<void> {
  if (Buffer.byteLength(contents, "utf8") > MAX_MEMORY_FILE_BYTES) {
    throw new Error("Memory file is too large.");
  }
  const parent = NodePath.dirname(filePath);
  await NodeFSP.mkdir(parent, { recursive: true });
  const parentEntry = await NodeFSP.lstat(parent);
  if (!parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new Error("Memory directory is not safe.");
  }
  const existing = await NodeFSP.lstat(filePath).catch(() => undefined);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error("Memory file is not safe.");
  }
  const temporary = NodePath.join(parent, `.MEMORY.${process.pid}.${Date.now()}.tmp`);
  try {
    await NodeFSP.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await NodeFSP.rename(temporary, filePath);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseMemoryEntries(contents: string): MemoryEntry[] {
  const lines = contents.split(/\r?\n/u);
  const entries: MemoryEntry[] = [];
  let heading = "Explicit memories";
  for (const line of lines) {
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    if (headingMatch) {
      heading = headingMatch[1] ?? heading;
      continue;
    }
    const entry = /^\s*[-*]\s+(.+?)\s*$/u.exec(line);
    if (entry?.[1]) entries.push({ heading, text: entry[1] });
  }
  return entries;
}

function memorySections(
  contents: string,
): Array<{ readonly heading: string; readonly text: string }> {
  const lines = contents.split(/\r?\n/u);
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current = { heading: "Memory", lines: [] as string[] };
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(line)?.[1];
    if (heading) {
      if (current.lines.join("\n").trim()) sections.push(current);
      current = { heading, lines: [] };
    } else current.lines.push(line);
  }
  if (current.lines.join("\n").trim()) sections.push(current);
  return sections.map((section) => ({
    heading: section.heading,
    text: section.lines.join("\n").trim(),
  }));
}

function scoreSection(
  section: { readonly heading: string; readonly text: string },
  prompt: string,
): number {
  const words = new Set(prompt.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? []);
  if (words.size === 0) return 0;
  const haystack = `${section.heading} ${section.text}`.toLowerCase();
  return Array.from(words).reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
}

export async function readAzureMemoryContext(input: {
  readonly cwd?: string;
  readonly prompt?: string;
}): Promise<string | undefined> {
  const files = [
    {
      scope: "global" as const,
      path: NodePath.join(NodeOS.homedir(), ".azure", MEMORY_DIR_NAME, "MEMORY.md"),
    },
    ...(input.cwd
      ? [{ scope: "project" as const, path: NodePath.join(input.cwd, ".azure", "memory.md") }]
      : []),
  ];
  const selected: string[] = [];
  for (const file of files) {
    const contents = await readBoundedFile(file.path, MAX_MEMORY_FILE_BYTES);
    if (!contents) continue;
    const sections = memorySections(contents)
      .map((section) => ({ ...section, score: scoreSection(section, input.prompt ?? "") }))
      .filter((section) => section.score > 0)
      .sort((left, right) => right.score - left.score || left.heading.localeCompare(right.heading));
    for (const section of sections) {
      const block = `[${file.scope} memory, potentially stale]\n## ${section.heading}\n${section.text}`;
      if (Buffer.byteLength(selected.concat(block).join("\n\n"), "utf8") > MAX_MEMORY_CONTEXT_BYTES)
        break;
      selected.push(block);
    }
  }
  return selected.length > 0
    ? `<memory_context>\n${selected.join("\n\n")}\n</memory_context>`
    : undefined;
}

export async function executeAzureMemoryCommand(input: {
  readonly cwd?: string;
  readonly prompt: string;
}): Promise<AzureMemoryCommandResult | undefined> {
  if (/^\/memory\s+status\s*$/iu.test(input.prompt.trim())) {
    const status = await getAzureMemoryStatus(input.cwd);
    return {
      action: "status",
      scope: input.cwd ? "project" : "global",
      message:
        status.length > 0
          ? status
              .map((entry) => `${entry.scope}: ${entry.entries} entries, ${entry.bytes} bytes`)
              .join("; ")
          : "No Azure memory files exist.",
    };
  }
  const search = /^\/memory\s+search\s+(.+?)\s*$/iu.exec(input.prompt.trim());
  if (search) {
    const matches = await searchAzureMemory({
      ...(input.cwd ? { cwd: input.cwd } : {}),
      query: search[1] ?? "",
    });
    return {
      action: "search",
      scope: input.cwd ? "project" : "global",
      message:
        matches.length > 0
          ? matches.map((entry) => `${entry.scope}/${entry.heading}: ${entry.text}`).join("; ")
          : "No matching Azure memory entries.",
    };
  }
  const match =
    /^(?:\/remember\b|remember\s+this\s*[:,-])\s*(?:(global|project)\s+)?(.+?)\s*$/iu.exec(
      input.prompt.trim(),
    );
  if (match) {
    const scope: AzureMemoryScope =
      match[1]?.toLowerCase() === "global" || (!input.cwd && !match[1]) ? "global" : "project";
    const fact = (match[2] ?? "").trim();
    if (!fact) return undefined;
    const root = memoryRoot(input.cwd, scope);
    if (!root)
      return { action: "remember", scope, message: "Open a project to save project memory." };
    const filePath = NodePath.join(root, scope === "global" ? "MEMORY.md" : "memory.md");
    const current =
      (await readBoundedFile(filePath, MAX_MEMORY_FILE_BYTES)) ?? "# Explicit memories\n";
    const line = `- ${fact}`;
    if (!parseMemoryEntries(current).some((entry) => entry.text === fact)) {
      await atomicWriteMemory(filePath, `${current.trimEnd()}\n${line}\n`);
    }
    return { action: "remember", scope, message: `Saved to ${scope} memory.` };
  }

  const forget = /^\/forget\s+(.+?)\s*$/iu.exec(input.prompt.trim());
  if (!forget) return undefined;
  const query = (forget[1] ?? "").trim();
  const scopes: AzureMemoryScope[] = input.cwd ? ["project", "global"] : ["global"];
  const matches: Array<{ scope: AzureMemoryScope; path: string; line: string }> = [];
  for (const scope of scopes) {
    const root = memoryRoot(input.cwd, scope);
    if (!root) continue;
    const path = NodePath.join(root, scope === "global" ? "MEMORY.md" : "memory.md");
    const contents = await readBoundedFile(path, MAX_MEMORY_FILE_BYTES);
    if (!contents) continue;
    for (const entry of parseMemoryEntries(contents)) {
      if (entry.text === query) matches.push({ scope, path, line: `- ${entry.text}` });
    }
  }
  if (matches.length !== 1) {
    return {
      action: "forget",
      scope: matches[0]?.scope ?? "project",
      message:
        matches.length > 1
          ? "More than one exact match; confirm the scope."
          : "No exact memory entry matched.",
      ...(matches.length > 1
        ? { candidates: matches.map((match) => `${match.scope}: ${match.line}`) }
        : {}),
    };
  }
  const matchEntry = matches[0];
  if (!matchEntry)
    return { action: "forget", scope: "project", message: "No exact memory entry matched." };
  const contents = await readBoundedFile(matchEntry.path, MAX_MEMORY_FILE_BYTES);
  if (contents !== undefined) {
    const next = contents
      .split(/\r?\n/u)
      .filter((line) => line.trim() !== matchEntry.line)
      .join("\n");
    await atomicWriteMemory(matchEntry.path, `${next.trimEnd()}\n`);
  }
  return {
    action: "forget",
    scope: matchEntry.scope,
    message: `Removed from ${matchEntry.scope} memory.`,
  };
}

export async function getAzureMemoryStatus(
  cwd?: string,
): Promise<
  ReadonlyArray<{ scope: AzureMemoryScope; path: string; bytes: number; entries: number }>
> {
  const paths = [
    {
      scope: "global" as const,
      path: NodePath.join(NodeOS.homedir(), ".azure", MEMORY_DIR_NAME, "MEMORY.md"),
    },
    ...(cwd
      ? [{ scope: "project" as const, path: NodePath.join(cwd, ".azure", "memory.md") }]
      : []),
  ];
  const status: Array<{ scope: AzureMemoryScope; path: string; bytes: number; entries: number }> =
    [];
  for (const entry of paths) {
    const contents = await readBoundedFile(entry.path, MAX_MEMORY_FILE_BYTES);
    if (contents !== undefined)
      status.push({
        scope: entry.scope,
        path: entry.path,
        bytes: Buffer.byteLength(contents, "utf8"),
        entries: parseMemoryEntries(contents).length,
      });
  }
  return status;
}

export async function searchAzureMemory(input: {
  readonly cwd?: string;
  readonly query: string;
}): Promise<ReadonlyArray<{ scope: AzureMemoryScope; heading: string; text: string }>> {
  const files = [
    {
      scope: "global" as const,
      path: NodePath.join(NodeOS.homedir(), ".azure", MEMORY_DIR_NAME, "MEMORY.md"),
    },
    ...(input.cwd
      ? [{ scope: "project" as const, path: NodePath.join(input.cwd, ".azure", "memory.md") }]
      : []),
  ];
  const results: Array<{ scope: AzureMemoryScope; heading: string; text: string }> = [];
  const query = input.query.trim().toLowerCase();
  if (!query) return results;
  for (const file of files) {
    const contents = await readBoundedFile(file.path, MAX_MEMORY_FILE_BYTES);
    if (!contents) continue;
    for (const section of memorySections(contents)) {
      if (`${section.heading}\n${section.text}`.toLowerCase().includes(query))
        results.push({ scope: file.scope, ...section });
    }
  }
  return results;
}

export const prependAzureProjectInstructions = async (input: {
  readonly cwd: string | undefined;
  readonly driver: ProviderDriverKind;
  readonly prompt: string | undefined;
  readonly memoryCommand?: AzureMemoryCommandResult;
  readonly includeProjectInstructions?: boolean;
}): Promise<string | undefined> => {
  if (!input.cwd) {
    return input.prompt;
  }

  try {
    const root = await NodeFSP.realpath(input.cwd);
    const instructions =
      input.includeProjectInstructions === false
        ? undefined
        : (await readBoundedFile(NodePath.join(root, "AZURE.md"), MAX_AZURE_MD_BYTES))?.trim();
    const memory = await readAzureMemoryContext({
      cwd: root,
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    });
    const prompt = input.memoryCommand
      ? `${input.prompt}\n\n[Azure memory] ${input.memoryCommand.message}`
      : (input.prompt ?? "");
    return [instructions, memory, prompt].filter(Boolean).join("\n\n") || input.prompt;
  } catch {
    return input.prompt;
  }
};
