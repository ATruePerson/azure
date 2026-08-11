import { createFileRoute } from "@tanstack/react-router";

import { CodexCapabilitiesSettings } from "../components/settings/CodexCapabilitiesSettings";

function SettingsSkillsRoute() {
  return <CodexCapabilitiesSettings category="skills" />;
}

export const Route = createFileRoute("/settings/skills")({
  component: SettingsSkillsRoute,
});
