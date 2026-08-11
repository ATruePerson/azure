// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { RRule } from "rrule";
import * as Schema from "effect/Schema";
import {
  ScheduledTask,
  type ScheduledTask as ScheduledTaskValue,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";

const MAX_TASKS_BYTES = 512 * 1024;
const TASKS_FILE = "scheduled-tasks.json";
const activeTaskIds = new Set<string>();

export function scheduledTasksPath(azureHome = NodePath.join(NodeOS.homedir(), ".azure")): string {
  return NodePath.join(azureHome, TASKS_FILE);
}

function nextRunAt(schedule: ScheduledTaskSchedule, now = new Date()): string | null {
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return Number.isNaN(at.valueOf()) || at <= now ? null : at.toISOString();
  }
  try {
    const options = RRule.parseString(schedule.rule);
    const rule = new RRule({ ...options, tzid: schedule.timezone });
    return rule.after(now, false)?.toISOString() ?? null;
  } catch {
    return null;
  }
}

export function recalculateScheduledTask(
  task: ScheduledTaskValue,
  now = new Date(),
): ScheduledTaskValue {
  return { ...task, nextRunAt: task.enabled ? nextRunAt(task.schedule, now) : null };
}

async function atomicWrite(tasks: ReadonlyArray<ScheduledTaskValue>, path: string): Promise<void> {
  const body = `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_TASKS_BYTES)
    throw new Error("Scheduled task file is too large.");
  const parent = NodePath.dirname(path);
  await NodeFSP.mkdir(parent, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

const decodeScheduledTasks = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.optional(Schema.Number),
    tasks: Schema.Array(ScheduledTask),
  }),
);

export async function readScheduledTasks(azureHome?: string): Promise<ScheduledTaskValue[]> {
  const path = scheduledTasksPath(azureHome);
  try {
    const stat = await NodeFSP.stat(path);
    if (!stat.isFile()) throw new Error("Scheduled task file is not a regular file.");
    if (stat.size > MAX_TASKS_BYTES) throw new Error("Scheduled task file is too large.");
    const decoded = decodeScheduledTasks(JSON.parse(await NodeFSP.readFile(path, "utf8")));
    return [...decoded.tasks];
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (cause instanceof SyntaxError) throw new Error("Scheduled task file contains invalid JSON.");
    if (cause instanceof Error && cause.message.startsWith("Scheduled task")) throw cause;
    throw new Error("Scheduled task file is malformed.");
  }
}

export async function readScheduledTasksLenient(azureHome?: string): Promise<ScheduledTaskValue[]> {
  try {
    return await readScheduledTasks(azureHome);
  } catch {
    return [];
  }
}

export async function writeScheduledTasks(
  tasks: ReadonlyArray<ScheduledTaskValue>,
  azureHome?: string,
): Promise<void> {
  await atomicWrite(tasks, scheduledTasksPath(azureHome));
}

export async function upsertScheduledTask(
  task: ScheduledTaskValue,
  azureHome?: string,
): Promise<ScheduledTaskValue> {
  const normalized = recalculateScheduledTask({
    ...task,
    recentRunThreadIds: task.recentRunThreadIds.slice(-20),
  });
  const tasks = await readScheduledTasks(azureHome);
  const index = tasks.findIndex((entry) => entry.id === normalized.id);
  if (index < 0) tasks.push(normalized);
  else tasks[index] = normalized;
  await writeScheduledTasks(tasks, azureHome);
  return normalized;
}

export async function setScheduledTaskEnabled(
  id: string,
  enabled: boolean,
  azureHome?: string,
): Promise<ScheduledTaskValue> {
  const tasks = await readScheduledTasks(azureHome);
  const task = tasks.find((entry) => entry.id === id);
  if (!task) throw new Error("Scheduled task was not found.");
  return upsertScheduledTask({ ...task, enabled }, azureHome);
}

/** Claims one task occurrence. The caller creates the normal Azure thread. */
export async function claimScheduledTask(
  id: string,
  now = new Date(),
  azureHome?: string,
): Promise<ScheduledTaskValue | null> {
  if (activeTaskIds.has(id)) return null;
  const tasks = await readScheduledTasks(azureHome);
  const task = tasks.find((entry) => entry.id === id);
  if (!task || !task.enabled || !task.nextRunAt || new Date(task.nextRunAt) > now) return null;
  activeTaskIds.add(id);
  const next =
    task.schedule.type === "once" ? null : nextRunAt(task.schedule, new Date(now.valueOf() + 1000));
  const updated = { ...task, lastRunAt: now.toISOString(), nextRunAt: next };
  try {
    await upsertScheduledTask(updated, azureHome);
    return updated;
  } catch (cause) {
    activeTaskIds.delete(id);
    throw cause;
  }
}

export function finishScheduledTask(id: string): void {
  activeTaskIds.delete(id);
}

export function resetScheduledTaskClaims(): void {
  activeTaskIds.clear();
}
