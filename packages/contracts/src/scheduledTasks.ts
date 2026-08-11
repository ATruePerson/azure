import * as Schema from "effect/Schema";

export const ScheduledTaskSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("once"), at: Schema.String }),
  Schema.Struct({ type: Schema.Literal("rrule"), rule: Schema.String, timezone: Schema.String }),
]);
export type ScheduledTaskSchedule = typeof ScheduledTaskSchedule.Type;

export const ScheduledTaskThreadMode = Schema.Union([
  Schema.Struct({ type: Schema.Literal("standalone") }),
  Schema.Struct({ type: Schema.Literal("continue"), threadId: Schema.String }),
]);

export const ScheduledTask = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  projectPath: Schema.String,
  schedule: ScheduledTaskSchedule,
  threadMode: ScheduledTaskThreadMode,
  workspaceMode: Schema.Literals(["local", "worktree"]),
  providerId: Schema.String,
  modelId: Schema.String,
  effort: Schema.optional(Schema.String),
  sandboxMode: Schema.String,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  recentRunThreadIds: Schema.Array(Schema.String),
});
export type ScheduledTask = typeof ScheduledTask.Type;

export const ScheduledTaskSetEnabledInput = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
});
export const ScheduledTaskRunInput = Schema.Struct({ id: Schema.String });

export class ScheduledTaskError extends Schema.TaggedErrorClass<ScheduledTaskError>()(
  "ScheduledTaskError",
  { message: Schema.String },
) {}
