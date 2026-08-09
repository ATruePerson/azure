import { createFileRoute } from "@tanstack/react-router";
import { CodexCapabilitiesSettings } from "../components/settings/CodexCapabilitiesSettings";
export const Route = createFileRoute("/settings/capabilities")({
  component: CodexCapabilitiesSettings,
});
