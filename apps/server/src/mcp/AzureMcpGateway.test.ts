// @effect-diagnostics nodeBuiltinImport:off
import { createRequire } from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodeHTTP from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server as SdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import * as Effect from "effect/Effect";

import { makeAzureMcpGateway } from "./AzureMcpGateway.ts";

const localRequire = createRequire(import.meta.url);
const sdkServer = localRequire.resolve("@modelcontextprotocol/sdk/server");
const sdkStdioTransport = localRequire.resolve("@modelcontextprotocol/sdk/server/stdio.js");
const sdkTypes = localRequire.resolve("@modelcontextprotocol/sdk/types.js");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function stdioServerScript(pidFile: string): string {
  return `const { Server } = require(${JSON.stringify(sdkServer)});
const { StdioServerTransport } = require(${JSON.stringify(sdkStdioTransport)});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdkTypes)});
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const text = request.params.arguments?.text ?? "";
  return { content: [{ type: "text", text: "echo:" + text + ":cwd=" + process.cwd() }] };
});
const transport = new StdioServerTransport();
server.connect(transport);
`;
}

async function scriptFile(contents: string): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-gateway-"));
  const path = NodePath.join(directory, "fixture.cjs");
  await NodeFSP.writeFile(path, contents);
  return path;
}

function stdioDescriptor(scriptPath: string, extraEnv?: Record<string, string>) {
  return {
    id: "fixture-stdio",
    name: "fixture-stdio",
    toolPrefix: "fixture",
    transport: "stdio" as const,
    command: process.execPath,
    args: [scriptPath],
    env: { PATH: process.env.PATH ?? "", ...extraEnv },
  };
}

async function httpFixture(): Promise<{
  readonly url: string;
  readonly close: () => Promise<void>;
}> {
  let transport: StreamableHTTPServerTransport;
  let bindResolve: ((url: string) => void) | undefined;
  const sdk = new SdkServer(
    { name: "azure-http-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ],
  }));
  sdk.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [
      {
        type: "text",
        text: `echo:${(request.params.arguments as { text?: string } | undefined)?.text ?? ""}`,
      },
    ],
  }));
  transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "fixture-session" });
  await sdk.connect(transport);

  const httpServer = NodeHTTP.createServer((request, response) => {
    void transport.handleRequest(request as never, response as never);
  });
  const url = await new Promise<string>((resolve) => {
    bindResolve = resolve;
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as { readonly port: number };
      resolve(`http://127.0.0.1:${address.port}/mcp`);
    });
  });
  void bindResolve;
  return {
    url,
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitFor(callback: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await callback()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition.");
}

describe("Azure MCP gateway transports", () => {
  it("lists tools and calls a tool over a real spawned stdio server", async () => {
    const pidDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "azure-gateway-pid-"),
    );
    const pidFile = NodePath.join(pidDirectory, "pid");
    const gateway = await Effect.runPromise(
      makeAzureMcpGateway({
        descriptors: [stdioDescriptor(await scriptFile(stdioServerScript(pidFile)))],
        cwd: "/private/tmp",
      }),
    );
    cleanups.push(() => Effect.runPromise(gateway.close));

    const tools = await Effect.runPromise(gateway.listTools());
    expect(tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);
    expect(tools[0]?.description).toBe("Echo a value");

    const result = await Effect.runPromise(gateway.callTool("fixture__echo", { text: "nvidia" }));
    expect(result).toMatchObject({
      content: [{ type: "text", text: "echo:nvidia:cwd=/private/tmp" }],
    });

    const pid = Number(await NodeFSP.readFile(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    await Effect.runPromise(gateway.close);
    await waitFor(async () => processIsGone(pid));
  });

  it("lists tools and calls a tool over a real streamable HTTP server", async () => {
    const fixture = await httpFixture();
    cleanups.push(() => fixture.close());
    const gateway = await Effect.runPromise(
      makeAzureMcpGateway({
        descriptors: [
          {
            id: "fixture-http",
            name: "fixture-http",
            toolPrefix: "http",
            transport: "http",
            url: fixture.url,
          },
        ],
      }),
    );
    cleanups.push(() => Effect.runPromise(gateway.close));

    const tools = await Effect.runPromise(gateway.listTools());
    expect(tools.map((tool) => tool.name)).toEqual(["http__echo"]);

    const result = await Effect.runPromise(gateway.callTool("http__echo", { text: "via-http" }));
    expect(result).toMatchObject({
      content: [{ type: "text", text: "echo:via-http" }],
    });
  });

  it("hides a failed server without hiding tools from a healthy one", async () => {
    const brokenDescriptor = {
      id: "fixture-broken",
      name: "fixture-broken",
      toolPrefix: "broken",
      transport: "stdio" as const,
      command: process.execPath,
      args: [NodePath.join(NodeOS.tmpdir(), "does-not-exist.mjs")],
    };
    const pidDirectory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "azure-gateway-pid-"),
    );
    const pidFile = NodePath.join(pidDirectory, "pid");
    const gateway = await Effect.runPromise(
      makeAzureMcpGateway({
        descriptors: [
          brokenDescriptor,
          stdioDescriptor(await scriptFile(stdioServerScript(pidFile))),
        ],
      }),
    );

    const tools = await Effect.runPromise(gateway.listTools());
    expect(tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);

    const failedResult = await Effect.runPromise(gateway.callTool("broken__echo", {}));
    expect(failedResult).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Azure MCP tool is unavailable." }],
    });
    await Effect.runPromise(gateway.close);
  });
});
