import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";
import * as Path from "node:path";
import * as FileSystem from "effect/FileSystem";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as AzureMcpGateway from "./AzureMcpGateway.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("proxies Azure MCP tool schemas, safety hints, and results", () => {
  let closed = false;
  const calls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [];
  const layer = McpHttpServer.AzureMcpToolkitRegistrationFor({
    listTools: () =>
      Effect.succeed([
        {
          name: "search__query",
          description: "Search Azure",
          inputSchema: { type: "object" },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: "search__unknown-safety",
          inputSchema: { type: "object" },
        },
      ]),
    callTool: (name, arguments_) =>
      Effect.sync(() => {
        calls.push({ name, arguments: arguments_ });
        return { content: [{ type: "text", text: "one result" }], structuredContent: { hits: 1 } };
      }),
    close: Effect.sync(() => {
      closed = true;
    }),
  }).pipe(Layer.provideMerge(McpServer.McpServer.layer));

  return Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const tool = server.tools.find(({ tool }) => tool.name === "search__query");
      expect(tool?.tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      const unannotated = server.tools.find(({ tool }) => tool.name === "search__unknown-safety");
      expect(unannotated?.tool.annotations).toEqual({});
      const result = yield* server
        .callTool({ name: "search__query", arguments: { q: "Nvidia" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(result).toMatchObject({
        isError: false,
        structuredContent: { hits: 1 },
      });
      expect(calls).toEqual([{ name: "search__query", arguments: { q: "Nvidia" } }]);
    }),
  ).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => expect(closed).toBe(true))));
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("real stdio MCP server connects, lists tools, calls tool, and shuts down", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = Path.resolve(process.cwd());
      const testServerPath = Path.join(projectRoot, "apps/server/test-fixtures/mcp-stdio-echo.js");
      console.error("TEST SERVER PATH:", testServerPath);
      yield* fs.makeDirectory(Path.dirname(testServerPath), { recursive: true });
      yield* fs.writeFileString(
        testServerPath,
        `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "test-echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo back input", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "echo") {
    return { content: [{ type: "text", text: String(request.params.arguments?.message ?? "") }] };
  }
  throw new Error("Unknown tool");
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Server connected and waiting");

// Handle shutdown gracefully
process.on("SIGTERM", async () => {
  console.error("Server received SIGTERM");
  await server.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.error("Server received SIGINT");
  await server.close();
  process.exit(0);
});
`,
      );

      console.error("TEST SERVER PATH:", testServerPath);
      const gateway = yield* AzureMcpGateway.makeAzureMcpGateway({
        descriptors: [
          {
            id: "test-stdio-echo",
            name: "test-echo",
            transport: "stdio",
            command: "node",
            args: [testServerPath],
            toolPrefix: "test",
            env: { NODE_PATH: process.cwd() + "/node_modules" },
          },
        ],
        cwd: process.cwd(),
      });

      const tools = yield* gateway.listTools();
      console.log("STDIO TOOLS:", JSON.stringify(tools, null, 2));
      expect(tools.some((t) => t.name === "test__echo")).toBe(true);

      const result = yield* gateway.callTool("test__echo", { message: "hello stdio" });
      expect(result).toMatchObject({ content: [{ type: "text", text: "hello stdio" }] });

      yield* gateway.close;
      yield* fs.remove(testServerPath);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

// Create layer outside the effect
const httpEchoTool = Tool.make("http_echo", {
  description: "Echo via HTTP",
  parameters: Schema.Struct({ message: Schema.String }),
  success: Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  }),
}).annotate(Tool.Readonly, true);

const testToolkit = Toolkit.make(httpEchoTool);
const testToolkitLayer = testToolkit.toLayer({
  http_echo: ({ message }) =>
    Effect.succeed({ content: [{ type: "text" as const, text: `HTTP: ${message}` }] }),
});

const serverLayer = testToolkitLayer.pipe(Layer.provideMerge(McpServer.McpServer.layer));

it.effect("real HTTP MCP server connects, lists tools, calls tool", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Get the McpServer with registered tools
      const server = yield* McpServer.McpServer;
      console.log(
        "MCP SERVER TOOLS:",
        server.tools.map((t) => t.tool.name),
      );

      // Build HTTP layer with the same McpServer
      const httpLayer = McpServer.layerHttp({
        name: "test-http-mcp",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      }).pipe(Layer.provideMerge(serverLayer));
      yield* HttpRouter.serve(httpLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;

      // Initialize session
      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();
    }),
  ).pipe(Effect.provide(serverLayer), Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("disabled stdio server is isolated and does not hide other servers' tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = Path.resolve(process.cwd());
      const goodServerPath = Path.join(projectRoot, "apps/server/test-fixtures/mcp-stdio-good.js");
      const badServerPath = Path.join(projectRoot, "apps/server/test-fixtures/mcp-stdio-bad.js");
      yield* fs.makeDirectory(Path.dirname(goodServerPath), { recursive: true });

      yield* fs.writeFileString(
        goodServerPath,
        `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "good", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "good_tool", description: "Works", inputSchema: { type: "object" } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "good" }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Good server connected and waiting");
`,
      );

      yield* fs.writeFileString(
        badServerPath,
        `
// This server crashes on startup
process.exit(1);
`,
      );

      const gateway = yield* AzureMcpGateway.makeAzureMcpGateway({
        descriptors: [
          {
            id: "bad",
            name: "bad",
            transport: "stdio",
            command: "node",
            args: [badServerPath],
            toolPrefix: "bad",
          },
          {
            id: "good",
            name: "good",
            transport: "stdio",
            command: "node",
            args: [goodServerPath],
            toolPrefix: "good",
          },
        ],
        cwd: process.cwd(),
      });

      const tools = yield* gateway.listTools();
      console.log("DISABLED TEST TOOLS:", JSON.stringify(tools, null, 2));
      expect(tools.some((t) => t.name === "good__good_tool")).toBe(true);
      expect(tools.some((t) => t.name.startsWith("bad__"))).toBe(false);

      const result = yield* gateway.callTool("good__good_tool", {});
      expect(result.content[0].text).toBe("good");

      yield* gateway.close;
      yield* fs.remove(goodServerPath);
      yield* fs.remove(badServerPath);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("gateway close terminates stdio and HTTP transports", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = Path.resolve(process.cwd());
      const serverPath = Path.join(projectRoot, "apps/server/test-fixtures/mcp-stdio-close.js");
      yield* fs.makeDirectory(Path.dirname(serverPath), { recursive: true });
      yield* fs.writeFileString(
        serverPath,
        `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "close-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: "pong" }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Close test server connected and waiting");
`,
      );

      const gateway = yield* AzureMcpGateway.makeAzureMcpGateway({
        descriptors: [
          {
            id: "close-test",
            name: "close-test",
            transport: "stdio",
            command: "node",
            args: [serverPath],
            toolPrefix: "close",
          },
        ],
        cwd: process.cwd(),
      });

      yield* gateway.listTools();
      yield* gateway.callTool("close__ping", {});
      yield* gateway.close;

      const toolsAfterClose = yield* gateway.listTools();
      expect(toolsAfterClose.length).toBe(0);

      yield* fs.remove(serverPath);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("gateway passes cwd to stdio servers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = Path.resolve(process.cwd());
      const serverPath = Path.join(projectRoot, "apps/server/test-fixtures/mcp-stdio-cwd.js");
      yield* fs.makeDirectory(Path.dirname(serverPath), { recursive: true });
      yield* fs.writeFileString(
        serverPath,
        `
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "cwd-test", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "get_cwd", description: "Get server cwd", inputSchema: { type: "object" } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "text", text: process.cwd() }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("CWD test server connected and waiting");
`,
      );

      const testCwd = "/tmp/test-cwd-verification";
      yield* fs.makeDirectory(testCwd, { recursive: true });
      const realTestCwd = yield* fs.realPath(testCwd);

      const gateway = yield* AzureMcpGateway.makeAzureMcpGateway({
        descriptors: [
          {
            id: "cwd-test",
            name: "cwd-test",
            transport: "stdio",
            command: "node",
            args: [serverPath],
            toolPrefix: "cwd",
          },
        ],
        cwd: testCwd,
      });

      const result = yield* gateway.callTool("cwd__get_cwd", {});
      expect(result.content[0].text).toBe(realTestCwd);

      yield* gateway.close;
      yield* fs.remove(serverPath);
      yield* fs.remove(testCwd, { recursive: true });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
