import { CodexSettings, ProviderDriverKind } from "@azure/contracts";

import { makeCodexCliDriver, type CodexCliDriverEnv } from "./CodexCliDriver.ts";
import { nativeCodexModels } from "./ChatGptWebModels.ts";

const DRIVER_KIND = ProviderDriverKind.make("codex");

export type CodexDriverEnv = CodexCliDriverEnv;

export const CodexDriver = makeCodexCliDriver({
  driverKind: DRIVER_KIND,
  displayName: "Codex",
  modelFilter: nativeCodexModels,
});
