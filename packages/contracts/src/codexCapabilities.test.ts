import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CodexConfigEnabledInput } from "./codexCapabilities.ts";

const decode = Schema.decodeUnknownSync(CodexConfigEnabledInput);

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
