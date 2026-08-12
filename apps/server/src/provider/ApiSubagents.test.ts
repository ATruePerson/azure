// @effect-diagnostics globalTimers:off
import { describe, expect, it } from "vite-plus/test";
import { ApiSubagentController, parseApiSubagentToolArguments } from "./ApiSubagents.ts";

describe("API subagents", () => {
  it("runs direct children concurrently and enforces four total agents", async () => {
    const controller = new ApiSubagentController(async ({ task, signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (signal.aborted) throw new Error("cancelled");
      return `done: ${task}`;
    });
    const first = controller.spawn({ task: "one" });
    const second = controller.spawn({ task: "two" });
    controller.spawn({ task: "three" });
    expect(() => controller.spawn({ task: "four" })).toThrow("concurrency");
    await expect(controller.wait([first.id, second.id])).resolves.toMatchObject([
      { state: "completed" },
      { state: "completed" },
    ]);
  });

  it("cancels children and rejects malformed tool arguments", async () => {
    const controller = new ApiSubagentController(async ({ signal }) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw new Error("cancelled");
      return "done";
    });
    const child = controller.spawn({ task: "cancel me" });
    controller.stop(child.id);
    await expect(controller.wait([child.id])).resolves.toMatchObject([{ state: "cancelled" }]);
    expect(parseApiSubagentToolArguments("bad")).toEqual({
      ok: false,
      error: "Tool arguments must be an object.",
    });
  });
});
