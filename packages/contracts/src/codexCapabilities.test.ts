import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AzureSkillEnabledInput,
  CodexCapabilitiesError,
  CodexConfigEnabledInput,
} from "./codexCapabilities.ts";

const decode = Schema.decodeUnknownSync(CodexConfigEnabledInput);
const decodeAzureSkill = Schema.decodeUnknownSync(AzureSkillEnabledInput);

it("accepts safe Codex config ids and rejects dotted key-path injection", () => {
  expect(
    decode({ instanceId: "codex", kind: "plugin", id: "github@openai-curated", enabled: false }),
  ).toEqual({
    instanceId: "codex",
    kind: "plugin",
    id: "github@openai-curated",
    enabled: false,
  });
  expect(() =>
    decode({ instanceId: "codex", kind: "mcp", id: "safe.enabled", enabled: false }),
  ).toThrow();
});

it("returns actionable, cause-free capability errors", () => {
  expect(new CodexCapabilitiesError({ category: "configuration" }).message).toBe(
    "Azure integration settings need attention.",
  );
  expect(new CodexCapabilitiesError({ category: "unavailable" }).message).toBe(
    "Azure could not start the local integration. Check Azure settings and try again.",
  );
});

it("accepts safe Azure skill ids and rejects path traversal", () => {
  expect(decodeAzureSkill({ id: "fiction-writer", enabled: false })).toEqual({
    id: "fiction-writer",
    enabled: false,
  });
  expect(() => decodeAzureSkill({ id: "../outside", enabled: false })).toThrow();
});
