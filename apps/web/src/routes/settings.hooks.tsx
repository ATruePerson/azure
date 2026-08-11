import { createFileRoute } from "@tanstack/react-router";

import { CodexCapabilitiesSettings } from "../components/settings/CodexCapabilitiesSettings";

function SettingsHooksRoute() {
  return <CodexCapabilitiesSettings category="hooks" />;
}

export const Route = createFileRoute("/settings/hooks")({
  component: SettingsHooksRoute,
});
