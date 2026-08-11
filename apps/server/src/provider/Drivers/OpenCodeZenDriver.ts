import {
  OPENCODE_ZEN_DEFAULT_BASE_URL,
  OpenCodeZenSettings,
  ProviderDriverKind,
  type OpenCodeZenSettings as OpenCodeZenSettingsType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeOpenAICompatibleDriver } from "./OpenAICompatibleDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("opencodeZen");

export const OpenCodeZenDriver = makeOpenAICompatibleDriver<OpenCodeZenSettingsType>({
  driverKind: DRIVER_KIND,
  displayName: "OpenCode Zen",
  apiKeyEnvironmentVariable: "OPENCODE_ZEN_API_KEY",
  configSchema: OpenCodeZenSettings,
  defaultConfig: () =>
    Schema.decodeSync(OpenCodeZenSettings)({
      baseUrl: OPENCODE_ZEN_DEFAULT_BASE_URL,
    }),
  allowedBearerOrigins: new Set([new URL(OPENCODE_ZEN_DEFAULT_BASE_URL).origin]),
});

export { DRIVER_KIND as OPENCODE_ZEN_DRIVER_KIND };
