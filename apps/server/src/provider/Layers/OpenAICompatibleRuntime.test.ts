import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { describe } from "vite-plus/test";
import { ProviderDriverKind, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  makeOpenAICompatibleAdapter,
  OpenAICompatibleAuthError,
  OpenAICompatibleMalformedResponseError,
  OpenAICompatibleNetworkError,
  type OpenAICompatibleAdapter,
  type OpenAICompatibleRuntimeOptions,
} from "./OpenAICompatibleRuntime.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";

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
      const events = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6));
      const deltas = events
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta",
        )
        .map((event) => event.payload.delta);
      assert.deepStrictEqual(deltas, ["think", "hello"]);
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
});
