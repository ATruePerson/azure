// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderOptionSelection,
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

import type {
  ProviderAdapterShape,
  ProviderContextCompactionResult,
} from "../Services/ProviderAdapter.ts";
import { resolveModelContextWindow } from "@t3tools/shared/model";
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
    const unavailableModelHint =
      this.status === 404 ? " The selected model may be unavailable for this account." : "";
    return `OpenAI-compatible provider request failed in ${this.operation} (HTTP ${this.status}).${unavailableModelHint}`;
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
  readonly role: "system" | "user" | "assistant" | "tool";
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
  modelOptions: ReadonlyArray<ProviderOptionSelection>;
  totalProcessedTokens: number;
  contextUsedTokens: number;
  compacted: boolean;
  compactedThrough?: TurnId;
}

const RESUME_VERSION = 2;

function resumeMessages(value: unknown): Message[] {
  if (!record(value) || !Array.isArray(value.messages)) return [];
  return value.messages.flatMap((raw) => {
    if (!record(raw) || !["system", "user", "assistant", "tool"].includes(String(raw.role))) {
      return [];
    }
    const content =
      raw.content === null || typeof raw.content === "string" ? raw.content : undefined;
    if (content === undefined) return [];
    const message: Message = {
      role: raw.role as Message["role"],
      content,
      ...(typeof raw.tool_call_id === "string" ? { tool_call_id: raw.tool_call_id } : {}),
      ...(typeof raw.reasoning_content === "string"
        ? { reasoning_content: raw.reasoning_content }
        : {}),
    };
    if (Array.isArray(raw.tool_calls)) {
      const toolCalls = raw.tool_calls.flatMap((tool) => {
        if (
          !record(tool) ||
          tool.type !== "function" ||
          typeof tool.id !== "string" ||
          !record(tool.function)
        )
          return [];
        if (typeof tool.function.name !== "string" || typeof tool.function.arguments !== "string")
          return [];
        return [
          {
            id: tool.id,
            type: "function" as const,
            function: { name: tool.function.name, arguments: tool.function.arguments },
          },
        ];
      });
      if (toolCalls.length > 0) return [{ ...message, tool_calls: toolCalls }];
    }
    return [message];
  });
}

function makeResumeCursor(
  threadId: ThreadId,
  messages: ReadonlyArray<Message>,
  compactedThrough?: TurnId,
): Record<string, unknown> {
  return {
    schemaVersion: RESUME_VERSION,
    threadId: String(threadId),
    messages,
    ...(compactedThrough ? { compactedThrough: String(compactedThrough) } : {}),
  };
}

function estimatedTokens(messages: ReadonlyArray<Message>): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

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

function optionValue(
  options: ReadonlyArray<ProviderOptionSelection>,
  id: string,
): string | undefined {
  const value = options.find((option) => option.id === id)?.value;
  return typeof value === "string" ? value : undefined;
}

function optionNumber(
  options: ReadonlyArray<ProviderOptionSelection>,
  id: string,
): number | undefined {
  const value = optionValue(options, id);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function requestOptions(
  provider: ProviderDriverKind,
  model: string,
  modelOptions: ReadonlyArray<ProviderOptionSelection>,
): Record<string, unknown> {
  const providerId = String(provider);
  if (providerId === "openrouter") {
    const effort = optionValue(modelOptions, "reasoningEffort");
    return effort ? { reasoning: { effort } } : {};
  }
  if (providerId !== "nvidiaNim") return {};
  if (model.toLowerCase() === "nvidia/nemotron-3-ultra-550b-a55b") {
    const effort = optionValue(modelOptions, "reasoningEffort");
    return effort && ["none", "medium", "high"].includes(effort)
      ? { reasoning_effort: effort }
      : {};
  }
  if (model.toLowerCase().includes("gpt-oss")) {
    const effort = optionValue(modelOptions, "reasoningEffort");
    return effort && ["low", "medium", "high"].includes(effort) ? { reasoning_effort: effort } : {};
  }
  return {};
}

function normalizedUsage(
  rawUsage: unknown,
  maxTokens: number | undefined,
  totalProcessedTokens: number,
  compactsAutomatically = false,
) {
  if (!record(rawUsage)) return null;
  const inputTokens = nonNegativeNumber(rawUsage.prompt_tokens);
  const outputTokens = nonNegativeNumber(rawUsage.completion_tokens);
  const totalTokens =
    nonNegativeNumber(rawUsage.total_tokens) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  if (totalTokens === undefined) return null;
  const details = record(rawUsage.completion_tokens_details)
    ? rawUsage.completion_tokens_details
    : null;
  const cachedInputTokens = record(rawUsage.prompt_tokens_details)
    ? nonNegativeNumber(rawUsage.prompt_tokens_details.cached_tokens)
    : undefined;
  const reasoningOutputTokens = details ? nonNegativeNumber(details.reasoning_tokens) : undefined;
  return {
    usedTokens: totalTokens,
    totalProcessedTokens: totalProcessedTokens + totalTokens,
    ...(maxTokens ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens, lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined
      ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
      : {}),
    ...(outputTokens !== undefined ? { outputTokens, lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    ...(compactsAutomatically ? { compactsAutomatically: true } : {}),
    lastUsedTokens: totalTokens,
  };
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
  const contextWindowTokensByModel = new Map<string, number>();
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  let eventNumber = 0;

  const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event);
  const nextTurnId = Effect.sync(() => TurnId.make(randomUUID()));
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
      const contextWindowTokens = positiveNumber(model.context_length);
      if (contextWindowTokens !== undefined) {
        contextWindowTokensByModel.set(model.id, contextWindowTokens);
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
      const existing = sessions.get(input.threadId);
      const model = input.modelSelection?.model ?? options.defaultModel;
      const createdAt = now();
      if (existing?.activeTurnId !== undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: String(options.provider),
          operation: "startSession",
          issue: "Cannot restart a session while a turn is active.",
        });
      }
      if (existing) {
        existing.modelOptions = input.modelSelection
          ? (input.modelSelection.options ?? [])
          : existing.modelOptions;
        existing.session = {
          ...existing.session,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(model ? { model } : {}),
          updatedAt: createdAt,
        };
        return existing.session;
      }
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
        resumeCursor: makeResumeCursor(
          input.threadId,
          resumeMessages(input.resumeCursor),
          record(input.resumeCursor) && typeof input.resumeCursor.compactedThrough === "string"
            ? TurnId.make(input.resumeCursor.compactedThrough)
            : undefined,
        ),
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(input.threadId, {
        session,
        messages: resumeMessages(input.resumeCursor),
        turns: [],
        activeTurnId: undefined,
        interruptSignals: new Map(),
        interrupted: new Set(),
        turnFiber: undefined,
        modelOptions: input.modelSelection?.options ?? [],
        totalProcessedTokens: 0,
        contextUsedTokens: estimatedTokens(resumeMessages(input.resumeCursor)),
        compacted:
          record(input.resumeCursor) && typeof input.resumeCursor.compactedThrough === "string",
        ...(record(input.resumeCursor) && typeof input.resumeCursor.compactedThrough === "string"
          ? { compactedThrough: TurnId.make(input.resumeCursor.compactedThrough) }
          : {}),
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

  const compactBeforeTurn = (
    state: SessionState,
    threadId: ThreadId,
    turnId: TurnId,
    model: string | undefined,
    additionalMessage?: Message,
    settings?: {
      readonly contextModel?: string;
      readonly contextOptions?: ReadonlyArray<ProviderOptionSelection>;
    },
  ): Effect.Effect<boolean, OpenAICompatibleError> =>
    Effect.gen(function* () {
      const contextModel = settings?.contextModel ?? model;
      const discoveredContextWindow = contextWindowTokensByModel.get(contextModel ?? "");
      const maximum = resolveModelContextWindow({
        provider: options.provider,
        model: contextModel,
        ...(discoveredContextWindow !== undefined ? { discovered: discoveredContextWindow } : {}),
      });
      if (!maximum) return false;
      const selectedMaxOutput =
        optionNumber(settings?.contextOptions ?? state.modelOptions, "maxOutputTokens") ?? 16_384;
      const threshold = Math.min(
        Math.floor(maximum * 0.99),
        Math.max(1, maximum - selectedMaxOutput - 1_024),
      );
      const projected = estimatedTokens(
        additionalMessage ? [...state.messages, additionalMessage] : state.messages,
      );
      if (projected < threshold) return false;
      if (state.messages.length <= 8) {
        return yield* new ProviderAdapterValidationError({
          provider: String(options.provider),
          operation: "context.compact",
          issue: "The selected model cannot fit this context without dropping a complete turn.",
        });
      }

      let keepStart = Math.max(0, state.messages.length - 8);
      while (keepStart > 0 && state.messages[keepStart]?.role === "tool") keepStart -= 1;
      const removed = state.messages
        .slice(0, keepStart)
        .filter((message) => message.role !== "system");
      if (removed.length === 0) return false;
      const keep = state.messages.slice(keepStart).filter((message) => message.role !== "system");
      const summaryRequest: Record<string, unknown> = {
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "Summarize the completed conversation context for a later assistant. Preserve decisions, constraints, unresolved work, and tool results. Be concise.",
          },
          // @effect-diagnostics-next-line preferSchemaOverJson:off -- Provider messages are already validated runtime values.
          { role: "user", content: JSON.stringify(removed) },
        ],
        ...requestOptions(options.provider, model ?? "", state.modelOptions),
      };
      const body = yield* responseBody(
        client,
        requestWithHeaders(
          HttpClientRequest.post(
            joinUrl(options.baseUrl, options.chatCompletionsPath ?? "/chat/completions"),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(summaryRequest),
            HttpClientRequest.setHeaders({ "Content-Type": "application/json" }),
          ),
          options,
        ),
        "context.compact",
      );
      const parsed = yield* parseJson("context.compact", body);
      const choices = record(parsed) && Array.isArray(parsed.choices) ? parsed.choices : [];
      const summary =
        choices.length > 0 && record(choices[0]) && record(choices[0].message)
          ? text(choices[0].message.content)
          : undefined;
      if (!summary?.trim()) {
        return yield* new OpenAICompatibleMalformedResponseError({
          operation: "context.compact",
          detail: "Provider returned no compaction summary.",
        });
      }
      state.messages = [
        ...state.messages.filter((message) => message.role === "system"),
        { role: "system", content: `<context_summary>\n${summary.trim()}\n</context_summary>` },
        ...keep,
      ];
      state.compacted = true;
      const compactedThrough = [...state.turns]
        .reverse()
        .find((turn) => turn.messages.some((message) => removed.includes(message)))?.id;
      if (compactedThrough) state.compactedThrough = compactedThrough;
      state.session = {
        ...state.session,
        resumeCursor: makeResumeCursor(threadId, state.messages, state.compactedThrough),
      };
      state.contextUsedTokens = estimatedTokens(state.messages);
      yield* emit({
        ...makeEventBase(options.provider, threadId, ++eventNumber, turnId),
        type: "thread.state.changed",
        payload: {
          state: "compacted",
          detail: { compactedThrough: String(state.compactedThrough ?? turnId) },
        },
      });
      // Keep the item-level signal for older consumers; orchestration uses the
      // canonical thread-state event above so this cannot create a duplicate
      // visible work-log entry.
      yield* emit({
        ...makeEventBase(options.provider, threadId, ++eventNumber, turnId),
        itemId: RuntimeItemId.make(`compaction:${String(turnId)}`),
        type: "item.completed",
        payload: {
          itemType: "context_compaction",
          status: "completed",
          title: "Context compacted",
          data: { compactedThrough: String(state.compactedThrough ?? turnId) },
        },
      });
      return true;
    });

  const runTurn = (
    state: SessionState,
    input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly model?: string;
      readonly beforeMessages: number;
      readonly beforeTurns: number;
      readonly modelOptions: ReadonlyArray<ProviderOptionSelection>;
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
        ...requestOptions(
          options.provider,
          input.model ?? options.defaultModel ?? "",
          input.modelOptions,
        ),
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
      if (assistantText.trim().length === 0 && assembledToolCalls.length === 0) {
        const detail = "Provider completed without assistant text or a tool call.";
        yield* emit({
          ...makeEventBase(options.provider, input.threadId, ++eventNumber, input.turnId),
          type: "turn.completed",
          payload: { state: "failed", errorMessage: detail },
        });
        return;
      }
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
      state.session = {
        ...state.session,
        resumeCursor: makeResumeCursor(input.threadId, state.messages, state.compactedThrough),
      };
      const usageSnapshot = normalizedUsage(
        usage,
        contextWindowTokensByModel.get(input.model ?? options.defaultModel ?? "") ??
          (String(options.provider) === "nvidiaNim" &&
          (input.model ?? options.defaultModel) === "nvidia/nemotron-3-ultra-550b-a55b"
            ? 1_000_000
            : undefined),
        state.totalProcessedTokens,
        state.compacted,
      );
      if (usageSnapshot) {
        state.totalProcessedTokens = usageSnapshot.totalProcessedTokens;
        state.contextUsedTokens = usageSnapshot.usedTokens;
        yield* emit({
          ...makeEventBase(options.provider, input.threadId, ++eventNumber, input.turnId),
          type: "thread.token-usage.updated",
          payload: { usage: usageSnapshot },
        });
      }
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
      readonly modelOptions: ReadonlyArray<ProviderOptionSelection>;
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
      readonly modelOptions: ReadonlyArray<ProviderOptionSelection>;
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
      state.modelOptions = input.modelSelection
        ? (input.modelSelection.options ?? [])
        : state.modelOptions;
      const turnId = yield* nextTurnId;
      const beforeMessages = state.messages.length;
      const beforeTurns = state.turns.length;
      const interrupt = yield* Deferred.make<void>();
      yield* compactBeforeTurn(state, input.threadId, turnId, model, {
        role: "user",
        content: prompt,
      });
      state.messages.push({ role: "user", content: prompt });
      state.session = {
        ...state.session,
        resumeCursor: makeResumeCursor(input.threadId, state.messages, state.compactedThrough),
      };
      state.interruptSignals.set(turnId, interrupt);
      yield* startTurn(state, {
        threadId: input.threadId,
        turnId,
        beforeMessages,
        beforeTurns,
        ...(model === undefined ? {} : { model }),
        modelOptions: state.modelOptions,
      });
      return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
    });

  const compactContext: NonNullable<OpenAICompatibleAdapter["compactContext"]> = (input) =>
    Effect.gen(function* () {
      const state = yield* getSession(input.threadId);
      if (state.activeTurnId !== undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: String(options.provider),
          operation: "compactContext",
          issue: "Cannot compact while a turn is running.",
        });
      }
      const turnId = yield* nextTurnId;
      const compacted = yield* compactBeforeTurn(
        state,
        input.threadId,
        turnId,
        state.session.model,
        undefined,
        {
          contextModel: input.targetModelSelection.model,
          ...(input.targetModelSelection.options !== undefined
            ? { contextOptions: input.targetModelSelection.options }
            : {}),
        },
      );
      const result: ProviderContextCompactionResult = compacted
        ? {
            outcome: "compacted",
            resumeCursor: state.session.resumeCursor,
            ...(state.compactedThrough ? { compactedThrough: state.compactedThrough } : {}),
          }
        : { outcome: "not-needed", resumeCursor: state.session.resumeCursor };
      return result;
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
      const turnId = yield* nextTurnId;
      yield* compactBeforeTurn(state, input.threadId, turnId, state.session.model, {
        role: "tool",
        content: input.content,
        tool_call_id: input.toolCallId,
      });
      state.messages.push({ role: "tool", content: input.content, tool_call_id: input.toolCallId });
      const interrupt = yield* Deferred.make<void>();
      state.interruptSignals.set(turnId, interrupt);
      yield* startTurn(state, {
        threadId: input.threadId,
        turnId,
        beforeMessages,
        beforeTurns,
        modelOptions: state.modelOptions,
      });
      return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
    });

  const adapter: OpenAICompatibleAdapter = {
    provider: options.provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      manualContextCompaction: "azure-summary",
    },
    startSession,
    sendTurn,
    compactContext,
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
