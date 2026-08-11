import { createFileRoute } from "@tanstack/react-router";

import { CodexCapabilitiesSettings } from "../components/settings/CodexCapabilitiesSettings";

function SettingsMcpRoute() {
  return <CodexCapabilitiesSettings category="mcp" />;
}

export const Route = createFileRoute("/settings/mcp")({
  component: SettingsMcpRoute,
});
