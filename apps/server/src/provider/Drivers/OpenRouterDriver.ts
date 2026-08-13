import {
  OPENROUTER_DEFAULT_BASE_URL,
  OpenRouterSettings,
  ProviderDriverKind,
  type OpenRouterSettings as OpenRouterSettingsType,
} from "@azure/contracts";
import * as Schema from "effect/Schema";
import { makeOpenAICompatibleDriver } from "./OpenAICompatibleDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("openrouter");

export const OpenRouterDriver = makeOpenAICompatibleDriver<OpenRouterSettingsType>({
  driverKind: DRIVER_KIND,
  displayName: "OpenRouter",
  apiKeyEnvironmentVariable: "OPENROUTER_API_KEY",
  configSchema: OpenRouterSettings,
  defaultConfig: () =>
    Schema.decodeSync(OpenRouterSettings)({
      baseUrl: OPENROUTER_DEFAULT_BASE_URL,
    }),
  authPath: "/key",
  headers: { "X-OpenRouter-Title": "Azure Code" },
  allowedBearerOrigins: new Set([new URL(OPENROUTER_DEFAULT_BASE_URL).origin]),
});

export { DRIVER_KIND as OPENROUTER_DRIVER_KIND };
