import { CalendarClockIcon, PlayIcon } from "lucide-react";
import type { EnvironmentId, ScheduledTask } from "@azure/contracts";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function TaskRow({
  task,
  environmentId,
  refresh,
}: {
  task: ScheduledTask;
  environmentId: EnvironmentId;
  refresh: () => void;
}) {
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled);
  const run = useAtomCommand(serverEnvironment.runScheduledTask);
  return (
    <SettingsRow
      title={task.name}
      description={`${task.schedule.type === "once" ? `Once at ${task.schedule.at}` : task.schedule.rule} · ${task.projectPath}`}
      status={
        task.nextRunAt ? `Next: ${task.nextRunAt}` : task.enabled ? "No upcoming run" : "Paused"
      }
      control={
        <Switch
          checked={task.enabled}
          onCheckedChange={(enabled) => {
            void setEnabled({ environmentId, input: { id: task.id, enabled } }).then(refresh);
          }}
        />
      }
    >
      <div className="flex gap-2 pb-3">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void run({ environmentId, input: { id: task.id } }).then(refresh);
          }}
        >
          <PlayIcon className="size-3.5" /> Run now
        </Button>
      </div>
    </SettingsRow>
  );
}

export function ScheduledTasksSettings() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId ? serverEnvironment.scheduledTasks({ environmentId, input: {} }) : null,
  );
  const tasks = query.data ?? [];
  const active = tasks.filter((task) => task.enabled);
  const paused = tasks.filter((task) => !task.enabled);
  const refresh = () => void query.refresh();
  return (
    <SettingsPageContainer>
      <div className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <CalendarClockIcon className="size-5" /> Scheduled Tasks
        </h1>
        <p className="text-sm text-muted-foreground">
          Run prompts while Azure is running and the Mac is awake.
        </p>
      </div>
      <SettingsSection title="Active">
        {active.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No active tasks.</p>
        ) : (
          active.map((task) =>
            environmentId ? (
              <TaskRow key={task.id} task={task} environmentId={environmentId} refresh={refresh} />
            ) : null,
          )
        )}
      </SettingsSection>
      <SettingsSection title="Paused">
        {paused.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No paused tasks.</p>
        ) : (
          paused.map((task) =>
            environmentId ? (
              <TaskRow key={task.id} task={task} environmentId={environmentId} refresh={refresh} />
            ) : null,
          )
        )}
      </SettingsSection>
      <SettingsSection title="Run history">
        {tasks.every((task) => task.lastRunAt === null) ? (
          <p className="px-4 text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          tasks.map((task) =>
            task.lastRunAt ? (
              <SettingsRow
                key={task.id}
                title={task.name}
                description={`Last run: ${task.lastRunAt}`}
              />
            ) : null,
          )
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
