import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  recalculateScheduledTask,
  readScheduledTasks,
  upsertScheduledTask,
  claimScheduledTask,
  writeScheduledTasks,
} from "./scheduledTasks.ts";
import type { ScheduledTask } from "@t3tools/contracts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

function task(schedule: ScheduledTask["schedule"]): ScheduledTask {
  return {
    id: "task-1",
    name: "Check",
    prompt: "check",
    projectPath: "/tmp/project",
    schedule,
    threadMode: { type: "standalone" },
    workspaceMode: "local",
    providerId: "provider",
    modelId: "model",
    sandboxMode: "full-access",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    recentRunThreadIds: [],
  };
}

describe("scheduled tasks", () => {
  it("calculates one-time and RRULE occurrences and persists atomically", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z");
    expect(
      recalculateScheduledTask(task({ type: "once", at: "2026-08-11T13:00:00.000Z" }), now)
        .nextRunAt,
    ).toBe("2026-08-11T13:00:00.000Z");
    expect(
      recalculateScheduledTask(
        task({
          type: "rrule",
          rule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
          timezone: "America/Los_Angeles",
        }),
        now,
      ).nextRunAt,
    ).toBeTruthy();
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-tasks-"));
    directories.push(home);
    await upsertScheduledTask(task({ type: "once", at: "2026-08-11T13:00:00.000Z" }), home);
    await expect(readScheduledTasks(home)).resolves.toHaveLength(1);
  });

  it("claims a due task once and advances recurring tasks", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-tasks-"));
    directories.push(home);
    const due = recalculateScheduledTask(
      task({ type: "once", at: "2026-08-11T11:00:00.000Z" }),
      new Date("2026-08-11T12:00:00.000Z"),
    );
    await writeScheduledTasks([{ ...due, nextRunAt: "2026-08-11T11:00:00.000Z" }], home);
    expect(
      await claimScheduledTask("task-1", new Date("2026-08-11T12:00:00.000Z"), home),
    ).not.toBeNull();
    expect(
      await claimScheduledTask("task-1", new Date("2026-08-11T12:00:00.000Z"), home),
    ).toBeNull();
  });

  it("surfaces malformed persisted definitions", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "azure-tasks-invalid-"));
    directories.push(home);
    await NodeFSP.writeFile(NodePath.join(home, "scheduled-tasks.json"), '{"tasks":[{"id":1}]}\n');
    await expect(readScheduledTasks(home)).rejects.toThrow("malformed");
  });
});
