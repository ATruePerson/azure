import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@azure/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { NvidiaNimDriver } from "./NvidiaNimDriver.ts";
import { OpenCodeZenDriver } from "./OpenCodeZenDriver.ts";
import { OpenRouterDriver } from "./OpenRouterDriver.ts";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(
  handler: (request: Request) => Response,
  requests: Request[],
): HttpClient.HttpClient {
  return HttpClient.make((request) =>
    HttpClientRequest.toWeb(request).pipe(
      Effect.mapError(
        (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause }),
          }),
      ),
      Effect.map((webRequest) => {
        requests.push(webRequest);
        return HttpClientResponse.fromWeb(request, handler(webRequest));
      }),
    ),
  );
}

const backgroundPolicy: BackgroundPolicy.BackgroundPolicy["Service"] = {
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({} as never),
  streamChanges: Stream.empty,
  subscribe: Effect.succeed({ latest: {} as never, changes: Stream.empty }),
  hasDemand: () => Effect.succeed(false),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(false),
};

function makeInstance(
  driver: typeof NvidiaNimDriver | typeof OpenCodeZenDriver | typeof OpenRouterDriver,
  environment: ReadonlyArray<{ name: string; value: string }>,
  client: HttpClient.HttpClient,
  config: Record<string, unknown> = {},
  enabled = true,
) {
  return driver
    .create({
      instanceId: ProviderInstanceId.make(driver.driverKind),
      displayName: undefined,
      environment: environment.map((entry) => ({ ...entry, sensitive: true })),
      enabled,
      config: { ...driver.defaultConfig(), ...config },
    })
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          ServerSettingsService.layerTest(),
          Layer.succeed(BackgroundPolicy.BackgroundPolicy, backgroundPolicy),
        ),
      ),
      Effect.scoped,
    );
}

describe("OpenAI-compatible drivers", () => {
  it("registers first-class API-key driver ids", () => {
    assert.deepStrictEqual(
      BUILT_IN_DRIVERS.map((driver) => String(driver.driverKind)).filter((kind) =>
        ["nvidiaNim", "openrouter", "opencodeZen"].includes(kind),
      ),
      ["nvidiaNim", "openrouter", "opencodeZen"],
    );
  });

  it.effect("discovers NVIDIA models and reports 401 without exposing the key", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const instance = yield* makeInstance(
        NvidiaNimDriver,
        [{ name: "NVIDIA_API_KEY", value: "nvidia-secret" }],
        clientFor(
          (request) =>
            json({
              data: [{ id: "nvidia/model-a" }, { id: "nvidia/nemotron-3-ultra-550b-a55b" }],
            }),
          requests,
        ),
      );
      const healthy = yield* instance.snapshot.refresh;
      assert.equal(healthy.auth.status, "authenticated");
      assert.equal(healthy.message, "NVIDIA authenticated via API key.");
      assert.equal(healthy.models[0]?.slug, "nvidia/model-a");
      assert.equal(healthy.models[1]?.capabilities?.contextWindowTokens, 1_000_000);
      const nvidiaReasoning = healthy.models[1]?.capabilities?.optionDescriptors?.[0];
      assert.equal(nvidiaReasoning?.type, "select");
      if (nvidiaReasoning?.type === "select") {
        assert.deepStrictEqual(nvidiaReasoning.options, [
          { id: "none", label: "None" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ]);
      }
      assert.equal(requests[0]?.url, "https://integrate.api.nvidia.com/v1/models");

      const unauthorized = yield* makeInstance(
        NvidiaNimDriver,
        [{ name: "NVIDIA_API_KEY", value: "nvidia-secret" }],
        clientFor(() => json({ error: "nvidia-secret must not escape" }, 401), []),
      ).pipe(Effect.flatMap((created) => created.snapshot.refresh));
      assert.equal(unauthorized.auth.status, "unauthenticated");
      assert.notInclude(String(unauthorized), "nvidia-secret");
    }),
  );

  it.effect("keeps OpenCode Zen credentials separate from the local OpenCode driver", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const instance = yield* makeInstance(
        OpenCodeZenDriver,
        [{ name: "OPENCODE_ZEN_API_KEY", value: "zen-secret" }],
        clientFor((request) => json({ data: [{ id: "zen/model-a" }] }), requests),
      );
      const healthy = yield* instance.snapshot.refresh;
      assert.equal(healthy.auth.status, "authenticated");
      assert.equal(healthy.models[0]?.slug, "zen/model-a");
      assert.equal(requests[0]?.url, "https://opencode.ai/zen/v1/models");
      assert.notInclude(String(healthy), "zen-secret");

      const disabled = yield* makeInstance(
        NvidiaNimDriver,
        [],
        clientFor(() => json({}), []),
        {},
        false,
      ).pipe(Effect.flatMap((created) => created.snapshot.refresh));
      assert.equal(disabled.message, "NVIDIA is disabled in Azure settings.");
    }),
  );

  it.effect("checks OpenRouter auth, sends required headers, and omits Referer", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const instance = yield* makeInstance(
        OpenRouterDriver,
        [{ name: "OPENROUTER_API_KEY", value: "router-secret" }],
        clientFor(
          (request) =>
            request.url.endsWith("/key")
              ? json({ data: { label: "Azure Code" } })
              : json({
                  data: [
                    {
                      id: "openai/model-a",
                      name: "Model A",
                      context_length: 262_144,
                      reasoning: {
                        supported_efforts: ["low", "high"],
                        default_effort: "high",
                      },
                    },
                  ],
                }),
          requests,
        ),
      );
      const snapshot = yield* instance.snapshot.refresh;
      assert.equal(snapshot.auth.status, "authenticated");
      assert.equal(snapshot.models[0]?.slug, "openai/model-a");
      assert.equal(snapshot.models[0]?.capabilities?.contextWindowTokens, 262_144);
      const routerThinking = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
      assert.equal(routerThinking?.type, "select");
      if (routerThinking?.type === "select") {
        assert.deepStrictEqual(routerThinking.options, [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]);
      }
      assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/key");
      assert.equal(requests[0]?.headers.get("X-OpenRouter-Title"), "Azure Code");
      assert.isNull(requests[0]?.headers.get("Referer"));
      assert.notInclude(String(snapshot), "router-secret");
    }),
  );

  it.effect("withholds stored keys from non-official HTTPS origins", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const instance = yield* makeInstance(
        OpenRouterDriver,
        [{ name: "OPENROUTER_API_KEY", value: "router-secret" }],
        clientFor(() => json({ data: [{ id: "should-not-be-requested" }] }), requests),
        { baseUrl: "https://attacker.example/v1" },
      );
      const snapshot = yield* instance.snapshot.refresh;
      assert.equal(snapshot.auth.status, "unknown");
      assert.include(snapshot.message ?? "", "withheld");
      assert.equal(requests.length, 0);
      assert.notInclude(String(snapshot), "router-secret");
    }),
  );
});
