import * as Schema from "effect/Schema";

import { AzureCapabilityIcon } from "./assets.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CapabilityControl = Schema.Union([
  Schema.TaggedStruct("azure-skill", {}),
  Schema.TaggedStruct("azure-capability", {
    kind: Schema.Literals(["hooks", "plugins", "skills", "mcp"]),
  }),
  Schema.TaggedStruct("plugin", { pluginId: Schema.String }),
  Schema.TaggedStruct("unsupported", { reason: Schema.String }),
]);
export type CapabilityControl = typeof CapabilityControl.Type;

export const CodexCapabilityItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  iconUrl: Schema.optional(Schema.String),
  brandColor: Schema.optional(Schema.String),
  icon: Schema.optional(AzureCapabilityIcon),
  control: Schema.optional(CapabilityControl),
  enabled: Schema.optional(Schema.Boolean),
  effectiveEnabled: Schema.optional(Schema.Boolean),
  restartRequired: Schema.optional(Schema.Boolean),
  controlledBy: Schema.optional(
    Schema.Struct({
      kind: Schema.Literals(["hooks", "plugins", "skills", "mcp"]),
      id: Schema.String,
    }),
  ),
  canToggle: Schema.Boolean,
});
export type CodexCapabilityItem = typeof CodexCapabilityItem.Type;

export const CodexCapabilities = Schema.Struct({
  homeStatus: Schema.optional(Schema.Literals(["available", "missing", "unavailable"])),
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

export const AzureSkillEnabledInput = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  enabled: Schema.Boolean,
});
export type AzureSkillEnabledInput = typeof AzureSkillEnabledInput.Type;

export const AzureCapabilityKind = Schema.Literals(["hooks", "plugins", "skills", "mcp"]);
export type AzureCapabilityKind = typeof AzureCapabilityKind.Type;

export const AzureCapabilityEnabledInput = Schema.Struct({
  kind: AzureCapabilityKind,
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)),
  enabled: Schema.Boolean,
});
export type AzureCapabilityEnabledInput = typeof AzureCapabilityEnabledInput.Type;

export const CodexConfigEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  kind: Schema.Literals(["plugin", "mcp"]),
  id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_@-]+$/)),
  enabled: Schema.Boolean,
});
export type CodexConfigEnabledInput = typeof CodexConfigEnabledInput.Type;

export class CodexCapabilitiesError extends Schema.TaggedErrorClass<CodexCapabilitiesError>()(
  "CodexCapabilitiesError",
  { category: Schema.Literals(["configuration", "unavailable", "requestFailed"]) },
) {
  override get message(): string {
    switch (this.category) {
      case "configuration":
        return "Azure integration settings need attention.";
      case "unavailable":
        return "Azure could not start the local integration. Check Azure settings and try again.";
      case "requestFailed":
        return "Azure could not load or update this integration. Try again.";
    }
  }
}
