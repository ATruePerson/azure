import { BookOpenIcon, PlugIcon, PuzzleIcon, SearchIcon, WebhookIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState, type ComponentType } from "react";
import {
  ProviderInstanceId,
  type CodexCapabilities,
  type CodexCapabilityItem,
} from "@t3tools/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { useAssetUrl } from "~/assets/assetUrls";

const DEFAULT_AZURE_RUNTIME_INSTANCE_ID = ProviderInstanceId.make("codex");

export type CapabilityCategory = "hooks" | "plugins" | "skills" | "mcp";
type CapabilityView = CapabilityCategory | "all";

const CATEGORY_CONFIG: Readonly<
  Record<
    CapabilityCategory,
    {
      readonly key: Exclude<keyof CodexCapabilities, "homeStatus">;
      readonly title: string;
      readonly description: string;
      readonly searchId: SettingsSearchItemId;
      readonly route:
        | "/settings/hooks"
        | "/settings/plugins"
        | "/settings/skills"
        | "/settings/mcp";
      readonly icon: ComponentType<{ className?: string }>;
    }
  >
> = {
  hooks: {
    key: "hooks",
    title: "Hooks",
    description: "See the lifecycle hooks Azure found in the local runtime.",
    searchId: "hooks",
    route: "/settings/hooks",
    icon: WebhookIcon,
  },
  plugins: {
    key: "plugins",
    title: "Plugins",
    description: "Manage installed plugins and see their logos, descriptions, and source.",
    searchId: "plugins",
    route: "/settings/plugins",
    icon: PuzzleIcon,
  },
  skills: {
    key: "skills",
    title: "Skills",
    description: "Manage the skills available to Azure in the local runtime.",
    searchId: "skills",
    route: "/settings/skills",
    icon: BookOpenIcon,
  },
  mcp: {
    key: "mcpServers",
    title: "MCP",
    description: "See configured MCP servers and their current auth or connection status.",
    searchId: "mcp",
    route: "/settings/mcp",
    icon: PlugIcon,
  },
};

function CapabilityIcon({
  item,
  category,
  environmentId,
}: {
  readonly item: CodexCapabilityItem;
  readonly category: CapabilityCategory;
  readonly environmentId: Parameters<typeof useAssetUrl>[0] | null;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const Icon = CATEGORY_CONFIG[category].icon;
  const monogram = item.label.trim().charAt(0).toUpperCase();

  if (item.icon && environmentId !== null) {
    return <CapabilityAssetIcon item={item} category={category} environmentId={environmentId} />;
  }

  if (item.iconUrl && !imageFailed) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted">
        <img
          src={item.iconUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setImageFailed(true)}
        />
      </span>
    );
  }

  return (
    <span
      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted text-muted-foreground"
      style={item.brandColor ? { backgroundColor: item.brandColor } : undefined}
    >
      {monogram || <Icon className="size-4" />}
    </span>
  );
}

function CapabilityAssetIcon({
  item,
  category,
  environmentId,
}: {
  readonly item: CodexCapabilityItem;
  readonly category: CapabilityCategory;
  readonly environmentId: Parameters<typeof useAssetUrl>[0];
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const iconUrl = useAssetUrl(environmentId, { _tag: "azure-capability-icon", ...item.icon! });
  const Icon = CATEGORY_CONFIG[category].icon;
  const monogram = item.label.trim().charAt(0).toUpperCase();
  if (!iconUrl || imageFailed) {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted text-muted-foreground">
        {monogram || <Icon className="size-4" />}
      </span>
    );
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted">
      <img
        src={iconUrl}
        alt=""
        className="size-full object-cover"
        onError={() => setImageFailed(true)}
      />
    </span>
  );
}

function CapabilityRows({
  items,
  category,
  environmentId,
  updatingItemId,
  onToggle,
}: {
  readonly items: ReadonlyArray<CodexCapabilityItem>;
  readonly category: CapabilityCategory;
  readonly environmentId: Parameters<typeof useAssetUrl>[0] | null;
  readonly updatingItemId: string | null;
  readonly onToggle: ((item: CodexCapabilityItem, enabled: boolean) => void) | undefined;
}) {
  if (items.length === 0) {
    return <p className="px-3 text-sm text-muted-foreground">None found.</p>;
  }
  return items.map((item) => {
    const updateKey = `${item.id}:${item.label}`;
    const detail = [item.description, item.detail].filter(Boolean).join(" · ");
    const controlDescription =
      item.control?._tag === "azure-skill"
        ? "Toggle availability for Azure."
        : item.control?._tag === "azure-capability"
          ? "Toggle availability for Azure. New sessions may be required."
          : item.control?._tag === "plugin"
            ? `Controlled by the ${item.control.pluginId} plugin.`
            : item.control?._tag === "unsupported"
              ? item.control.reason
              : item.canToggle
                ? "Toggle availability for Azure."
                : "Managed by its source and cannot be changed here.";
    const description = `${detail ? `${detail} · ` : ""}${controlDescription}`;
    const status =
      item.enabled === undefined
        ? undefined
        : `${item.enabled ? "Enabled" : "Disabled"}${item.restartRequired ? " · New session required" : ""}`;
    const canToggle = item.canToggle && item.enabled !== undefined && onToggle !== undefined;
    return (
      <SettingsRow
        key={updateKey}
        title={
          <span className="flex items-center gap-3">
            <CapabilityIcon item={item} category={category} environmentId={environmentId} />
            <span>{item.label}</span>
          </span>
        }
        description={description}
        status={status}
        control={
          canToggle ? (
            <Switch
              checked={item.enabled}
              disabled={updatingItemId === updateKey}
              onCheckedChange={(enabled) => onToggle(item, enabled)}
              aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.label}`}
            />
          ) : undefined
        }
      />
    );
  });
}

export function CodexCapabilitiesSettings({
  category,
}: {
  readonly category?: CapabilityCategory;
}) {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const [query, setQuery] = useState("");
  const [updatingItemId, setUpdatingItemId] = useState<string | null>(null);
  const instanceId = DEFAULT_AZURE_RUNTIME_INSTANCE_ID;
  const setAzureCapabilityEnabled = useAtomCommand(serverEnvironment.setAzureCapabilityEnabled);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.codexCapabilities({ environmentId, input: { instanceId } }),
  );
  const activeCategory: CapabilityView = category ?? "all";
  const heading = searchableSetting(category ? CATEGORY_CONFIG[category].searchId : "capabilities");
  const loading = environmentId !== null && data === null && error === null;
  const filteredItemsByCategory = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return Object.fromEntries(
      (Object.keys(CATEGORY_CONFIG) as CapabilityCategory[]).map((section) => {
        const items = data ? data[CATEGORY_CONFIG[section].key] : [];
        return [
          section,
          normalizedQuery
            ? items.filter((item) =>
                [item.label, item.description, item.detail]
                  .filter(Boolean)
                  .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)),
              )
            : items,
        ];
      }),
    ) as Record<CapabilityCategory, ReadonlyArray<CodexCapabilityItem>>;
  }, [data, query]);
  const handleToggle = useCallback(
    async (item: CodexCapabilityItem, enabled: boolean) => {
      if (environmentId === null || updatingItemId !== null) return;
      const updateKey = `${item.id}:${item.label}`;
      setUpdatingItemId(updateKey);
      const capabilityKind =
        item.control?._tag === "azure-capability"
          ? item.control.kind
          : item.control?._tag === "plugin"
            ? "hooks"
            : (category ?? "skills");
      const targetId = item.control?._tag === "plugin" ? item.control.pluginId : item.id;
      const result = await setAzureCapabilityEnabled({
        environmentId,
        input: { kind: capabilityKind, id: targetId, enabled },
      });
      setUpdatingItemId(null);
      if (result._tag === "Success") {
        refresh();
        void refreshProviders({ environmentId, input: {} });
      }
    },
    [category, environmentId, refresh, refreshProviders, setAzureCapabilityEnabled, updatingItemId],
  );
  const renderSection = (section: CapabilityCategory) => {
    const config = CATEGORY_CONFIG[section];
    return (
      <SettingsSection key={section} id={!category ? undefined : heading.id} title={config.title}>
        <CapabilityRows
          items={filteredItemsByCategory[section]}
          category={section}
          environmentId={environmentId}
          updatingItemId={updatingItemId}
          onToggle={handleToggle}
        />
      </SettingsSection>
    );
  };

  return (
    <SettingsPageContainer>
      <div>
        <h1 className="text-2xl font-semibold">
          {category ? CATEGORY_CONFIG[category].title : "Capabilities"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {category
            ? CATEGORY_CONFIG[category].description
            : "Azure checks the local runtime for hooks, plugins, skills, and MCP servers. Toggle availability for new sessions here."}
        </p>
      </div>
      <div className="px-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onClick={refresh} disabled={isPending}>
            {isPending ? "Refreshing…" : "Refresh"}
          </Button>
          <div
            className="flex gap-1 rounded-md border border-border p-1"
            role="tablist"
            aria-label="Capabilities"
          >
            {(["all", ...Object.keys(CATEGORY_CONFIG)] as CapabilityView[]).map((section) => (
              <Button
                key={section}
                size="xs"
                variant={section === activeCategory ? "secondary" : "ghost"}
                render={
                  <Link
                    to={
                      section === "all" ? "/settings/capabilities" : CATEGORY_CONFIG[section].route
                    }
                  />
                }
                role="tab"
                aria-selected={section === activeCategory}
              >
                {section === "all" ? "All" : CATEGORY_CONFIG[section].title}
              </Button>
            ))}
          </div>
          <div className="relative w-full max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={`Search ${activeCategory === "all" ? "capabilities" : CATEGORY_CONFIG[activeCategory].title.toLowerCase()}`}
              aria-label={`Search ${activeCategory === "all" ? "capabilities" : CATEGORY_CONFIG[activeCategory].title.toLowerCase()}`}
              className="pl-8"
            />
          </div>
        </div>
        {data?.homeStatus === "missing" ? (
          <p className="mt-2 text-sm text-muted-foreground">Azure home has no registry yet.</p>
        ) : data?.homeStatus === "unavailable" ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Azure home is unavailable. Check its permissions and try again.
          </p>
        ) : null}
      </div>
      {loading ? (
        <p role="status" className="px-3 text-sm text-muted-foreground">
          Loading Azure integrations…
        </p>
      ) : error ? (
        <p role="alert" className="px-3 text-sm text-destructive">
          {error}
        </p>
      ) : data ? (
        activeCategory === "all" ? (
          (Object.keys(CATEGORY_CONFIG) as CapabilityCategory[]).map(renderSection)
        ) : (
          renderSection(activeCategory)
        )
      ) : null}
    </SettingsPageContainer>
  );
}
