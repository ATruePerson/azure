import { CodexSettings, type ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeCodexAdapter } from "../Layers/CodexAdapter.ts";
import { checkCodexProviderStatus, makePendingCodexProvider } from "../Layers/CodexProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { markFirstModelDefault } from "./ChatGptWebModels.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

export type CodexCliDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export interface CodexCliDriverOptions {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly modelFilter?: (
    models: ReadonlyArray<ServerProvider["models"][number]>,
  ) => ReadonlyArray<ServerProvider["models"][number]>;
  readonly noModelsMessage?: string;
  readonly ensureFirstModelDefault?: boolean;
  readonly manualMaintenance?: boolean;
}

export function stampCodexCliSnapshot(
  options: CodexCliDriverOptions,
  input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  },
  snapshot: ServerProviderDraft,
): ServerProvider {
  const models = options.modelFilter?.(snapshot.models) ?? snapshot.models;
  const noModels = options.noModelsMessage !== undefined && snapshot.enabled && models.length === 0;
  const normalizedModels =
    options.ensureFirstModelDefault && !noModels ? markFirstModelDefault(models) : models;

  return {
    ...snapshot,
    instanceId: input.instanceId,
    driver: options.driverKind,
    displayName: input.displayName ?? options.displayName,
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
    models: normalizedModels,
    ...(noModels
      ? {
          status: "error" as const,
          message: options.noModelsMessage,
        }
      : {}),
  };
}

export function makeCodexCliDriver(
  options: CodexCliDriverOptions,
): ProviderDriver<CodexSettings, CodexCliDriverEnv> {
  const update = makePackageManagedProviderMaintenanceResolver({
    provider: options.driverKind,
    npmPackageName: "@openai/codex",
    homebrewFormula: "codex",
    nativeUpdate: null,
  });

  return {
    driverKind: options.driverKind,
    metadata: {
      displayName: options.displayName,
      supportsMultipleInstances: true,
    },
    configSchema: CodexSettings,
    defaultConfig: (): CodexSettings => decodeCodexSettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const httpClient = yield* HttpClient.HttpClient;
        const serverSettings = yield* ServerSettingsService;
        const eventLoggers = yield* ProviderEventLoggers;
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const homeLayout = yield* resolveCodexHomeLayout(config);
        const continuationIdentity = codexContinuationIdentity(homeLayout, options.driverKind);
        const stamp = (snapshot: ServerProviderDraft): ServerProvider =>
          stampCodexCliSnapshot(
            options,
            {
              instanceId,
              displayName,
              accentColor,
              continuationGroupKey: continuationIdentity.continuationKey,
            },
            snapshot,
          );

        yield* materializeCodexShadowHome(homeLayout).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: options.driverKind,
                instanceId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const effectiveConfig = {
          ...config,
          enabled,
          homePath: homeLayout.effectiveHomePath ?? "",
        } satisfies CodexSettings;
        const maintenanceCapabilities = options.manualMaintenance
          ? makeManualOnlyProviderMaintenanceCapabilities({
              provider: options.driverKind,
              packageName: null,
            })
          : yield* resolveProviderMaintenanceCapabilitiesEffect(update, {
              binaryPath: effectiveConfig.binaryPath,
              env: processEnv,
            });
        const adapter = yield* makeCodexAdapter(effectiveConfig, {
          provider: options.driverKind,
          instanceId,
          environment: processEnv,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        });
        const textGeneration = yield* makeCodexTextGeneration(effectiveConfig, processEnv);
        const checkProvider = checkCodexProviderStatus(effectiveConfig, undefined, processEnv).pipe(
          Effect.map(stamp),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            makePendingCodexProvider(settings.provider).pipe(Effect.map(stamp)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot: current, publishSnapshot }) =>
            enrichProviderSnapshotWithVersionAdvisory(current, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
            ),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: options.driverKind,
                instanceId,
                detail: `Failed to build ${options.displayName} snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );

        return {
          instanceId,
          driverKind: options.driverKind,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
}
