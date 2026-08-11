import {
  NVIDIA_NIM_DEFAULT_BASE_URL,
  NvidiaNimSettings,
  ProviderDriverKind,
  type NvidiaNimSettings as NvidiaNimSettingsType,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeOpenAICompatibleDriver } from "./OpenAICompatibleDriver.ts";

const DRIVER_KIND = ProviderDriverKind.make("nvidiaNim");

export const NvidiaNimDriver = makeOpenAICompatibleDriver<NvidiaNimSettingsType>({
  driverKind: DRIVER_KIND,
  displayName: "NVIDIA",
  apiKeyEnvironmentVariable: "NVIDIA_API_KEY",
  configSchema: NvidiaNimSettings,
  defaultConfig: () =>
    Schema.decodeSync(NvidiaNimSettings)({
      baseUrl: NVIDIA_NIM_DEFAULT_BASE_URL,
    }),
  allowedBearerOrigins: new Set([new URL(NVIDIA_NIM_DEFAULT_BASE_URL).origin]),
  disabledMessage: "NVIDIA is disabled in Azure settings.",
  authenticatedMessage: "NVIDIA authenticated via API key.",
});

export { DRIVER_KIND as NVIDIA_NIM_DRIVER_KIND };
