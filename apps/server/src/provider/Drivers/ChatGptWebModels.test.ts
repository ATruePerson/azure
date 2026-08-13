import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

import { chatGptWebModels, markFirstModelDefault, nativeCodexModels } from "./ChatGptWebModels.ts";
import { stampCodexCliSnapshot } from "./CodexCliDriver.ts";

const model = (slug: string, extra: Partial<ServerProviderModel> = {}): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: null,
  ...extra,
});

it("keeps native and ChatGPT Web catalogs disjoint", () => {
  const models = [model("gpt-5.6-sol"), model("chatgpt-web/gpt-5"), model("chatgpt-web/reasoning")];

  assert.deepStrictEqual(
    nativeCodexModels(models).map(({ slug }) => slug),
    ["gpt-5.6-sol"],
  );
  assert.deepStrictEqual(
    chatGptWebModels(models).map(({ slug }) => slug),
    ["chatgpt-web/gpt-5", "chatgpt-web/reasoning"],
  );
});

it("preserves capabilities and supplies a default only when needed", () => {
  const capable = model("chatgpt-web/gpt-5", {
    capabilities: { functionToolSupport: "verified" },
  });
  const defaulted = markFirstModelDefault([capable, model("chatgpt-web/other")]);

  assert.deepStrictEqual(defaulted[0]?.capabilities, capable.capabilities);
  assert.equal(defaulted[0]?.isDefault, true);
  assert.equal(
    markFirstModelDefault([model("chatgpt-web/gpt-5", { isDefault: true })])[0]?.isDefault,
    true,
  );
});

it("turns an empty Web catalog into an actionable setup error", () => {
  const snapshot = stampCodexCliSnapshot(
    {
      driverKind: ProviderDriverKind.make("chatgptWeb"),
      displayName: "ChatGPT Web",
      modelFilter: chatGptWebModels,
      noModelsMessage: "Install ChatGPT Web models and refresh provider status.",
      ensureFirstModelDefault: true,
    },
    {
      instanceId: ProviderInstanceId.make("chatgptWeb"),
      displayName: undefined,
      accentColor: undefined,
      continuationGroupKey: "chatgptWeb:home:/tmp/codex",
    },
    {
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [model("gpt-5.6-sol")],
      skills: [],
      slashCommands: [],
    } satisfies ServerProviderDraft,
  );

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.message, "Install ChatGPT Web models and refresh provider status.");
  assert.deepStrictEqual(snapshot.models, []);
});
