import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

export const CodexCapabilityItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  canToggle: Schema.Boolean,
});
export type CodexCapabilityItem = typeof CodexCapabilityItem.Type;

export const CodexCapabilities = Schema.Struct({
  hooks: Schema.Array(CodexCapabilityItem),
  plugins: Schema.Array(CodexCapabilityItem),
  skills: Schema.Array(CodexCapabilityItem),
  mcpServers: Schema.Array(CodexCapabilityItem),
});
export type CodexCapabilities = typeof CodexCapabilities.Type;

export const CodexCapabilitiesInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type CodexCapabilitiesInput = typeof CodexCapabilitiesInput.Type;

export const CodexSkillEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  path: Schema.String,
  enabled: Schema.Boolean,
});
export type CodexSkillEnabledInput = typeof CodexSkillEnabledInput.Type;

export const CodexConfigEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  kind: Schema.Literals(["plugin", "mcp"]),
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_@-]+$/)),
  enabled: Schema.Boolean,
});
export type CodexConfigEnabledInput = typeof CodexConfigEnabledInput.Type;

export class CodexCapabilitiesError extends Schema.TaggedErrorClass<CodexCapabilitiesError>()(
  "CodexCapabilitiesError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Codex capabilities could not be loaded or updated.";
  }
}
