// ponytail: in-memory controller, replace with a persisted task projection only if child lifetimes need to outlive the parent process.
import { randomUUID } from "node:crypto";

export const API_SUBAGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "spawn_agent",
      description: "Run one direct child agent.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string" },
          taskName: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "wait_agents",
      description: "Wait for child agents.",
      parameters: {
        type: "object",
        properties: { agentIds: { type: "array", items: { type: "string" } } },
        required: ["agentIds"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description: "Send a message to a child agent.",
      parameters: {
        type: "object",
        properties: { agentId: { type: "string" }, message: { type: "string" } },
        required: ["agentId", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "stop_agent",
      description: "Stop a child agent.",
      parameters: {
        type: "object",
        properties: { agentId: { type: "string" } },
        required: ["agentId"],
      },
    },
  },
];

export function apiSubagentToolsForModel(
  support: "verified" | "unsupported" | "unknown" | undefined,
) {
  return support === "verified" ? API_SUBAGENT_TOOLS : [];
}

export type ApiSubagentState = "running" | "completed" | "failed" | "cancelled";
export interface ApiSubagent {
  readonly id: string;
  readonly taskName: string;
  readonly task: string;
  readonly model?: string;
  readonly effort?: string;
  readonly state: ApiSubagentState;
  readonly summary?: string;
}

type MutableAgent = Omit<ApiSubagent, "state" | "summary"> & {
  state: ApiSubagentState;
  summary?: string;
  controller: AbortController;
  messages: string[];
  promise: Promise<void>;
};

export class ApiSubagentController {
  private readonly agents = new Map<string, MutableAgent>();
  private active = 1;
  private readonly run: (input: {
    task: string;
    model?: string;
    effort?: string;
    signal: AbortSignal;
    messages: ReadonlyArray<string>;
  }) => Promise<string>;
  private readonly onChange: (agent: ApiSubagent) => void;

  constructor(
    run: (input: {
      task: string;
      model?: string;
      effort?: string;
      signal: AbortSignal;
      messages: ReadonlyArray<string>;
    }) => Promise<string>,
    onChange: (agent: ApiSubagent) => void = () => undefined,
  ) {
    this.run = run;
    this.onChange = onChange;
  }

  spawn(input: {
    task: string;
    taskName?: string;
    model?: string;
    effort?: string;
    parentId?: string;
  }): ApiSubagent {
    if (!input.task.trim()) throw new Error("spawn_agent.task is required.");
    if (input.parentId && this.agents.has(input.parentId))
      throw new Error("API subagents may only create direct children.");
    if (this.active >= 4) throw new Error("API subagent concurrency limit reached.");
    const id = `agent-${randomUUID()}`;
    const controller = new AbortController();
    const agent: MutableAgent = {
      id,
      task: input.task.trim(),
      taskName: input.taskName?.trim() || id,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      state: "running",
      controller,
      messages: [],
      promise: Promise.resolve(),
    };
    this.agents.set(id, agent);
    this.active += 1;
    agent.promise = this.run({
      task: agent.task,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      signal: controller.signal,
      messages: agent.messages,
    })
      .then((summary) => {
        agent.state = controller.signal.aborted ? "cancelled" : "completed";
        agent.summary = summary.slice(0, 16_000);
      })
      .catch((error) => {
        agent.state = controller.signal.aborted ? "cancelled" : "failed";
        agent.summary = error instanceof Error ? error.message : "Agent failed.";
      })
      .finally(() => {
        this.active -= 1;
        this.onChange(agent);
      });
    this.onChange(agent);
    return this.snapshot(agent);
  }

  async wait(ids: ReadonlyArray<string>): Promise<ReadonlyArray<ApiSubagent>> {
    const agents = ids.map((id) => this.agents.get(id));
    if (agents.some((agent) => !agent))
      throw new Error("wait_agents received an unknown agent id.");
    await Promise.all(agents.map((agent) => agent!.promise));
    return agents.map((agent) => this.snapshot(agent!));
  }

  sendMessage(id: string, message: string): ApiSubagent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("send_message received an unknown agent id.");
    if (!message.trim()) throw new Error("send_message.message is required.");
    if (agent.state !== "running") throw new Error("Cannot message a finished agent.");
    agent.messages.push(message.trim());
    this.onChange(agent);
    return this.snapshot(agent);
  }

  stop(id: string): ApiSubagent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("stop_agent received an unknown agent id.");
    if (agent.state === "running") agent.controller.abort();
    return this.snapshot(agent);
  }

  stopAll(): void {
    for (const agent of this.agents.values())
      if (agent.state === "running") agent.controller.abort();
  }

  private snapshot(agent: MutableAgent): ApiSubagent {
    const { controller: _controller, messages: _messages, promise: _promise, ...snapshot } = agent;
    return snapshot;
  }
}

export function parseApiSubagentToolArguments(
  value: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: "Tool arguments must be an object." };
  return { ok: true, value: value as Record<string, unknown> };
}
