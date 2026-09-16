import {
  NVIDIA_NIM_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_BASE_URL,
  type ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderAuth,
} from "@azure/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { createModelCapabilities, resolveModelContextWindow } from "@azure/shared/model";
import {
  OpenAICompatibleAuthError,
  OpenAICompatibleMalformedResponseError,
  OpenAICompatibleProviderError,
  OpenAICompatibleValidationError,
  makeOpenAICompatibleAdapter,
} from "../Layers/OpenAICompatibleRuntime.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderDriverError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOpenAICompatibleTextGeneration } from "../../textGeneration/OpenAICompatibleTextGeneration.ts";
import type * as SchemaType from "effect/Schema";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

type CompatibleSettings = {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly customModels: ReadonlyArray<string>;
};

export interface OpenAICompatibleDriverDefinition<Settings extends CompatibleSettings> {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly apiKeyEnvironmentVariable: string;
  readonly configSchema: SchemaType.Codec<Settings, unknown>;
  readonly defaultConfig: () => Settings;
  readonly headers?: Readonly<Record<string, string>>;
  readonly authPath?: string;
  readonly allowedBearerOrigins: ReadonlySet<string>;
  readonly disabledMessage?: string;
  readonly authenticatedMessage?: string;
}

export type OpenAICompatibleDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | HttpClient.HttpClient
  | ServerSettingsService;

const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

function hasAllowedBearerOrigin(baseUrl: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.origin !== "null" && allowedOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function stringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function modelCapabilities(
  driverKind: string,
  model: Readonly<{ readonly id: string; readonly [key: string]: unknown }>,
) {
  const discoveredContextWindow = positiveNumber(model.context_length);
  const contextWindowTokens = resolveModelContextWindow({
    provider: driverKind,
    model: model.id,
    ...(discoveredContextWindow !== undefined ? { discovered: discoveredContextWindow } : {}),
  });
  const advertisedTools =
    model.supports_function_calling ?? model.supports_tools ?? model.tool_calling;
  const functionToolSupport =
    advertisedTools === true
      ? ("verified" as const)
      : advertisedTools === false
        ? ("unsupported" as const)
        : ("unknown" as const);
  if (driverKind === "openrouter") {
    const reasoning = model.reasoning;
    const efforts =
      reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
        ? stringArray((reasoning as Record<string, unknown>).supported_efforts)
        : [];
    return createModelCapabilities({
      optionDescriptors:
        efforts.length > 0
          ? [
              {
                id: "reasoningEffort",
                label: "Thinking",
                description: "Reasoning effort supported by this model.",
                type: "select" as const,
                options: efforts.map((effort) => ({
                  id: effort,
                  label: effort.charAt(0).toUpperCase() + effort.slice(1),
                  ...(effort === (reasoning as Record<string, unknown>).default_effort
                    ? { isDefault: true }
                    : {}),
                })),
              },
            ]
          : [],
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
      functionToolSupport,
    });
  }
  if (driverKind === "nvidiaNim") {
    const normalizedId = model.id.toLowerCase();
    if (normalizedId === "nvidia/nemotron-3-ultra-550b-a55b") {
      return createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: [
              { id: "none", label: "None" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
            ],
          },
        ],
        contextWindowTokens: contextWindowTokens ?? 1_000_000,
        functionToolSupport: "verified",
      });
    }
    if (normalizedId === "moonshotai/kimi-k3") {
      return createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
              { id: "max", label: "Max", isDefault: true },
            ],
          },
        ],
        contextWindowTokens: contextWindowTokens ?? 1_048_576,
        functionToolSupport: "verified",
      });
    }
    if (normalizedId === "deepseek-ai/deepseek-v4-flash-0731") {
      return createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
        contextWindowTokens: contextWindowTokens ?? 1_000_000,
        functionToolSupport: "verified",
      });
    }
    if (normalizedId.includes("gpt-oss")) {
      return createModelCapabilities({
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Thinking",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
        ...(contextWindowTokens ? { contextWindowTokens } : {}),
        functionToolSupport,
      });
    }
    if (normalizedId === "stepfun-ai/step-3.7-flash") {
      return createModelCapabilities({
        optionDescriptors: [],
        contextWindowTokens: contextWindowTokens ?? 262_144,
        functionToolSupport,
      });
    }
  }
  return createModelCapabilities({
    optionDescriptors: [],
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    functionToolSupport,
  });
}

function modelsFromApi(
  driverKind: string,
  models: ReadonlyArray<{ readonly id: string; readonly [key: string]: unknown }>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const discovered = models.map((model) => ({
    slug: model.id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : model.id,
    isCustom: false,
    capabilities: modelCapabilities(driverKind, model),
  }));
  return providerModelsFromSettings(discovered, customModels, emptyCapabilities);
}

function initialSnapshot(
  definition: OpenAICompatibleDriverDefinition<CompatibleSettings>,
  settings: CompatibleSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings([], settings.customModels, emptyCapabilities);
    return buildServerProvider({
      presentation: { displayName: definition.displayName },
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unauthenticated", type: "apiKey" },
            message: `Set ${definition.apiKeyEnvironmentVariable} to connect ${definition.displayName}.`,
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message:
              definition.disabledMessage ??
              `${definition.displayName} is disabled in Azure settings.`,
          },
    });
  });
}

function classifyRuntimeError(error: unknown): "auth" | "provider" {
  return Schema.is(OpenAICompatibleAuthError)(error) ? "auth" : "provider";
}

function authFromCheck(kind: "authenticated" | "unauthenticated" | "unknown"): ServerProviderAuth {
  return { status: kind, type: "apiKey" };
}

export function makeOpenAICompatibleDriver<Settings extends CompatibleSettings>(
  definition: OpenAICompatibleDriverDefinition<Settings>,
): ProviderDriver<Settings, OpenAICompatibleDriverEnv> {
  const withIdentity =
    (input: {
      readonly instanceId: ProviderInstance["instanceId"];
      readonly displayName: string | undefined;
      readonly accentColor: string | undefined;
      readonly continuationGroupKey: string;
    }) =>
    (snapshot: ServerProviderDraft): ServerProvider => ({
      ...snapshot,
      instanceId: input.instanceId,
      driver: definition.driverKind,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: input.continuationGroupKey },
    });

  return {
    driverKind: definition.driverKind,
    metadata: { displayName: definition.displayName, supportsMultipleInstances: true },
    configSchema: definition.configSchema,
    defaultConfig: definition.defaultConfig,
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const serverSettings = yield* ServerSettingsService;
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const apiKey = processEnv[definition.apiKeyEnvironmentVariable]?.trim() ?? "";
        const effectiveConfig = { ...config, enabled } as Settings;
        const canAttachApiKey = hasAllowedBearerOrigin(
          effectiveConfig.baseUrl,
          definition.allowedBearerOrigins,
        );
        const effectiveApiKey = canAttachApiKey ? apiKey : "";
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: definition.driverKind,
          instanceId,
        });
        const stampIdentity = withIdentity({
          instanceId,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });
        const runtimeOptions = {
          provider: definition.driverKind,
          providerInstanceId: String(instanceId),
          baseUrl: effectiveConfig.baseUrl,
          apiKey: effectiveApiKey,
          allowEmptyApiKey: true,
          ...(definition.headers ? { headers: definition.headers } : {}),
        } as const;
        const rawAdapter = yield* makeOpenAICompatibleAdapter(runtimeOptions).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: definition.driverKind,
                instanceId,
                detail: `Failed to build ${definition.displayName} adapter: ${cause.message}`,
                cause,
              }),
          ),
        );
        const textGeneration = yield* makeOpenAICompatibleTextGeneration({
          baseUrl: effectiveConfig.baseUrl,
          apiKey: effectiveApiKey,
          ...(definition.headers ? { headers: definition.headers } : {}),
        });
        const toProviderAdapterError = (
          operation: string,
          cause: unknown,
        ): ProviderAdapterError => {
          if (Schema.is(ProviderAdapterSessionNotFoundError)(cause)) return cause;
          if (Schema.is(ProviderAdapterValidationError)(cause)) return cause;
          if (Schema.is(OpenAICompatibleValidationError)(cause)) {
            return new ProviderAdapterValidationError({
              provider: String(definition.driverKind),
              operation,
              issue: cause.detail,
            });
          }
          if (Schema.is(OpenAICompatibleAuthError)(cause)) {
            return new ProviderAdapterRequestError({
              provider: String(definition.driverKind),
              method: operation,
              detail: `Provider rejected credentials (HTTP ${cause.status}).`,
            });
          }
          if (Schema.is(OpenAICompatibleProviderError)(cause)) {
            return new ProviderAdapterRequestError({
              provider: String(definition.driverKind),
              method: operation,
              detail: `Provider request failed (HTTP ${cause.status}).`,
            });
          }
          if (Schema.is(OpenAICompatibleMalformedResponseError)(cause)) {
            return new ProviderAdapterRequestError({
              provider: String(definition.driverKind),
              method: operation,
              detail: "Provider returned a malformed response.",
            });
          }
          return new ProviderAdapterRequestError({
            provider: String(definition.driverKind),
            method: operation,
            detail: "OpenAI-compatible provider request failed.",
          });
        };
        const { compactContext: rawCompactContext, ...rawAdapterWithoutCompactContext } =
          rawAdapter;
        const wrappedCompactContext: ProviderAdapterShape<ProviderAdapterError>["compactContext"] =
          rawCompactContext === undefined
            ? undefined
            : (input) =>
                rawCompactContext(input).pipe(
                  Effect.mapError((cause) => toProviderAdapterError("compactContext", cause)),
                );
        const adapter: ProviderAdapterShape<ProviderAdapterError> = {
          ...rawAdapterWithoutCompactContext,
          startSession: (input) =>
            rawAdapter
              .startSession(input)
              .pipe(Effect.mapError((cause) => toProviderAdapterError("startSession", cause))),
          sendTurn: (input) =>
            rawAdapter
              .sendTurn(input)
              .pipe(Effect.mapError((cause) => toProviderAdapterError("sendTurn", cause))),
          ...(wrappedCompactContext !== undefined ? { compactContext: wrappedCompactContext } : {}),
          interruptTurn: (threadId, turnId) =>
            rawAdapter
              .interruptTurn(threadId, turnId)
              .pipe(Effect.mapError((cause) => toProviderAdapterError("interruptTurn", cause))),
          respondToRequest: (threadId, requestId, decision) =>
            rawAdapter
              .respondToRequest(threadId, requestId, decision)
              .pipe(Effect.mapError((cause) => toProviderAdapterError("respondToRequest", cause))),
          respondToUserInput: (threadId, requestId, answers) =>
            rawAdapter
              .respondToUserInput(threadId, requestId, answers)
              .pipe(
                Effect.mapError((cause) => toProviderAdapterError("respondToUserInput", cause)),
              ),
          stopSession: (threadId) =>
            rawAdapter
              .stopSession(threadId)
              .pipe(Effect.mapError((cause) => toProviderAdapterError("stopSession", cause))),
          readThread: (threadId) =>
            rawAdapter
              .readThread(threadId)
              .pipe(Effect.mapError((cause) => toProviderAdapterError("readThread", cause))),
          rollbackThread: (threadId, turns) =>
            rawAdapter
              .rollbackThread(threadId, turns)
              .pipe(Effect.mapError((cause) => toProviderAdapterError("rollbackThread", cause))),
          stopAll: () =>
            rawAdapter
              .stopAll()
              .pipe(Effect.mapError((cause) => toProviderAdapterError("stopAll", cause))),
        };

        const checkProvider = Effect.gen(function* () {
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const customModels = effectiveConfig.customModels ?? [];
          const fallback = providerModelsFromSettings([], customModels, emptyCapabilities);
          if (!effectiveConfig.enabled) {
            return buildServerProvider({
              presentation: { displayName: definition.displayName },
              enabled: false,
              checkedAt,
              models: fallback,
              probe: {
                installed: false,
                version: null,
                status: "warning",
                auth: { status: "unknown" },
                message:
                  definition.disabledMessage ??
                  `${definition.displayName} is disabled in Azure settings.`,
              },
            });
          }
          if (!apiKey) {
            return buildServerProvider({
              presentation: { displayName: definition.displayName },
              enabled: true,
              checkedAt,
              models: fallback,
              probe: {
                installed: true,
                version: null,
                status: "warning",
                auth: authFromCheck("unauthenticated"),
                message: `Set ${definition.apiKeyEnvironmentVariable} to connect ${definition.displayName}.`,
              },
            });
          }

          if (!canAttachApiKey) {
            return buildServerProvider({
              presentation: { displayName: definition.displayName },
              enabled: true,
              checkedAt,
              models: fallback,
              probe: {
                installed: true,
                version: null,
                status: "warning",
                auth: authFromCheck("unknown"),
                message: `API key withheld for non-official ${definition.displayName} HTTPS origin.`,
              },
            });
          }

          if (definition.authPath) {
            const authResult = yield* client
              .execute(
                HttpClientRequest.get(joinUrl(effectiveConfig.baseUrl, definition.authPath)).pipe(
                  HttpClientRequest.setHeaders({
                    ...definition.headers,
                    Authorization: `Bearer ${apiKey}`,
                    Accept: "application/json",
                  }),
                ),
              )
              .pipe(Effect.result);
            if (authResult._tag === "Failure") {
              return buildServerProvider({
                presentation: { displayName: definition.displayName },
                enabled: true,
                checkedAt,
                models: fallback,
                probe: {
                  installed: true,
                  version: null,
                  status: "error",
                  auth: authFromCheck("unknown"),
                  message: `Failed to check ${definition.displayName} authentication.`,
                },
              });
            }
            const authResponse = authResult.success;
            if (authResponse.status === 401 || authResponse.status === 403) {
              return buildServerProvider({
                presentation: { displayName: definition.displayName },
                enabled: true,
                checkedAt,
                models: fallback,
                probe: {
                  installed: true,
                  version: null,
                  status: "warning",
                  auth: authFromCheck("unauthenticated"),
                  message: `${definition.displayName} rejected the API key.`,
                },
              });
            }
            if (authResponse.status < 200 || authResponse.status >= 300) {
              return buildServerProvider({
                presentation: { displayName: definition.displayName },
                enabled: true,
                checkedAt,
                models: fallback,
                probe: {
                  installed: true,
                  version: null,
                  status: "error",
                  auth: authFromCheck("unknown"),
                  message: `${definition.displayName} authentication check failed (HTTP ${authResponse.status}).`,
                },
              });
            }
          }

          const discovered = yield* rawAdapter.listModels().pipe(Effect.result);
          if (discovered._tag === "Failure") {
            const auth = classifyRuntimeError(discovered.failure);
            return buildServerProvider({
              presentation: { displayName: definition.displayName },
              enabled: true,
              checkedAt,
              models: fallback,
              probe: {
                installed: true,
                version: null,
                status: auth === "auth" ? "warning" : "error",
                auth: authFromCheck(auth === "auth" ? "unauthenticated" : "unknown"),
                message:
                  auth === "auth"
                    ? `${definition.displayName} rejected the API key.`
                    : `Failed to discover ${definition.displayName} models.`,
              },
            });
          }
          return buildServerProvider({
            presentation: { displayName: definition.displayName },
            enabled: true,
            checkedAt,
            models: modelsFromApi(String(definition.driverKind), discovered.success, customModels),
            probe: {
              installed: true,
              version: null,
              status: "ready",
              auth: authFromCheck("authenticated"),
              ...(definition.authenticatedMessage
                ? { message: definition.authenticatedMessage }
                : {}),
            },
          });
        }).pipe(Effect.map(stampIdentity));

        const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
          provider: definition.driverKind,
          packageName: null,
        });
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<Settings>>({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            initialSnapshot(definition, settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
        });

        return {
          instanceId,
          driverKind: definition.driverKind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: definition.driverKind,
              instanceId,
              detail: `Failed to build ${definition.displayName} provider: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      ),
  };
}
