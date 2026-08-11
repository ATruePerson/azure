import { createFileRoute } from "@tanstack/react-router";

import { CodexCapabilitiesSettings } from "../components/settings/CodexCapabilitiesSettings";

function SettingsPluginsRoute() {
  return <CodexCapabilitiesSettings category="plugins" />;
}

export const Route = createFileRoute("/settings/plugins")({
  component: SettingsPluginsRoute,
});
