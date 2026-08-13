import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { describe } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ApprovalRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@azure/contracts";

import {
  makeOpenAICompatibleAdapter,
  OpenAICompatibleAuthError,
  OpenAICompatibleMalformedResponseError,
  OpenAICompatibleNetworkError,
  type OpenAICompatibleAdapter,
  type OpenAICompatibleRuntimeOptions,
} from "./OpenAICompatibleRuntime.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

const provider = ProviderDriverKind.make("test-openai-compatible");
const thread = (value: string) => ThreadId.make(value);
const encoder = new TextEncoder();

type ResponseFactory = (request: Request) => Response;

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function sse(chunks: ReadonlyArray<string>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function sseData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function clientFor(factory: ResponseFactory, bodies: string[] = []) {
  return HttpClient.make((request) =>
    HttpClientRequest.toWeb(request).pipe(
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      ),
      Effect.flatMap((webRequest) =>
        Effect.promise(async () => {
          if (request.method === "POST") bodies.push(await webRequest.text());
          return HttpClientResponse.fromWeb(request, factory(webRequest));
        }),
      ),
    ),
  );
}

function makeAdapter(
  client: HttpClient.HttpClient,
  extra: Partial<OpenAICompatibleRuntimeOptions> = {},
) {
  return makeOpenAICompatibleAdapter({
    provider,
    baseUrl: "https://provider.example/v1",
    apiKey: "sk-test-key",
    defaultModel: "test-model",
    ...extra,
  }).pipe(Effect.provideService(HttpClient.HttpClient, client));
}

function startInput(id: string) {
  return {
    threadId: thread(id),
    provider,
    runtimeMode: "full-access" as const,
  };
}

describe("OpenAICompatibleRuntime", () => {
  it.effect("discovers models and streams text plus reasoning", () =>
    Effect.gen(function* () {
      const client = clientFor((request) =>
        request.method === "GET"
          ? response(JSON.stringify({ data: [{ id: "model-a", owned_by: "local" }] }))
          : sse([
              'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
              'data: {"choices":[{"delta":{"content":"hel',
              'lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
              "data: [DONE]\n\n",
            ]),
      );
      const adapter = yield* makeAdapter(client);
      const models = yield* adapter.listModels();
      assert.deepStrictEqual(models[0], { id: "model-a", owned_by: "local" });
      yield* adapter.startSession(startInput("text"));
      yield* adapter.sendTurn({ threadId: thread("text"), input: "hello" });
      const events = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7));
      const deltas = events
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta",
        )
        .map((event) => event.payload.delta);
      assert.deepStrictEqual(deltas, ["think", "hello"]);
      const usage = events.find((event) => event.type === "thread.token-usage.updated");
      assert.equal(usage?.type, "thread.token-usage.updated");
      if (usage?.type === "thread.token-usage.updated") {
        assert.deepStrictEqual(usage.payload.usage, {
          usedTokens: 5,
          totalProcessedTokens: 5,
          inputTokens: 2,
          lastInputTokens: 2,
          outputTokens: 3,
          lastOutputTokens: 3,
          lastUsedTokens: 5,
        });
      }
      const completed = events.at(-1);
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.stopReason, "stop");
        assert.deepStrictEqual(completed.payload.usage, { prompt_tokens: 2, completion_tokens: 3 });
      }
    }),
  );

  it.effect("assembles fragmented tool calls and replays a local tool result", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const client = clientFor(
        (request) =>
          request.method === "POST"
            ? sse([
                sseData({
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-1",
                            type: "function",
                            function: { name: "lookup", arguments: '{\\"q\\"' },
                          },
                        ],
                      },
                    },
                  ],
                }),
                sseData({
                  choices: [
                    {
                      delta: { tool_calls: [{ index: 0, function: { arguments: ':\\"x\\"}' } }] },
                      finish_reason: "tool_calls",
                    },
                  ],
                }),
                "data: [DONE]\n\n",
              ])
            : response(JSON.stringify({ data: [] })),
        bodies,
      );
      const adapter = yield* makeAdapter(client, {
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        toolChoice: "auto",
      });
      yield* adapter.startSession(startInput("tools"));
      yield* adapter.sendTurn({ threadId: thread("tools"), input: "find x" });
      yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      );
      const result = yield* adapter.sendToolResult({
        threadId: thread("tools"),
        toolCallId: "call-1",
        content: "found it",
      });
      yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      );
      assert.equal(result.threadId, thread("tools"));
      assert.equal(bodies.length, 2);
      assert.include(bodies[0]!, '"tool_choice":"auto"');
      assert.include(bodies[1]!, '"role":"user"');
      assert.include(bodies[1]!, '"role":"assistant"');
      assert.include(bodies[1]!, '"tool_call_id":"call-1"');
    }),
  );

  it.effect(
    "executes Azure MCP calls in the same turn and sends the result back to the model",
    () =>
      Effect.gen(function* () {
        const bodies: string[] = [];
        const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
        const threadId = thread("azure-mcp-loop");
        McpProviderSession.setMcpProviderSession({
          environmentId: "environment" as never,
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: "Bearer test",
        });
        const adapter = yield* makeAdapter(
          clientFor(
            () =>
              bodies.length === 1
                ? sse([
                    sseData({
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: "call-search",
                                type: "function",
                                function: {
                                  name: "azure-search__search",
                                  arguments: '{\"q\":\"Nvidia\"}',
                                },
                              },
                            ],
                          },
                          finish_reason: "tool_calls",
                        },
                      ],
                    }),
                    "data: [DONE]\n\n",
                  ])
                : sse([
                    sseData({
                      choices: [{ delta: { content: "Found it" }, finish_reason: "stop" }],
                    }),
                    "data: [DONE]\n\n",
                  ]),
            bodies,
          ),
          {
            mcpClientFactory: async () => ({
              listTools: async () => [
                {
                  name: "azure-search__search",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true, destructiveHint: false },
                },
              ],
              callTool: async (input) => {
                calls.push(input);
                return { content: [{ type: "text", text: "result" }] };
              },
            }),
          },
        );
        yield* adapter.startSession(startInput("azure-mcp-loop"));
        yield* adapter.sendTurn({ threadId, input: "Find Nvidia" });
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
        );
        assert.deepStrictEqual(calls, [
          { name: "azure-search__search", arguments: { q: "Nvidia" } },
        ]);
        assert.equal(bodies.length, 2);
        assert.include(bodies[0]!, '"azure-search__search"');
        assert.include(bodies[1]!, '"tool_call_id":"call-search"');
        McpProviderSession.clearMcpProviderSession(threadId);
      }),
  );

  it.effect("asks before non-read-only Azure MCP calls in approval-required mode", () =>
    Effect.gen(function* () {
      const threadId = thread("azure-mcp-approval");
      let executed = false;
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      let providerCalls = 0;
      const adapter = yield* makeAdapter(
        clientFor(() => {
          providerCalls += 1;
          return providerCalls === 1
            ? sse([
                sseData({
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-write",
                            type: "function",
                            function: { name: "azure-search__write", arguments: "{}" },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                }),
                "data: [DONE]\n\n",
              ])
            : sse([
                sseData({ choices: [{ delta: { content: "declined" }, finish_reason: "stop" }] }),
                "data: [DONE]\n\n",
              ]);
        }),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              { name: "azure-search__write", inputSchema: { type: "object" } },
            ],
            callTool: async () => {
              executed = true;
              return { content: [] };
            },
          }),
        },
      );
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const listen = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requested, event).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        ...startInput("azure-mcp-approval"),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "Write it" });
      const request = yield* Deferred.await(requested);
      assert.equal(request.payload.requestType, "dynamic_tool_call");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(request.requestId)),
        "decline",
      );
      yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      );
      assert.isFalse(executed);
      yield* Fiber.interrupt(listen);
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("reconfigures an idle session without losing its conversation", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const adapter = yield* makeAdapter(
        clientFor(
          () =>
            sse([
              sseData({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
              "data: [DONE]\n\n",
            ]),
          bodies,
        ),
      );
      const threadId = thread("restart");
      yield* adapter.startSession({
        ...startInput("restart"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("test-openai-compatible"),
          model: "model-a",
        },
      });
      yield* adapter.sendTurn({ threadId, input: "first" });
      yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      );

      const restarted = yield* adapter.startSession({
        ...startInput("restart"),
        runtimeMode: "approval-required",
        modelSelection: {
          instanceId: ProviderInstanceId.make("test-openai-compatible"),
          model: "model-b",
        },
      });
      assert.equal(restarted.model, "model-b");
      assert.equal(restarted.runtimeMode, "approval-required");

      yield* adapter.sendTurn({ threadId, input: "second" });
      yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      );
      assert.include(bodies[1]!, '"model":"model-b"');
      assert.include(
        bodies[1]!,
        '"messages":[{"role":"user","content":"first"},{"role":"assistant","content":"ok"},{"role":"user","content":"second"}]',
      );
    }),
  );

  it.effect(
    "reuses an unchanged Nvidia session and waits for an active turn before reconfiguration",
    () =>
      Effect.gen(function* () {
        let pendingRead: (() => void) | undefined;
        const readPending = new Promise<void>((resolve) => {
          pendingRead = resolve;
        });
        const hanging = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(sseData({ choices: [{ delta: { content: "x" } }] })),
              );
            },
            pull() {
              pendingRead?.();
              pendingRead = undefined;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
        const adapter = yield* makeAdapter(
          clientFor((request) => (request.method === "POST" ? hanging : response("{}"))),
          { provider: ProviderDriverKind.make("nvidiaNim") },
        );
        const threadId = thread("nvidia-session-reuse");
        const initial = {
          ...startInput("nvidia-session-reuse"),
          provider: ProviderDriverKind.make("nvidiaNim"),
          modelSelection: {
            instanceId: ProviderInstanceId.make("nvidiaNim"),
            model: "stepfun-ai/step-3.7-flash",
          },
        };
        const first = yield* adapter.startSession(initial);
        const reused = yield* adapter.startSession(initial);
        assert.equal(reused.createdAt, first.createdAt);

        const sent = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.forkChild);
        yield* Effect.promise(() => readPending).pipe(Effect.timeout("1 second"));
        const activeReuse = yield* adapter.startSession(initial);
        assert.equal(activeReuse.createdAt, first.createdAt);
        const reconfigure = adapter.startSession({
          ...initial,
          modelSelection: {
            instanceId: ProviderInstanceId.make("nvidiaNim"),
            model: "nvidia/nemotron-3-ultra-550b-a55b",
          },
        });
        const activeError = yield* reconfigure.pipe(Effect.flip);
        assert.isTrue(Schema.is(ProviderAdapterValidationError)(activeError));
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(sent);
        const reconfigured = yield* reconfigure;
        assert.equal(reconfigured.model, "nvidia/nemotron-3-ultra-550b-a55b");
      }),
  );

  it.effect("uses unique turn ids across consecutive turns", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(
        clientFor(() =>
          sse([
            sseData({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
            "data: [DONE]\n\n",
          ]),
        ),
      );
      const threadId = thread("unique-turns");
      yield* adapter.startSession(startInput("unique-turns"));
      const first = yield* adapter.sendTurn({ threadId, input: "one" });
      yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
      );
      const second = yield* adapter.sendTurn({ threadId, input: "two" });
      assert.notEqual(String(first.turnId), String(second.turnId));
    }),
  );

  it.effect("fails a successful provider stream with no assistant output", () =>
    Effect.gen(function* () {
      const adapter = yield* makeAdapter(
        clientFor(() =>
          sse([sseData({ choices: [{ delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"]),
        ),
      );
      const threadId = thread("empty-output");
      yield* adapter.startSession(startInput("empty-output"));
      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2));
      yield* adapter.sendTurn({ threadId, input: "hello" });
      const events = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2));
      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.include(completed.payload.errorMessage ?? "", "without assistant text");
      }
    }),
  );

  it.effect("compacts old context through the same provider before overflow", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const client = clientFor((request) => {
        if (request.method === "POST" && bodies.length === 1) {
          return response(
            JSON.stringify({ choices: [{ message: { content: "prior decisions" } }] }),
          );
        }
        return request.method === "GET"
          ? response(JSON.stringify({ data: [{ id: "small", context_length: 100 }] }))
          : sse([
              sseData({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
              "data: [DONE]\n\n",
            ]);
      }, bodies);
      const adapter = yield* makeAdapter(client, { defaultModel: "small" });
      yield* adapter.listModels();
      const prior = Array.from({ length: 9 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index}`,
      }));
      yield* adapter.startSession({
        ...startInput("compact"),
        modelSelection: {
          instanceId: ProviderInstanceId.make("test-instance"),
          model: "small",
          options: [],
        },
        resumeCursor: { messages: prior },
      });
      yield* adapter.sendTurn({ threadId: thread("compact"), input: "new work" });
      const events = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6));
      assert.equal(
        events.some(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "context_compaction",
        ),
        true,
      );
      assert.equal(
        bodies.some((body) => body.includes("Summarize the completed conversation context")),
        true,
      );
    }),
  );

  it.effect("forwards only provider-supported reasoning settings", () =>
    Effect.gen(function* () {
      const routerBodies: string[] = [];
      const router = yield* makeAdapter(
        clientFor(
          () =>
            sse([
              sseData({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
              "data: [DONE]\n\n",
            ]),
          routerBodies,
        ),
        { provider: ProviderDriverKind.make("openrouter") },
      );
      const routerThread = thread("router-thinking");
      yield* router.startSession({
        ...startInput("router-thinking"),
        provider: ProviderDriverKind.make("openrouter"),
      });
      yield* router.sendTurn({
        threadId: routerThread,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("openrouter"),
          model: "openai/model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* Stream.runHead(
        Stream.filter(router.streamEvents, (event) => event.type === "turn.completed"),
      );
      assert.include(routerBodies[0]!, '"reasoning":{"effort":"high"}');
      yield* router.sendTurn({
        threadId: routerThread,
        input: "plain",
        modelSelection: {
          instanceId: ProviderInstanceId.make("openrouter"),
          model: "openai/no-thinking",
        },
      });
      yield* Stream.runHead(
        Stream.filter(router.streamEvents, (event) => event.type === "turn.completed"),
      );
      assert.notInclude(routerBodies[1]!, '"reasoning"');

      const nvidiaBodies: string[] = [];
      const nvidia = yield* makeAdapter(
        clientFor(
          () =>
            sse([
              sseData({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
              "data: [DONE]\n\n",
            ]),
          nvidiaBodies,
        ),
        { provider: ProviderDriverKind.make("nvidiaNim") },
      );
      const nvidiaThread = thread("nvidia-thinking");
      yield* nvidia.startSession({
        ...startInput("nvidia-thinking"),
        provider: ProviderDriverKind.make("nvidiaNim"),
      });
      yield* nvidia.sendTurn({
        threadId: nvidiaThread,
        input: "hello",
        modelSelection: {
          instanceId: ProviderInstanceId.make("nvidiaNim"),
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      });
      yield* Stream.runHead(
        Stream.filter(nvidia.streamEvents, (event) => event.type === "turn.completed"),
      );
      assert.include(nvidiaBodies[0]!, '"reasoning_effort":"medium"');
    }),
  );

  it.effect(
    "returns typed malformed, auth, and network errors without leaking response bodies",
    () =>
      Effect.gen(function* () {
        const malformed = yield* makeAdapter(
          clientFor((request) =>
            request.method === "POST" ? sse(["data: nope\n\n"]) : response("{}"),
          ),
        );
        yield* malformed.startSession(startInput("malformed"));
        yield* malformed.sendTurn({ threadId: thread("malformed"), input: "x" });
        const malformedEvents = yield* Stream.runCollect(Stream.take(malformed.streamEvents, 4));
        const malformedEvent = malformedEvents.find((event) => event.type === "turn.completed");
        assert.equal(malformedEvent?.type, "turn.completed");
        assert.equal(malformedEvent?.payload.state, "failed");

        const auth = yield* makeAdapter(
          clientFor(() => response("sk-secret must not escape", 401)),
        );
        const authError = yield* auth.listModels().pipe(Effect.flip);
        assert.isTrue(Schema.is(OpenAICompatibleAuthError)(authError));
        assert.notInclude(String(authError), "sk-secret");

        const unavailable = yield* makeAdapter(clientFor(() => response("account-id", 404)));
        yield* unavailable.startSession(startInput("unavailable"));
        yield* unavailable.sendTurn({ threadId: thread("unavailable"), input: "x" });
        const unavailableEvents = yield* Stream.runCollect(
          Stream.take(unavailable.streamEvents, 4),
        );
        const unavailableEvent = unavailableEvents.find((event) => event.type === "turn.completed");
        assert.equal(unavailableEvent?.type, "turn.completed");
        if (unavailableEvent?.type === "turn.completed") {
          assert.include(
            unavailableEvent.payload.errorMessage ?? "",
            "selected model may be unavailable",
          );
          assert.notInclude(unavailableEvent.payload.errorMessage ?? "", "account-id");
        }

        const network = HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: "offline" }),
            }),
          ),
        );
        const networkAdapter = yield* makeAdapter(network);
        const networkError = yield* networkAdapter.listModels().pipe(Effect.flip);
        assert.isTrue(Schema.is(OpenAICompatibleNetworkError)(networkError));
      }),
  );

  it.effect("interrupts a hanging stream and preserves session lifecycle semantics", () =>
    Effect.gen(function* () {
      let cancelled = false;
      let pendingRead: (() => void) | undefined;
      const readPending = new Promise<void>((resolve) => {
        pendingRead = resolve;
      });
      const hanging = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          },
          pull() {
            pendingRead?.();
            pendingRead = undefined;
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
      const adapter = yield* makeAdapter(
        clientFor((request) => (request.method === "POST" ? hanging : response("{}"))),
      );
      yield* adapter.startSession(startInput("lifecycle"));
      assert.equal((yield* adapter.listSessions()).length, 1);
      const send = yield* adapter
        .sendTurn({ threadId: thread("lifecycle"), input: "wait" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => readPending).pipe(Effect.timeout("1 second"));
      const reused = yield* adapter.startSession(startInput("lifecycle"));
      assert.equal(reused.status, "running");
      yield* adapter.interruptTurn(thread("lifecycle"));
      yield* Fiber.join(send);
      yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (event) => event.type === "turn.aborted"),
      );
      assert.isTrue(cancelled);
      const rolledBack = yield* adapter.rollbackThread(thread("lifecycle"), 0);
      assert.equal(rolledBack.turns.length, 0);
      yield* adapter.stopSession(thread("lifecycle"));
      const hasSession = yield* adapter.hasSession(thread("lifecycle"));
      assert.isFalse(hasSession);
    }),
  );

  it.effect("rejects attachments before making a provider request", () =>
    Effect.gen(function* () {
      let requests = 0;
      const adapter = yield* makeAdapter(
        clientFor(() => {
          requests += 1;
          return response(JSON.stringify({ data: [] }));
        }),
      );
      yield* adapter.startSession(startInput("attachments"));
      const error = yield* adapter
        .sendTurn({
          threadId: thread("attachments"),
          input: "describe this",
          attachments: [
            { type: "image", id: "file-1", mimeType: "image/png", name: "image.png", sizeBytes: 1 },
          ],
        })
        .pipe(Effect.flip);
      assert.isTrue(Schema.is(ProviderAdapterValidationError)(error));
      if (Schema.is(ProviderAdapterValidationError)(error)) {
        assert.include(error.issue, "does not support attachments");
      }
      assert.equal(requests, 0);
    }),
  );

  it.effect("enforces the 16-round Azure MCP tool-call limit", () =>
    Effect.gen(function* () {
      const threadId = thread("azure-mcp-round-limit");
      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeAdapter(
        clientFor(() =>
          sse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-limit",
                        type: "function",
                        function: { name: "azure-search__search", arguments: '{"q":"x"}' },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
            "data: [DONE]\n\n",
          ]),
        ),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              {
                name: "azure-search__search",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
            ],
            callTool: async (input) => {
              calls.push(input);
              return { content: [{ type: "text", text: "result" }] };
            },
          }),
        },
      );
      yield* adapter.startSession(startInput("azure-mcp-round-limit"));
      yield* adapter.sendTurn({ threadId, input: "loop" });
      const completed = Option.getOrUndefined(
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
        ),
      );
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.include(completed.payload.errorMessage ?? "", "tool-call limit (16)");
      }
      assert.equal(calls.length, 16);
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("reports an unknown Azure MCP tool without failing the turn", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const threadId = thread("azure-mcp-unknown-tool");
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeAdapter(
        clientFor(
          () =>
            bodies.length === 1
              ? sse([
                  sseData({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-missing",
                              type: "function",
                              function: { name: "azure-search__missing", arguments: "{}" },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  }),
                  "data: [DONE]\n\n",
                ])
              : sse([
                  sseData({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
                  "data: [DONE]\n\n",
                ]),
          bodies,
        ),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              { name: "azure-search__search", inputSchema: { type: "object" } },
            ],
            callTool: async () => ({ content: [] }),
          }),
        },
      );
      yield* adapter.startSession(startInput("azure-mcp-unknown-tool"));
      yield* adapter.sendTurn({ threadId, input: "call missing" });
      const completed = Option.getOrUndefined(
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
        ),
      );
      assert.equal(completed?.type, "turn.completed");
      assert.equal(completed?.payload.state, "completed");
      assert.include(bodies[1]!, "Unknown Azure MCP tool 'azure-search__missing'");
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("reports malformed tool arguments without failing the turn", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const threadId = thread("azure-mcp-malformed-args");
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeAdapter(
        clientFor(
          () =>
            bodies.length === 1
              ? sse([
                  sseData({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-bad-args",
                              type: "function",
                              function: { name: "azure-search__search", arguments: "not-json" },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  }),
                  "data: [DONE]\n\n",
                ])
              : sse([
                  sseData({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
                  "data: [DONE]\n\n",
                ]),
          bodies,
        ),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              { name: "azure-search__search", inputSchema: { type: "object" } },
            ],
            callTool: async () => ({ content: [] }),
          }),
        },
      );
      yield* adapter.startSession(startInput("azure-mcp-malformed-args"));
      yield* adapter.sendTurn({ threadId, input: "bad args" });
      const completed = Option.getOrUndefined(
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
        ),
      );
      assert.equal(completed?.type, "turn.completed");
      assert.equal(completed?.payload.state, "completed");
      assert.include(bodies[1]!, "Tool arguments must be valid JSON object");
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("auto mode auto-runs read-only Azure MCP tools and requests approval otherwise", () =>
    Effect.gen(function* () {
      const threadId = thread("azure-mcp-auto-mode");
      const bodies: string[] = [];
      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeAdapter(
        clientFor(
          () =>
            bodies.length === 1
              ? sse([
                  sseData({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-read",
                              type: "function",
                              function: { name: "azure-search__search", arguments: "{}" },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  }),
                  "data: [DONE]\n\n",
                ])
              : sse([
                  sseData({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
                  "data: [DONE]\n\n",
                ]),
          bodies,
        ),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              {
                name: "azure-search__search",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
            ],
            callTool: async (input) => {
              calls.push(input);
              return { content: [{ type: "text", text: "result" }] };
            },
          }),
        },
      );
      const turnCompleted = yield* Ref.make(0);
      const opened = yield* Ref.make(0);
      const listen = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "turn.completed") return Ref.update(turnCompleted, (n) => n + 1);
        if (event.type === "request.opened") return Ref.update(opened, (n) => n + 1);
        return Effect.void;
      }).pipe(Effect.forkChild);
      yield* adapter.startSession({
        ...startInput("azure-mcp-auto-mode"),
        runtimeMode: "auto",
      });
      yield* adapter.sendTurn({ threadId, input: "read only" });
      for (let attempt = 0; attempt < 200 && (yield* Ref.get(turnCompleted)) < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.deepStrictEqual(calls, [{ name: "azure-search__search", arguments: {} }]);
      assert.equal(yield* Ref.get(opened), 0);
      yield* Fiber.interrupt(listen);
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("acceptForSession approves the tool for the session and resets on a new session", () =>
    Effect.gen(function* () {
      const threadId = thread("azure-mcp-accept-session");
      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      let providerCalls = 0;
      const adapter = yield* makeAdapter(
        clientFor(() => {
          providerCalls += 1;
          return providerCalls % 2 === 1
            ? sse([
                sseData({
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-write",
                            type: "function",
                            function: { name: "azure-search__write", arguments: "{}" },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                }),
                "data: [DONE]\n\n",
              ])
            : sse([
                sseData({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
                "data: [DONE]\n\n",
              ]);
        }),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              { name: "azure-search__write", inputSchema: { type: "object" } },
            ],
            callTool: async (input) => {
              calls.push(input);
              return { content: [] };
            },
          }),
        },
      );
      const opened = yield* Ref.make(0);
      const turnCompleted = yield* Ref.make(0);
      const listen = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "request.opened") {
          return Ref.update(opened, (count) => count + 1).pipe(
            Effect.andThen(
              adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "acceptForSession",
              ),
            ),
          );
        }
        if (event.type === "turn.completed") return Ref.update(turnCompleted, (n) => n + 1);
        return Effect.void;
      }).pipe(Effect.forkChild);
      const waitForTurn = (count: number) =>
        Effect.gen(function* () {
          for (
            let attempt = 0;
            attempt < 200 && (yield* Ref.get(turnCompleted)) < count;
            attempt += 1
          ) {
            yield* Effect.yieldNow;
          }
        });

      yield* adapter.startSession({
        ...startInput("azure-mcp-accept-session"),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "write one" });
      yield* waitForTurn(1);
      assert.equal(calls.length, 1);
      assert.equal(yield* Ref.get(opened), 1);

      // The same tool in the same session runs without a new request.
      yield* adapter.sendTurn({ threadId, input: "write two" });
      yield* waitForTurn(2);
      assert.equal(calls.length, 2);
      assert.equal(yield* Ref.get(opened), 1);

      // A fresh session resets the accept-for-session grant.
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        ...startInput("azure-mcp-accept-session"),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "write three" });
      yield* waitForTurn(3);
      assert.equal(calls.length, 3);
      assert.equal(yield* Ref.get(opened), 2);

      yield* Fiber.interrupt(listen);
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("fails open when the Azure MCP server errors during a tool call", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const threadId = thread("azure-mcp-server-failure");
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeAdapter(
        clientFor(
          () =>
            bodies.length === 1
              ? sse([
                  sseData({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call-fail",
                              type: "function",
                              function: { name: "azure-search__search", arguments: "{}" },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                  }),
                  "data: [DONE]\n\n",
                ])
              : sse([
                  sseData({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }),
                  "data: [DONE]\n\n",
                ]),
          bodies,
        ),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              {
                name: "azure-search__search",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
            ],
            callTool: async () => {
              throw new Error("server exploded");
            },
          }),
        },
      );
      yield* adapter.startSession({
        ...startInput("azure-mcp-server-failure"),
        runtimeMode: "auto",
      });
      yield* adapter.sendTurn({ threadId, input: "query" });
      const completed = Option.getOrUndefined(
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
        ),
      );
      assert.equal(completed?.type, "turn.completed");
      assert.equal(completed?.payload.state, "completed");
      assert.include(bodies[1]!, "Azure MCP server failed while running this tool");
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("interrupts an Azure MCP tool loop while a tool call is in flight", () =>
    Effect.gen(function* () {
      const threadId = thread("azure-mcp-interrupt-loop");
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      const inFlight = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const adapter = yield* makeAdapter(
        clientFor(() =>
          sse([
            sseData({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-hang",
                        type: "function",
                        function: { name: "azure-search__search", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
            }),
            "data: [DONE]\n\n",
          ]),
        ),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              {
                name: "azure-search__search",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true, destructiveHint: false },
              },
            ],
            callTool: () =>
              new Promise<unknown>((resolve) => {
                Effect.runSync(Deferred.succeed(inFlight, undefined));
                Effect.runPromise(Deferred.await(release)).then(() => resolve({ content: [] }));
              }),
          }),
        },
      );
      yield* adapter.startSession({
        ...startInput("azure-mcp-interrupt-loop"),
        runtimeMode: "auto",
      });
      const sent = yield* adapter.sendTurn({ threadId, input: "hang" }).pipe(Effect.forkChild);
      yield* Deferred.await(inFlight).pipe(Effect.timeout("1 second"));
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(sent);
      const aborted = Option.getOrUndefined(
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.aborted"),
        ),
      );
      assert.equal(aborted?.type, "turn.aborted");
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("reports a model that rejects function tools as a limitation", () =>
    Effect.gen(function* () {
      const threadId = thread("azure-mcp-tool-rejection");
      McpProviderSession.setMcpProviderSession({
        environmentId: "environment" as never,
        threadId,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("test-openai-compatible"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer test",
      });
      const adapter = yield* makeAdapter(
        clientFor(() => response("model does not support tools", 400)),
        {
          mcpClientFactory: async () => ({
            listTools: async () => [
              { name: "azure-search__search", inputSchema: { type: "object" } },
            ],
            callTool: async () => ({ content: [] }),
          }),
        },
      );
      yield* adapter.startSession(startInput("azure-mcp-tool-rejection"));
      yield* adapter.sendTurn({ threadId, input: "search" });
      const completed = Option.getOrUndefined(
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
        ),
      );
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
        assert.include(
          completed.payload.errorMessage ?? "",
          "rejected OpenAI-compatible function tools",
        );
      }
      McpProviderSession.clearMcpProviderSession(threadId);
    }),
  );

  it.effect("runs the Azure MCP tool loop for every direct provider", () =>
    Effect.gen(function* () {
      const kinds = [
        ProviderDriverKind.make("nvidiaNim"),
        ProviderDriverKind.make("openrouter"),
        ProviderDriverKind.make("opencodeZen"),
      ] as const;
      for (const kind of kinds) {
        const threadId = thread(`azure-mcp-${String(kind)}`);
        const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
        const bodies: string[] = [];
        McpProviderSession.setMcpProviderSession({
          environmentId: "environment" as never,
          threadId,
          providerSessionId: "provider-session",
          providerInstanceId: ProviderInstanceId.make(String(kind)),
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: "Bearer test",
        });
        const adapter = yield* makeAdapter(
          clientFor(
            () =>
              bodies.length === 1
                ? sse([
                    sseData({
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                id: "call-search",
                                type: "function",
                                function: {
                                  name: "azure-search__search",
                                  arguments: '{"q":"Nvidia"}',
                                },
                              },
                            ],
                          },
                          finish_reason: "tool_calls",
                        },
                      ],
                    }),
                    "data: [DONE]\n\n",
                  ])
                : sse([
                    sseData({
                      choices: [{ delta: { content: "Found it" }, finish_reason: "stop" }],
                    }),
                    "data: [DONE]\n\n",
                  ]),
            bodies,
          ),
          {
            provider: kind,
            mcpClientFactory: async () => ({
              listTools: async () => [
                {
                  name: "azure-search__search",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true, destructiveHint: false },
                },
              ],
              callTool: async (input) => {
                calls.push(input);
                return { content: [{ type: "text", text: "result" }] };
              },
            }),
          },
        );
        yield* adapter.startSession({
          ...startInput(`azure-mcp-${String(kind)}`),
          provider: kind,
          modelSelection: {
            instanceId: ProviderInstanceId.make(String(kind)),
            model:
              kind === ProviderDriverKind.make("nvidiaNim")
                ? "stepfun-ai/step-3.7-flash"
                : "test-model",
          },
        });
        yield* adapter.sendTurn({ threadId, input: "Find Nvidia" });
        yield* Stream.runHead(
          Stream.filter(adapter.streamEvents, (event) => event.type === "turn.completed"),
        );
        assert.deepStrictEqual(calls, [
          { name: "azure-search__search", arguments: { q: "Nvidia" } },
        ]);
        assert.equal(bodies.length, 2);
        assert.include(bodies[1]!, '"tool_call_id":"call-search"');
        McpProviderSession.clearMcpProviderSession(threadId);
      }
    }),
  );
});
