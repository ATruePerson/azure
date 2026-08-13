import type { PreviewSessionSnapshot, PreviewAnnotationPayload } from "@azure/contracts";
import { FileText, Image as ImageIcon, ListChecks, Play, TerminalSquare } from "lucide-react";
import type { ReactNode } from "react";

import type { ActivePlanState, WorkLogEntry } from "~/session-logic";
import type { ComposerImageAttachment } from "~/composerDraftStore";
import type { ChatMessage } from "~/types";
import type { ElementContextDraft } from "~/lib/elementContext";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { extractTrailingPreviewAnnotation } from "~/lib/previewAnnotation";
import { cn } from "~/lib/utils";

type OverviewSource = {
  id: string;
  label: string;
  detail?: string;
  kind: "image" | "file" | "terminal" | "preview" | "context";
  image?: { id: string; name: string; previewUrl?: string };
  filePath?: string;
  terminalId?: string;
};

export interface ThreadOverviewPanelProps {
  readonly plan: ActivePlanState | null;
  readonly workLogEntries: ReadonlyArray<WorkLogEntry>;
  readonly runningTerminalIds: ReadonlyArray<string>;
  readonly terminalLabelsById: ReadonlyMap<string, string>;
  readonly previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly pendingImages: ReadonlyArray<ComposerImageAttachment>;
  readonly pendingTerminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly pendingElementContexts: ReadonlyArray<ElementContextDraft>;
  readonly pendingPreviewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly pendingReviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly onOpenProgress: () => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenTerminal: (terminalId: string) => void;
  readonly onOpenPreview: (tabId?: string) => void;
  readonly onOpenImage: (image: { id: string; name: string; previewUrl?: string }) => void;
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border/60 px-4 py-4 last:border-b-0">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h2>
      {props.children}
    </section>
  );
}

function ActionRow(props: {
  icon: ReactNode;
  label: string;
  detail?: string | undefined;
  onClick?: (() => void) | undefined;
  muted?: boolean | undefined;
}) {
  const content = (
    <>
      <span className="mt-0.5 shrink-0 text-muted-foreground">{props.icon}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className={cn("block truncate text-sm", props.muted && "text-muted-foreground")}>
          {props.label}
        </span>
        {props.detail ? (
          <span className="block truncate text-xs text-muted-foreground">{props.detail}</span>
        ) : null}
      </span>
    </>
  );
  return props.onClick ? (
    <button
      type="button"
      onClick={props.onClick}
      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
    >
      {content}
    </button>
  ) : (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5">{content}</div>
  );
}

function collectSources(props: ThreadOverviewPanelProps): OverviewSource[] {
  const draftSources: OverviewSource[] = [];
  const sentSources: OverviewSource[] = [];
  const seen = new Set<string>();
  const add = (source: OverviewSource) => {
    if (seen.has(source.id)) return;
    seen.add(source.id);
    (source.detail?.startsWith("Draft") ? draftSources : sentSources).push(source);
  };

  for (const image of props.pendingImages) {
    add({
      id: `draft:image:${image.id}`,
      label: image.name,
      detail: "Draft image",
      kind: "image",
      image,
    });
  }
  for (const context of props.pendingTerminalContexts) {
    add({
      id: `draft:terminal:${context.terminalId}`,
      label: "Terminal context",
      detail: `Draft · ${context.terminalId}`,
      kind: "terminal",
      terminalId: context.terminalId,
    });
  }
  for (const context of props.pendingElementContexts) {
    add({
      id: `draft:element:${context.id}`,
      label: "Browser element",
      detail: `Draft · ${context.pageTitle ?? context.tagName}`,
      kind: "context",
    });
  }
  for (const annotation of props.pendingPreviewAnnotations) {
    add({
      id: `draft:preview:${annotation.id}`,
      label: annotation.pageTitle || "Preview annotation",
      detail: "Draft annotation",
      kind: "preview",
    });
  }
  for (const comment of props.pendingReviewComments) {
    add({
      id: `draft:review:${comment.id}`,
      label: comment.filePath,
      detail: `Draft · ${comment.rangeLabel}`,
      kind: "file",
      filePath: comment.filePath,
    });
  }

  for (const message of props.messages) {
    if (message.role !== "user") continue;
    for (const attachment of message.attachments ?? []) {
      add({
        id: `image:${attachment.id}`,
        label: attachment.name,
        kind: "image",
        image: attachment,
      });
    }
    if (message.text.includes("<preview_annotation>")) {
      const parsed = extractTrailingPreviewAnnotation(message.text);
      add({
        id: `preview:${parsed.annotation?.id ?? message.id}`,
        label: parsed.annotation?.title ?? "Preview annotation",
        kind: "preview",
      });
    }
    if (message.text.includes("<terminal_context>")) {
      add({ id: `terminal-context:${message.id}`, label: "Terminal context", kind: "terminal" });
    }
    if (message.text.includes("<element_context>")) {
      add({ id: `element-context:${message.id}`, label: "Browser element", kind: "context" });
    }
    if (message.text.includes("<review_comment")) {
      add({ id: `review:${message.id}`, label: "Code review comment", kind: "file" });
    }
  }
  return [...draftSources, ...sentSources.reverse()];
}

export function ThreadOverviewPanel(props: ThreadOverviewPanelProps) {
  const completedSteps =
    props.plan?.steps.filter((step) => step.status === "completed").length ?? 0;
  const changedFiles = [
    ...new Set(props.workLogEntries.flatMap((entry) => entry.changedFiles ?? [])),
  ];
  const runningCommands = props.workLogEntries.filter(
    (entry) => entry.itemType === "command_execution" && entry.toolLifecycleStatus === "inProgress",
  );
  const activePreviews = Object.entries(props.previewSessions).filter(
    ([, session]) => session.navStatus._tag !== "Idle",
  );
  const sources = collectSources(props);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Section title="Plan">
        {props.plan ? (
          <ActionRow
            icon={<ListChecks className="size-4" />}
            label={`${completedSteps}/${props.plan.steps.length} steps complete`}
            detail={
              props.plan.steps.find((step) => step.status === "inProgress")?.step ??
              props.plan.steps[0]?.step
            }
            onClick={props.onOpenProgress}
          />
        ) : (
          <p className="px-2 text-sm text-muted-foreground">No active plan.</p>
        )}
      </Section>

      <Section title="Outputs">
        {changedFiles.length === 0 && activePreviews.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No outputs yet.</p>
        ) : (
          <div className="space-y-0.5">
            {changedFiles.slice(0, 6).map((path) => (
              <ActionRow
                key={path}
                icon={<FileText className="size-4" />}
                label={path}
                onClick={() => props.onOpenFile(path)}
              />
            ))}
            {activePreviews.slice(0, 3).map(([tabId, session]) => (
              <ActionRow
                key={tabId}
                icon={<Play className="size-4" />}
                label={
                  session.navStatus._tag === "Idle"
                    ? "Preview"
                    : session.navStatus.title || session.navStatus.url
                }
                detail="Browser preview"
                onClick={() => props.onOpenPreview(tabId)}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Background Processes">
        {props.runningTerminalIds.length === 0 && runningCommands.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No background processes.</p>
        ) : (
          <div className="space-y-0.5">
            {props.runningTerminalIds.map((terminalId) => (
              <ActionRow
                key={terminalId}
                icon={<TerminalSquare className="size-4" />}
                label={props.terminalLabelsById.get(terminalId) ?? "Terminal"}
                detail="Running"
                onClick={() => props.onOpenTerminal(terminalId)}
              />
            ))}
            {runningCommands.map((entry) => (
              <ActionRow
                key={entry.id}
                icon={<Play className="size-4" />}
                label={entry.label}
                detail={entry.command ?? "Running command"}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Sources">
        {sources.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No sources attached.</p>
        ) : (
          <div className="space-y-0.5">
            {sources.slice(0, 3).map((source) => (
              <ActionRow
                key={source.id}
                icon={
                  source.kind === "image" ? (
                    <ImageIcon className="size-4" />
                  ) : (
                    <FileText className="size-4" />
                  )
                }
                label={source.label}
                detail={source.detail}
                onClick={
                  source.kind === "image" && source.image
                    ? () => props.onOpenImage(source.image!)
                    : source.kind === "file" && source.filePath
                      ? () => props.onOpenFile(source.filePath!)
                      : source.kind === "terminal" && source.terminalId
                        ? () => props.onOpenTerminal(source.terminalId!)
                        : source.kind === "preview"
                          ? props.onOpenPreview
                          : undefined
                }
              />
            ))}
            {sources.length > 3 ? (
              <p className="px-2 pt-2 text-xs text-muted-foreground">
                View all {sources.length} sources
              </p>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
