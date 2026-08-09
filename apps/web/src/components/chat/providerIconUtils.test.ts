import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";

describe("first-party provider icons", () => {
  it.each(["nvidiaNim", "openrouter"] as const)("maps %s to an icon", (driver) => {
    expect(PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(driver)]).toBeDefined();
  });
});
