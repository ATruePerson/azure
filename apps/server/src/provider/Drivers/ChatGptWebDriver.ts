import { ProviderDriverKind } from "@azure/contracts";

import { makeCodexCliDriver, type CodexCliDriverEnv } from "./CodexCliDriver.ts";
import { chatGptWebModels } from "./ChatGptWebModels.ts";

const DRIVER_KIND = ProviderDriverKind.make("chatgptWeb");

export type ChatGptWebDriverEnv = CodexCliDriverEnv;

export const ChatGptWebDriver = makeCodexCliDriver({
  driverKind: DRIVER_KIND,
  displayName: "ChatGPT Web",
  modelFilter: chatGptWebModels,
  noModelsMessage:
    "ChatGPT Web models are unavailable. Start the codex-chatgpt-web launcher, install its models, and refresh provider status.",
  ensureFirstModelDefault: true,
  manualMaintenance: true,
});

export { DRIVER_KIND as CHATGPT_WEB_DRIVER_KIND };
