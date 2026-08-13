import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@azure/contracts";

import {
  deriveProviderModelsForDisplay,
  hasStoredProviderApiKey,
  updateProviderApiKeyEnvironment,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("provider API key persistence helpers", () => {
  it("writes a sensitive key as an environment patch without exposing a redacted value", () => {
    const next = updateProviderApiKeyEnvironment(
      [{ name: "BASE_URL", value: "https://example.test", sensitive: false }],
      "OPENROUTER_API_KEY",
      "sk-or-secret",
    );

    expect(next).toEqual([
      { name: "BASE_URL", value: "https://example.test", sensitive: false },
      { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
    ]);
    expect(hasStoredProviderApiKey(next, "OPENROUTER_API_KEY")).toBe(true);
    expect(next.find((variable) => variable.name === "OPENROUTER_API_KEY")?.sensitive).toBe(true);
  });

  it("removes the key from the persistence patch", () => {
    const next = updateProviderApiKeyEnvironment(
      [{ name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true }],
      "OPENROUTER_API_KEY",
      "",
    );

    expect(next).toEqual([]);
    expect(hasStoredProviderApiKey(next, "OPENROUTER_API_KEY")).toBe(false);
  });
});
