import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId } from "@azure/contracts";
import * as Effect from "effect/Effect";
import * as CodexClient from "effect-codex-app-server/client";

import {
  applyPreferredCodexDefaultModel,
  codexCapabilityFailureCategory,
  isLegacyCodexModel,
  mapCodexModelCapabilities,
  requestCodexCapabilities,
  resolveCodexCapabilitiesTarget,
  setCodexConfigEnabledWithClient,
  setCodexSkillEnabledWithClient,
} from "./CodexProvider.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

interface CapabilityRequest {
  readonly method: string;
  readonly payload: unknown;
}

it("classifies capability failures without exposing their detail", () => {
  assert.equal(codexCapabilityFailureCategory(new Error("secret value")), "requestFailed");
});

function makeCapabilityClient(calls: Array<CapabilityRequest>) {
  const responses: Readonly<Record<string, unknown>> = {
    "config/read": {
      config: {
        mcp_servers: {
          disabled: { enabled: false },
          enabled: { enabled: true },
        },
      },
      origins: {},
    },
    "hooks/list": {
      data: [
        {
          hooks: [
            {
              key: "stop-hook",
              eventName: "stop",
              handlerType: "command",
              source: "user",
              enabled: true,
            },
          ],
        },
      ],
    },
    "plugin/installed": {
      marketplaces: [
        {
          name: "curated",
          plugins: [
            {
              id: "github@openai-curated",
              name: "GitHub",
              enabled: true,
              installed: true,
            },
          ],
        },
      ],
    },
    "skills/list": {
      data: [
        {
          skills: [
            {
              path: "/skills/test/SKILL.md",
              name: "test-skill",
              scope: "user",
              enabled: true,
            },
          ],
        },
      ],
    },
    "mcpServerStatus/list": {
      data: [
        { name: "enabled", authStatus: "notLoggedIn", serverInfo: { name: "Enabled MCP" } },
        { name: "managed", authStatus: "notLoggedIn", serverInfo: { name: "Managed MCP" } },
      ],
    },
  };

  return {
    request: (method: string, payload: unknown) => {
      calls.push({ method, payload });
      return Effect.succeed(responses[method] ?? {});
    },
  } as unknown as CodexClient.CodexAppServerClient["Service"];
}

it("keeps only the GPT-5.6 Codex family out of legacy models", () => {
  assert.deepStrictEqual(
    ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.4"].map((model) => [
      model,
      isLegacyCodexModel(model),
    ]),
    [
      ["gpt-5.6-luna", false],
      ["gpt-5.6-terra", false],
      ["gpt-5.6-sol", false],
      ["gpt-5.4", true],
    ],
  );
});

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it.layer(NodeServices.layer)("Codex capability controls", (it) => {
  it.effect("hydrates the ChatGPT Web legacy provider with its own driver identity", () =>
    Effect.gen(function* () {
      const chatGptWeb = ProviderDriverKind.make("chatgptWeb");
      const instanceId = ProviderInstanceId.make("chatgptWeb");
      const instances = deriveProviderInstanceConfigMap({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          chatgptWeb: { ...DEFAULT_SERVER_SETTINGS.providers.chatgptWeb, homePath: "~/.codex-web" },
        },
      });

      assert.deepStrictEqual(instances[instanceId]?.driver, chatGptWeb);
      assert.deepStrictEqual(instances[instanceId]?.config, {
        ...DEFAULT_SERVER_SETTINGS.providers.chatgptWeb,
        homePath: "~/.codex-web",
      });
    }),
  );

  it.effect("uses the selected instance's shadow home and environment", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      const instances = deriveProviderInstanceConfigMap({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [{ name: "CODEX_CAPABILITY_TEST", value: "work", sensitive: false }],
            config: {
              homePath: "/shared-codex-home",
              shadowHomePath: "/shadow-codex-home",
            },
          },
        },
      });
      const target = yield* resolveCodexCapabilitiesTarget(instances[instanceId]);

      assert.strictEqual(target.settings.homePath, "/shadow-codex-home");
      assert.strictEqual(target.environment.CODEX_CAPABILITY_TEST, "work");
    }),
  );

  it.effect("loads all inventories and writes each supported individual control", () =>
    Effect.gen(function* () {
      const calls: Array<CapabilityRequest> = [];
      const client = makeCapabilityClient(calls);
      const capabilities = yield* requestCodexCapabilities(client, "/workspace");

      assert.deepStrictEqual(
        capabilities.mcpServers.map(({ id, enabled, canToggle }) => ({ id, enabled, canToggle })),
        [
          { id: "disabled", enabled: false, canToggle: true },
          { id: "enabled", enabled: true, canToggle: true },
          { id: "managed", enabled: true, canToggle: false },
        ],
      );
      assert.strictEqual(capabilities.hooks[0]?.canToggle, false);
      assert.deepStrictEqual(calls.find((call) => call.method === "config/read")?.payload, {
        includeLayers: false,
      });

      yield* setCodexSkillEnabledWithClient(client, "/workspace", {
        path: "/skills/test/SKILL.md",
        enabled: false,
      });
      yield* setCodexConfigEnabledWithClient(client, "/workspace", {
        kind: "plugin",
        id: "github@openai-curated",
        enabled: false,
      });
      yield* setCodexConfigEnabledWithClient(client, "/workspace", {
        kind: "mcp",
        id: "enabled",
        enabled: false,
      });

      assert.deepStrictEqual(
        calls.filter((call) =>
          ["skills/config/write", "config/value/write", "config/mcpServer/reload"].includes(
            call.method,
          ),
        ),
        [
          {
            method: "skills/config/write",
            payload: { path: "/skills/test/SKILL.md", enabled: false },
          },
          {
            method: "config/value/write",
            payload: {
              keyPath: "plugins.github@openai-curated.enabled",
              mergeStrategy: "replace",
              value: false,
            },
          },
          {
            method: "config/value/write",
            payload: {
              keyPath: "mcp_servers.enabled.enabled",
              mergeStrategy: "replace",
              value: false,
            },
          },
          { method: "config/mcpServer/reload", payload: undefined },
        ],
      );
    }),
  );
});
