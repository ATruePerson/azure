import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { CodexCapabilityItem } from "@t3tools/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function CapabilityRows({
  items,
  readOnly,
  updating,
  onChange,
}: {
  readonly items: ReadonlyArray<CodexCapabilityItem>;
  readonly readOnly?: string;
  readonly updating: string | null;
  readonly onChange?: (item: CodexCapabilityItem, enabled: boolean) => void;
}) {
  if (items.length === 0) {
    return <p className="px-3 text-sm text-muted-foreground">None found.</p>;
  }
  return items.map((item) => {
    const updateKey = `${item.id}:${item.label}`;
    const canToggle = readOnly === undefined && item.canToggle && onChange !== undefined;
    const description =
      readOnly ??
      (item.canToggle
        ? item.detail
        : `${item.detail ? `${item.detail}. ` : ""}Managed by its source and cannot be toggled here.`);
    return (
      <SettingsRow key={updateKey} title={item.label} description={description}>
        <Switch
          checked={item.enabled ?? false}
          disabled={!canToggle || updating !== null}
          aria-label={`${item.label} enabled`}
          aria-busy={updating === updateKey}
          onCheckedChange={(enabled) => onChange?.(item, enabled)}
        />
      </SettingsRow>
    );
  });
}

export function CodexCapabilitiesSettings() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const codexProviders =
    serverConfig?.providers.filter((provider) => provider.driver === "codex") ?? [];
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const selectedProvider =
    codexProviders.find((provider) => provider.instanceId === selectedInstanceId) ??
    codexProviders[0];
  const instanceId = selectedProvider?.instanceId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null || instanceId === null
      ? null
      : serverEnvironment.codexCapabilities({ environmentId, input: { instanceId } }),
  );
  const setSkillEnabled = useAtomCommand(serverEnvironment.setCodexSkillEnabled);
  const setConfigEnabled = useAtomCommand(serverEnvironment.setCodexConfigEnabled);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const runUpdate = async (key: string, update: () => Promise<{ readonly _tag: string }>) => {
    setUpdateError(null);
    setUpdating(key);
    try {
      const result = await update();
      if (result._tag === "Failure") {
        setUpdateError("Codex could not update this capability.");
      }
    } catch {
      setUpdateError("Codex could not update this capability.");
    } finally {
      setUpdating(null);
      refresh();
    }
  };
  const changeSkill = (item: CodexCapabilityItem, enabled: boolean) => {
    if (environmentId === null || instanceId === null) return;
    void runUpdate(`${item.id}:${item.label}`, () =>
      setSkillEnabled({ environmentId, input: { instanceId, path: item.id, enabled } }),
    );
  };
  const changeConfig =
    (kind: "plugin" | "mcp") => (item: CodexCapabilityItem, enabled: boolean) => {
      if (environmentId === null || instanceId === null) return;
      void runUpdate(`${item.id}:${item.label}`, () =>
        setConfigEnabled({ environmentId, input: { instanceId, kind, id: item.id, enabled } }),
      );
    };
  const heading = searchableSetting("capabilities");
  const loading =
    environmentId !== null &&
    (serverConfig === null || (instanceId !== null && data === null && error === null));

  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-2xl font-semibold">{heading.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Capabilities reported by Codex. Changes are saved to the user configuration and affect
          future sessions.
        </p>
      </div>
      <div className="px-3">
        {codexProviders.length > 1 ? (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-muted-foreground">Codex provider</span>
            <select
              className="h-8 rounded-md border border-input bg-background px-2"
              value={instanceId ?? ""}
              onChange={(event) => setSelectedInstanceId(event.target.value)}
            >
              {codexProviders.map((provider) => (
                <option key={provider.instanceId} value={provider.instanceId}>
                  {provider.displayName ?? provider.instanceId}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          onClick={refresh}
          disabled={instanceId === null || isPending}
        >
          {isPending ? "Refreshing…" : "Refresh"}
        </Button>
        {updateError ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {updateError}
          </p>
        ) : null}
      </div>
      {loading ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          Loading Codex capabilities…
        </p>
      ) : error ? (
        <p role="alert" className="px-3 text-sm text-destructive">
          {error}
        </p>
      ) : instanceId === null ? (
        <p role="alert" className="px-3 text-sm text-destructive">
          No Codex provider instance found.
        </p>
      ) : data ? (
        <>
          <SettingsSection id={heading.id} title="Hooks">
            <CapabilityRows
              items={data.hooks}
              readOnly="Codex exposes hook status but no individual hook toggle."
              updating={updating}
            />
          </SettingsSection>
          <SettingsSection title="Plugins">
            <CapabilityRows
              items={data.plugins}
              updating={updating}
              onChange={changeConfig("plugin")}
            />
          </SettingsSection>
          <SettingsSection title="Skills">
            <CapabilityRows items={data.skills} updating={updating} onChange={changeSkill} />
          </SettingsSection>
          <SettingsSection title="MCP">
            <CapabilityRows
              items={data.mcpServers}
              updating={updating}
              onChange={changeConfig("mcp")}
            />
          </SettingsSection>
        </>
      ) : null}
    </SettingsPageContainer>
  );
}
