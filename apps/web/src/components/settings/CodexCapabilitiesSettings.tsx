import {
  BookOpenIcon,
  CheckIcon,
  PlugIcon,
  PuzzleIcon,
  SearchIcon,
  WebhookIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState, type ComponentType } from "react";
import {
  ProviderInstanceId,
  type CodexCapabilities,
  type CodexCapabilityItem,
} from "@azure/contracts";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer } from "./settingsLayout";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { useAssetUrl } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";

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
    description:
      "SessionStart and UserPromptSubmit. Scope a hook to one project so other workspaces skip it.",
    searchId: "hooks",
    route: "/settings/hooks",
    icon: WebhookIcon,
  },
  plugins: {
    key: "plugins",
    title: "Plugins",
    description:
      "Portable plugin skills and hooks. Scope them to one project to skip other workspaces.",
    searchId: "plugins",
    route: "/settings/plugins",
    icon: PuzzleIcon,
  },
  skills: {
    key: "skills",
    title: "Skills",
    description:
      "Everywhere loads the skill in every session. A project limits it to that workspace.",
    searchId: "skills",
    route: "/settings/skills",
    icon: BookOpenIcon,
  },
  mcp: {
    key: "mcpServers",
    title: "MCP",
    description:
      "Everywhere shares the MCP with every session. A project loads it only for that workspace.",
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
  projects,
  updatingItemId,
  onToggle,
  onScopeChange,
}: {
  readonly items: ReadonlyArray<CodexCapabilityItem>;
  readonly category: CapabilityCategory;
  readonly environmentId: Parameters<typeof useAssetUrl>[0] | null;
  readonly projects: ReadonlyArray<{ readonly title: string; readonly workspaceRoot: string }>;
  readonly updatingItemId: string | null;
  readonly onToggle: ((item: CodexCapabilityItem, enabled: boolean) => void) | undefined;
  readonly onScopeChange:
    | ((item: CodexCapabilityItem, projectRoots: ReadonlyArray<string>) => void)
    | undefined;
}) {
  if (items.length === 0) {
    return <p className="px-1 py-6 text-sm text-muted-foreground">None found.</p>;
  }
  return items.map((item) => {
    const updateKey = `${item.id}:${item.label}`;
    const description = item.description ?? item.detail ?? "";
    const canToggle = item.canToggle && item.enabled !== undefined && onToggle !== undefined;
    const scopedRoot = item.projectRoots?.[0] ?? "";
    return (
      <div key={updateKey} className="flex items-center gap-3 py-3">
        <CapabilityIcon item={item} category={category} environmentId={environmentId} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{item.label}</div>
          {description ? (
            <div className="truncate text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {canToggle ? (
          <div className="flex shrink-0 items-center gap-2">
            {onScopeChange && projects.length > 0 ? (
              <select
                className="h-8 max-w-36 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                value={scopedRoot}
                disabled={updatingItemId === updateKey}
                aria-label={`Load ${item.label} for`}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  onScopeChange(item, value ? [value] : []);
                }}
              >
                <option value="">Everywhere</option>
                {projects.map((project) => (
                  <option key={project.workspaceRoot} value={project.workspaceRoot}>
                    {project.title}
                  </option>
                ))}
              </select>
            ) : null}
            <Switch
              checked={item.enabled}
              disabled={updatingItemId === updateKey}
              onCheckedChange={(enabled) => onToggle(item, enabled)}
              aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.label}`}
            />
          </div>
        ) : (
          <CheckIcon className="size-4 shrink-0 text-muted-foreground/50" aria-hidden />
        )}
      </div>
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
  const projects = useProjects();
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
  const capabilityTarget = useCallback(
    (item: CodexCapabilityItem) => {
      const capabilityKind =
        item.control?._tag === "azure-capability"
          ? item.control.kind
          : item.control?._tag === "plugin"
            ? "hooks"
            : (category ?? "skills");
      const targetId = item.control?._tag === "plugin" ? item.control.pluginId : item.id;
      return { kind: capabilityKind, id: targetId };
    },
    [category],
  );
  const handleToggle = useCallback(
    async (item: CodexCapabilityItem, enabled: boolean) => {
      if (environmentId === null || updatingItemId !== null) return;
      const updateKey = `${item.id}:${item.label}`;
      setUpdatingItemId(updateKey);
      const target = capabilityTarget(item);
      const result = await setAzureCapabilityEnabled({
        environmentId,
        input: { kind: target.kind, id: target.id, enabled },
      });
      setUpdatingItemId(null);
      if (result._tag === "Success") {
        refresh();
        void refreshProviders({ environmentId, input: {} });
      }
    },
    [
      capabilityTarget,
      environmentId,
      refresh,
      refreshProviders,
      setAzureCapabilityEnabled,
      updatingItemId,
    ],
  );
  const handleScopeChange = useCallback(
    async (item: CodexCapabilityItem, projectRoots: ReadonlyArray<string>) => {
      if (environmentId === null || updatingItemId !== null) return;
      const updateKey = `${item.id}:${item.label}`;
      setUpdatingItemId(updateKey);
      const target = capabilityTarget(item);
      const result = await setAzureCapabilityEnabled({
        environmentId,
        input: {
          kind: target.kind,
          id: target.id,
          enabled: item.enabled !== false,
          projectRoots: [...projectRoots],
        },
      });
      setUpdatingItemId(null);
      if (result._tag === "Success") {
        refresh();
        void refreshProviders({ environmentId, input: {} });
      }
    },
    [
      capabilityTarget,
      environmentId,
      refresh,
      refreshProviders,
      setAzureCapabilityEnabled,
      updatingItemId,
    ],
  );
  const renderSection = (section: CapabilityCategory) => (
    <CapabilityRows
      items={filteredItemsByCategory[section]}
      category={section}
      environmentId={environmentId}
      projects={projects}
      updatingItemId={updatingItemId}
      onToggle={handleToggle}
      onScopeChange={handleScopeChange}
    />
  );
  const tabOrder: CapabilityView[] = ["plugins", "skills", "mcp", "hooks", "all"];
  const pageTitle = category ? CATEGORY_CONFIG[category].title : "Plugins";

  return (
    <SettingsPageContainer className="max-w-3xl gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 id={heading.id} className="text-2xl font-semibold tracking-tight">
            {pageTitle}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage plugins, skills, and MCPs</p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={isPending}>
          {isPending ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex min-w-0 flex-1 flex-wrap gap-1"
          role="tablist"
          aria-label="Capabilities"
        >
          {tabOrder.map((section) => {
            const count =
              section === "all"
                ? (Object.keys(CATEGORY_CONFIG) as CapabilityCategory[]).reduce(
                    (total, key) => total + filteredItemsByCategory[key].length,
                    0,
                  )
                : filteredItemsByCategory[section].length;
            const label = section === "all" ? "All" : CATEGORY_CONFIG[section].title;
            return (
              <Link
                key={section}
                to={section === "all" ? "/settings/capabilities" : CATEGORY_CONFIG[section].route}
                role="tab"
                aria-selected={section === activeCategory}
                className={cn(
                  "rounded-md px-2.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  section === activeCategory && "bg-muted text-foreground",
                )}
              >
                {label} {data ? count : ""}
              </Link>
            );
          })}
        </div>
        <div className="relative w-full max-w-xs">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={`Search ${activeCategory === "all" ? "plugins" : CATEGORY_CONFIG[activeCategory].title.toLowerCase()}`}
            aria-label={`Search ${activeCategory === "all" ? "plugins" : CATEGORY_CONFIG[activeCategory].title.toLowerCase()}`}
            className="h-8 rounded-full pl-8"
          />
        </div>
      </div>
      {data?.homeStatus === "missing" ? (
        <p className="text-sm text-muted-foreground">Azure home has no registry yet.</p>
      ) : data?.homeStatus === "unavailable" ? (
        <p role="alert" className="text-sm text-destructive">
          Azure home is unavailable. Check its permissions and try again.
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading Azure integrations…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : data ? (
        <div className="divide-y divide-border/60">
          {activeCategory === "all"
            ? (["plugins", "skills", "mcp", "hooks"] as CapabilityCategory[])
                .filter((section) => filteredItemsByCategory[section].length > 0)
                .map((section) => <div key={section}>{renderSection(section)}</div>)
            : renderSection(activeCategory)}
        </div>
      ) : null}
    </SettingsPageContainer>
  );
}
