// @effect-diagnostics globalDate:off
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterSessionNotFoundError, ProviderAdapterValidationError } from "../Errors.ts";

export interface OpenAICompatibleTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
}

export type OpenAICompatibleToolChoice = "none" | "auto" | "required" | Record<string, unknown>;

export interface OpenAICompatibleRuntimeOptions {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly allowEmptyApiKey?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly modelsPath?: string;
  readonly chatCompletionsPath?: string;
  readonly defaultModel?: string;
  readonly tools?: ReadonlyArray<OpenAICompatibleTool>;
  readonly toolChoice?: OpenAICompatibleToolChoice;
}

export interface OpenAICompatibleModel {
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface OpenAICompatibleToolResultInput {
  readonly threadId: ThreadId;
  readonly toolCallId: string;
  readonly content: string;
}

export class OpenAICompatibleValidationError extends Schema.TaggedErrorClass<OpenAICompatibleValidationError>()(
  "OpenAICompatibleValidationError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `OpenAI-compatible validation failed in ${this.operation}: ${this.detail}`;
  }
}

export class OpenAICompatibleAuthError extends Schema.TaggedErrorClass<OpenAICompatibleAuthError>()(
  "OpenAICompatibleAuthError",
  { operation: Schema.String, status: Schema.Int },
) {
  override get message(): string {
    return `OpenAI-compatible authentication failed in ${this.operation} (HTTP ${this.status}).`;
  }
}

export class OpenAICompatibleNetworkError extends Schema.TaggedErrorClass<OpenAICompatibleNetworkError>()(
  "OpenAICompatibleNetworkError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `OpenAI-compatible network request failed in ${this.operation}.`;
  }
}

export class OpenAICompatibleMalformedResponseError extends Schema.TaggedErrorClass<OpenAICompatibleMalformedResponseError>()(
  "OpenAICompatibleMalformedResponseError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `OpenAI-compatible response was malformed in ${this.operation}: ${this.detail}`;
  }
}

export class OpenAICompatibleProviderError extends Schema.TaggedErrorClass<OpenAICompatibleProviderError>()(
  "OpenAICompatibleProviderError",
  { operation: Schema.String, status: Schema.Int },
) {
  override get message(): string {
    return `OpenAI-compatible provider request failed in ${this.operation} (HTTP ${this.status}).`;
  }
}

export type OpenAICompatibleError =
  | OpenAICompatibleValidationError
  | OpenAICompatibleAuthError
  | OpenAICompatibleNetworkError
  | OpenAICompatibleMalformedResponseError
  | OpenAICompatibleProviderError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError;

type Message = {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly reasoning_content?: string;
  readonly reasoning_details?: ReadonlyArray<unknown>;
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly tool_call_id?: string;
};

type ToolCall = NonNullable<Message["tool_calls"]>[number];

interface TurnState {
  readonly id: TurnId;
  readonly messages: ReadonlyArray<Message>;
  readonly items: ReadonlyArray<unknown>;
}

interface SessionState {
  session: ProviderSession;
  messages: Message[];
  turns: TurnState[];
  activeTurnId: TurnId | undefined;
  interruptSignals: Map<TurnId, Deferred.Deferred<void>>;
  interrupted: Set<TurnId>;
  turnFiber: Fiber.Fiber<void, never> | undefined;
}

const RESUME_VERSION = 1;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

function now(): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Date.now()));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function makeError(operation: string, cause: unknown): OpenAICompatibleNetworkError {
  return new OpenAICompatibleNetworkError({ operation });
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function requestWithHeaders(
  request: HttpClientRequest.HttpClientRequest,
  options: OpenAICompatibleRuntimeOptions,
): HttpClientRequest.HttpClientRequest {
  return request.pipe(
    HttpClientRequest.setHeaders({
      ...options.headers,
      ...(options.apiKey.trim() ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      Accept: "application/json",
    }),
  );
}

function responseBody(
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  operation: string,
): Effect.Effect<string, OpenAICompatibleError> {
  return client.execute(request).pipe(
    Effect.mapError(() => makeError(operation, undefined)),
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.mapError(() => makeError(operation, undefined)),
        Effect.flatMap((body) =>
          response.status >= 200 && response.status < 300
            ? Effect.succeed(body)
            : Effect.fail(
                isAuthStatus(response.status)
                  ? new OpenAICompatibleAuthError({ operation, status: response.status })
                  : new OpenAICompatibleProviderError({ operation, status: response.status }),
              ),
        ),
      ),
    ),
  );
}

function parseJson(
  operation: string,
  body: string,
): Effect.Effect<unknown, OpenAICompatibleMalformedResponseError> {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
  return Effect.try({
    try: () => decode(body),
    catch: () => new OpenAICompatibleMalformedResponseError({ operation, detail: "Invalid JSON." }),
  });
}

function makeEventBase(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  eventNumber: number,
  turnId?: TurnId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: EventId.make(`openai-compatible:${String(threadId)}:${eventNumber}`),
    provider,
    threadId,
    createdAt: now(),
    ...(turnId ? { turnId } : {}),
  };
}

function appendSseLine(state: { data: string[]; done: boolean }, line: string): string | undefined {
  if (line === "") {
    if (state.data.length === 0) return undefined;
    const data = state.data.join("\n");
    state.data = [];
    return data;
  }
  if (line.startsWith(":")) return undefined;
  if (line.startsWith("data:")) {
    state.data.push(line.slice(5).replace(/^ /u, ""));
  }
  return undefined;
}

function validateChoice(operation: string, value: unknown): Record<string, unknown> {
  if (!record(value)) {
    throw new OpenAICompatibleMalformedResponseError({ operation, detail: "Invalid choice." });
  }
  return value;
}

export interface OpenAICompatibleAdapter extends ProviderAdapterShape<OpenAICompatibleError> {
  readonly listModels: () => Effect.Effect<
    ReadonlyArray<OpenAICompatibleModel>,
    OpenAICompatibleError
  >;
  readonly sendToolResult: (
    input: OpenAICompatibleToolResultInput,
  ) => Effect.Effect<ProviderTurnStartResult, OpenAICompatibleError>;
}

export const makeOpenAICompatibleAdapter = Effect.fn("makeOpenAICompatibleAdapter")(function* (
  options: OpenAICompatibleRuntimeOptions,
) {
  const client = yield* HttpClient.HttpClient;
  if (!options.baseUrl.trim() || (!options.apiKey.trim() && !options.allowEmptyApiKey)) {
    return yield* new OpenAICompatibleValidationError({
      operation: "create",
      detail: "baseUrl and apiKey are required.",
    });
  }

  const sessions = new Map<ThreadId, SessionState>();
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  let eventNumber = 0;
  let turnNumber = 0;

  const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event);
  const nextTurnId = () => TurnId.make(`openai-compatible-turn:${++turnNumber}`);
  const sessionError = (threadId: ThreadId) =>
    new ProviderAdapterSessionNotFoundError({
      provider: String(options.provider),
      threadId: String(threadId),
    });
  const getSession = (threadId: ThreadId): Effect.Effect<SessionState, OpenAICompatibleError> => {
    const state = sessions.get(threadId);
    return state ? Effect.succeed(state) : Effect.fail(sessionError(threadId));
  };

  const listModels = Effect.fn("OpenAICompatible.listModels")(function* () {
    if (!options.apiKey.trim()) {
      return yield* new OpenAICompatibleAuthError({ operation: "models", status: 401 });
    }
    const body = yield* responseBody(
      client,
      requestWithHeaders(
        HttpClientRequest.get(joinUrl(options.baseUrl, options.modelsPath ?? "/models")),
        options,
      ),
      "models",
    );
    const parsed = yield* parseJson("models", body);
    if (!record(parsed) || !Array.isArray(parsed.data)) {
      return yield* new OpenAICompatibleMalformedResponseError({
        operation: "models",
        detail: "Expected a data array.",
      });
    }
    return parsed.data.map((model) => {
      if (!record(model) || typeof model.id !== "string" || model.id.length === 0) {
        throw new OpenAICompatibleMalformedResponseError({
          operation: "models",
          detail: "Model entries require an id.",
        });
      }
      return model as OpenAICompatibleModel;
    });
  });

  const startSession: ProviderAdapterShape<OpenAICompatibleError>["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== options.provider) {
        return yield* new ProviderAdapterValidationError({
          provider: String(options.provider),
          operation: "startSession",
          issue: "Provider does not match this adapter.",
        });
      }
      if (sessions.has(input.threadId)) {
        return yield* new ProviderAdapterValidationError({
          provider: String(options.provider),
          operation: "startSession",
          issue: "Session already exists.",
        });
      }
      const model = input.modelSelection?.model ?? options.defaultModel;
      const createdAt = now();
      const session: ProviderSession = {
        provider: options.provider,
        ...(options.providerInstanceId
          ? { providerInstanceId: ProviderInstanceId.make(options.providerInstanceId) }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(model ? { model } : {}),
        threadId: input.threadId,
        resumeCursor: { schemaVersion: RESUME_VERSION, threadId: String(input.threadId) },
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(input.threadId, {
        session,
        messages: [],
        turns: [],
        activeTurnId: undefined,
        interruptSignals: new Map(),
        interrupted: new Set(),
        turnFiber: undefined,
      });
      yield* emit({
        ...makeEventBase(options.provider, input.threadId, ++eventNumber),
        type: "session.started",
        payload: { resume: session.resumeCursor },
      });
      yield* emit({
        ...makeEventBase(options.provider, input.threadId, ++eventNumber),
        type: "thread.started",
        payload: {},
      });
      return session;
    });

  const runTurn = (
    state: SessionState,
    input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly model?: string;
      readonly beforeMessages: number;
      readonly beforeTurns: number;
    },
  ): Effect.Effect<void, OpenAICompatibleError> =>
    Effect.gen(function* () {
      const operation = "chat.completions";
      const toolCalls = new Map<number, ToolCall>();
      let assistantText = "";
      let reasoningContent = "";
      const reasoningDetails: unknown[] = [];
      let finishReason: string | undefined;
      let usage: unknown;
      yield* emit({
        ...makeEventBase(options.provider, input.threadId, ++eventNumber, input.turnId),
        type: "turn.started",
        payload: { ...(input.model ? { model: input.model } : {}) },
      });

      const payload: Record<string, unknown> = {
        model: input.model ?? options.defaultModel,
        messages: state.messages,
        stream: true,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      };
      if (typeof payload.model !== "string" || payload.model.length === 0) {
        return yield* new OpenAICompatibleValidationError({
          operation,
          detail: "A model is required.",
        });
      }
      if (!options.apiKey.trim()) {
        return yield* new OpenAICompatibleAuthError({ operation, status: 401 });
      }

      const response = yield* client
        .execute(
          requestWithHeaders(
            HttpClientRequest.post(
              joinUrl(options.baseUrl, options.chatCompletionsPath ?? "/chat/completions"),
            ).pipe(
              HttpClientRequest.bodyJsonUnsafe(payload),
              HttpClientRequest.setHeaders({
                "Content-Type": "application/json",
                Accept: "text/event-stream",
              }),
            ),
            options,
          ),
        )
        .pipe(Effect.mapError(() => makeError(operation, undefined)));
      if (response.status < 200 || response.status >= 300) {
        return yield* response.text.pipe(
          Effect.mapError(() => makeError(operation, undefined)),
          Effect.flatMap(() =>
            Effect.fail(
              isAuthStatus(response.status)
                ? new OpenAICompatibleAuthError({ operation, status: response.status })
                : new OpenAICompatibleProviderError({ operation, status: response.status }),
            ),
          ),
        );
      }

      const sse = { data: [], done: false };
      let buffer = "";
      const processData = (data: string): Effect.Effect<void, OpenAICompatibleError> => {
        if (data === "[DONE]") {
          sse.done = true;
          return Effect.void;
        }
        return parseJson(operation, data).pipe(
          Effect.flatMap((parsed) => {
            if (!record(parsed) || !Array.isArray(parsed.choices)) {
              return Effect.fail(
                new OpenAICompatibleMalformedResponseError({
                  operation,
                  detail: "Expected choices.",
                }),
              );
            }
            if (parsed.usage !== undefined) usage = parsed.usage;
            return Effect.forEach(
              parsed.choices,
              (rawChoice) => {
                const choice = validateChoice(operation, rawChoice);
                const delta = choice.delta;
                if (delta !== undefined && !record(delta)) {
                  return Effect.fail(
                    new OpenAICompatibleMalformedResponseError({
                      operation,
                      detail: "Invalid delta.",
                    }),
                  );
                }
                const deltaRecord = record(delta) ? delta : {};
                const effects: Array<Effect.Effect<void, OpenAICompatibleError, never>> = [];
                const content = text(deltaRecord.content);
                if (content) {
                  assistantText += content;
                  effects.push(
                    emit({
                      ...makeEventBase(
                        options.provider,
                        input.threadId,
                        ++eventNumber,
                        input.turnId,
                      ),
                      type: "content.delta",
                      payload: { streamKind: "assistant_text", delta: content },
                    }),
                  );
                }
                const reasoning = text(deltaRecord.reasoning_content);
                if (reasoning) {
                  reasoningContent += reasoning;
                  effects.push(
                    emit({
                      ...makeEventBase(
                        options.provider,
                        input.threadId,
                        ++eventNumber,
                        input.turnId,
                      ),
                      type: "content.delta",
                      payload: { streamKind: "reasoning_text", delta: reasoning },
                    }),
                  );
                }
                if (Array.isArray(deltaRecord.reasoning_details)) {
                  reasoningDetails.push(...deltaRecord.reasoning_details);
                }
                if (Array.isArray(deltaRecord.tool_calls)) {
                  effects.push(
                    Effect.forEach(
                      deltaRecord.tool_calls,
                      (rawToolCall) => {
                        if (!record(rawToolCall) || typeof rawToolCall.index !== "number") {
                          return Effect.fail(
                            new OpenAICompatibleMalformedResponseError({
                              operation,
                              detail: "Invalid tool call.",
                            }),
                          );
                        }
                        const index = rawToolCall.index;
                        const previous = toolCalls.get(index);
                        const fn = record(rawToolCall.function) ? rawToolCall.function : {};
                        const next: ToolCall = {
                          id: text(rawToolCall.id) ?? previous?.id ?? `tool-call-${index}`,
                          type: "function",
                          function: {
                            name: text(fn.name) ?? previous?.function.name ?? "",
                            arguments:
                              (previous?.function.arguments ?? "") + (text(fn.arguments) ?? ""),
                          },
                        };
                        toolCalls.set(index, next);
                        const itemId = RuntimeItemId.make(`tool:${String(input.turnId)}:${index}`);
                        return emit({
                          ...makeEventBase(
                            options.provider,
                            input.threadId,
                            ++eventNumber,
                            input.turnId,
                          ),
                          itemId,
                          type: "item.updated",
                          payload: {
                            itemType: "dynamic_tool_call",
                            status: "inProgress",
                            data: next,
                          },
                        });
                      },
                      { discard: true },
                    ),
                  );
                }
                if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
                if (choice.usage !== undefined) usage = choice.usage;
                return Effect.all(effects, { discard: true });
              },
              { discard: true },
            );
          }),
        );
      };

      const consume = HttpClientResponse.stream(Effect.succeed(response)).pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() ?? "";
          return Effect.forEach(
            lines,
            (line) => {
              const data = appendSseLine(sse, line);
              return data === undefined ? Effect.void : processData(data);
            },
            { discard: true },
          );
        }),
        Effect.mapError((cause) =>
          Schema.is(OpenAICompatibleMalformedResponseError)(cause)
            ? cause
            : makeError(operation, cause),
        ),
      );
      yield* consume;
      if (buffer.length > 0) {
        const data = appendSseLine(sse, buffer);
        if (data !== undefined) yield* processData(data);
      }
      if (!sse.done) {
        return yield* new OpenAICompatibleMalformedResponseError({
          operation,
          detail: "SSE stream ended before [DONE].",
        });
      }

      const assembledToolCalls = Array.from(toolCalls.entries())
        .sort(([left], [right]) => left - right)
        .map(([, value]) => value);
      const assistant: Message = {
        role: "assistant",
        content: assistantText || null,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(reasoningDetails.length > 0 ? { reasoning_details: reasoningDetails } : {}),
        ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
      };
      state.messages.push(assistant);
      const itemList = [
        ...(assistantText ? [{ type: "assistantMessage", text: assistantText }] : []),
        ...(reasoningContent
          ? [{ type: "reasoning", text: reasoningContent, details: reasoningDetails }]
          : []),
        ...assembledToolCalls.map((tool) => ({ type: "toolCall", tool })),
      ];
      const turn: TurnState = {
        id: input.turnId,
        messages: state.messages.slice(input.beforeMessages),
        items: itemList,
      };
      state.turns.push(turn);
      for (const [index, tool] of toolCalls) {
        yield* emit({
          ...makeEventBase(options.provider, input.threadId, ++eventNumber, input.turnId),
          itemId: RuntimeItemId.make(`tool:${String(input.turnId)}:${index}`),
          type: "item.completed",
          payload: { itemType: "dynamic_tool_call", status: "completed", data: tool },
        });
      }
      yield* emit({
        ...makeEventBase(options.provider, input.threadId, ++eventNumber, input.turnId),
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: finishReason ?? null,
          ...(usage !== undefined ? { usage } : {}),
        },
      });
    });

  const rollbackTurn = (state: SessionState, beforeMessages: number, beforeTurns: number) => {
    state.messages.splice(beforeMessages);
    state.turns.splice(beforeTurns);
  };

  const settleTurn = (
    state: SessionState,
    input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly beforeMessages: number;
      readonly beforeTurns: number;
    },
  ): Effect.Effect<void, never> =>
    Effect.raceFirst(
      runTurn(state, input).pipe(Effect.as("completed" as const)),
      Deferred.await(state.interruptSignals.get(input.turnId)!).pipe(
        Effect.flatMap(() =>
          emit({
            ...makeEventBase(options.provider, input.threadId, ++eventNumber, input.turnId),
            type: "turn.aborted",
            payload: { reason: "interrupted" },
          }),
        ),
        Effect.as("aborted" as const),
      ),
    ).pipe(
      Effect.flatMap((result) => {
        if (result !== "aborted") {
          state.session = {
            ...state.session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: now(),
          };
          return Effect.void;
        }
        rollbackTurn(state, input.beforeMessages, input.beforeTurns);
        state.session = {
          ...state.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: now(),
        };
        return Effect.void;
      }),
      Effect.catch((error: OpenAICompatibleError) => {
        rollbackTurn(state, input.beforeMessages, input.beforeTurns);
        const detail = error instanceof Error ? error.message : "Provider turn failed.";
        state.session = {
          ...state.session,
          status: "error",
          activeTurnId: undefined,
          lastError: detail,
          updatedAt: now(),
        };
        return emit({
          ...makeEventBase(options.provider, input.threadId, ++eventNumber, input.turnId),
          type: "turn.completed",
          payload: { state: "failed", errorMessage: detail },
        });
      }),
      Effect.ensuring(
        Effect.sync(() => {
          state.activeTurnId = undefined;
          state.turnFiber = undefined;
          state.interruptSignals.delete(input.turnId);
        }),
      ),
    );

  const startTurn = (
    state: SessionState,
    input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly model?: string;
      readonly beforeMessages: number;
      readonly beforeTurns: number;
    },
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      state.activeTurnId = input.turnId;
      state.session = {
        ...state.session,
        status: "running",
        ...(input.model ? { model: input.model } : {}),
        activeTurnId: input.turnId,
        updatedAt: now(),
      };
      const fiber = yield* settleTurn(state, input).pipe(
        Effect.forkDetach({ startImmediately: true }),
      );
      state.turnFiber = fiber;
    });

  const sendTurn = (
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, OpenAICompatibleError> =>
    Effect.gen(function* () {
      const state = yield* getSession(input.threadId);
      if (state.activeTurnId !== undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: String(options.provider),
          operation: "sendTurn",
          issue: "A turn is already running.",
        });
      }
      if ((input.attachments?.length ?? 0) > 0) {
        return yield* new ProviderAdapterValidationError({
          provider: String(options.provider),
          operation: "sendTurn",
          issue: "This OpenAI-compatible provider does not support attachments.",
        });
      }
      const prompt = input.input?.trim();
      if (!prompt) {
        return yield* new OpenAICompatibleValidationError({
          operation: "sendTurn",
          detail: "input is required.",
        });
      }
      const model = input.modelSelection?.model ?? state.session.model ?? options.defaultModel;
      const turnId = nextTurnId();
      const beforeMessages = state.messages.length;
      const beforeTurns = state.turns.length;
      const interrupt = yield* Deferred.make<void>();
      state.messages.push({ role: "user", content: prompt });
      state.interruptSignals.set(turnId, interrupt);
      yield* startTurn(state, {
        threadId: input.threadId,
        turnId,
        beforeMessages,
        beforeTurns,
        ...(model === undefined ? {} : { model }),
      });
      return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
    });

  const sendToolResult = (input: OpenAICompatibleToolResultInput) =>
    Effect.gen(function* () {
      const state = yield* getSession(input.threadId);
      const lastAssistant = [...state.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      const call = lastAssistant?.tool_calls?.find((tool) => tool.id === input.toolCallId);
      if (!call) {
        return yield* new OpenAICompatibleValidationError({
          operation: "sendToolResult",
          detail: "toolCallId does not match a local tool call.",
        });
      }
      const beforeMessages = state.messages.length;
      const beforeTurns = state.turns.length;
      state.messages.push({ role: "tool", content: input.content, tool_call_id: input.toolCallId });
      const turnId = nextTurnId();
      const interrupt = yield* Deferred.make<void>();
      state.interruptSignals.set(turnId, interrupt);
      yield* startTurn(state, { threadId: input.threadId, turnId, beforeMessages, beforeTurns });
      return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
    });

  const adapter: OpenAICompatibleAdapter = {
    provider: options.provider,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    sendToolResult,
    listModels,
    interruptTurn: (threadId, turnId) =>
      getSession(threadId).pipe(
        Effect.tap((state) =>
          Effect.gen(function* () {
            if (
              state.activeTurnId !== undefined &&
              (turnId === undefined || state.activeTurnId === turnId)
            ) {
              state.interrupted.add(state.activeTurnId);
              const signal = state.interruptSignals.get(state.activeTurnId);
              if (signal) yield* Deferred.succeed(signal, undefined);
            }
          }),
        ),
        Effect.asVoid,
      ),
    respondToRequest: (threadId) => getSession(threadId).pipe(Effect.asVoid),
    respondToUserInput: (threadId) => getSession(threadId).pipe(Effect.asVoid),
    stopSession: (threadId) =>
      Effect.gen(function* () {
        const state = yield* getSession(threadId);
        if (state.activeTurnId !== undefined) {
          const signal = state.interruptSignals.get(state.activeTurnId);
          if (signal) yield* Deferred.succeed(signal, undefined);
        }
        if (state.turnFiber) {
          yield* Fiber.join(state.turnFiber);
        }
        state.activeTurnId = undefined;
        state.session = { ...state.session, status: "closed", updatedAt: now() };
        sessions.delete(threadId);
        yield* emit({
          ...makeEventBase(options.provider, threadId, ++eventNumber),
          type: "session.exited",
          payload: { reason: "stopped", exitKind: "graceful" },
        });
      }),
    listSessions: () =>
      Effect.succeed(
        Array.from(sessions.values(), (state) => ({
          ...state.session,
          ...(state.activeTurnId
            ? { activeTurnId: state.activeTurnId, status: "running" as const }
            : {}),
          updatedAt: now(),
        })),
      ),
    hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
    readThread: (threadId) =>
      getSession(threadId).pipe(
        Effect.map((state) => ({
          threadId,
          turns: state.turns.map((turn) => ({ id: turn.id, items: turn.items })),
        })),
      ),
    rollbackThread: (threadId, numTurns) =>
      Effect.gen(function* () {
        const state = yield* getSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 0) {
          return yield* new OpenAICompatibleValidationError({
            operation: "rollbackThread",
            detail: "numTurns must be a non-negative integer.",
          });
        }
        state.turns.splice(Math.max(0, state.turns.length - numTurns), numTurns);
        state.messages = state.turns.flatMap((turn) => [...turn.messages]);
        return { threadId, turns: state.turns.map((turn) => ({ id: turn.id, items: turn.items })) };
      }),
    stopAll: () =>
      Effect.forEach(Array.from(sessions.keys()), (threadId) => adapter.stopSession(threadId), {
        discard: true,
      }),
    streamEvents: Stream.fromQueue(events),
  };
  yield* Effect.addFinalizer(() =>
    adapter.stopAll().pipe(Effect.andThen(Queue.shutdown(events)), Effect.ignore),
  );
  return adapter;
});

function yieldParse(operation: string, data: string): Record<string, unknown> {
  const parsed = JSON.parse(data) as unknown;
  if (!record(parsed)) {
    throw new OpenAICompatibleMalformedResponseError({
      operation,
      detail: "Expected a JSON object.",
    });
  }
  return parsed;
}
