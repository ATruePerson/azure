import { expect, test } from "bun:test";
import { anthropicStream, anthropicToChat, chatToAnthropic, chatToResponses, responsesStream, responsesToChat } from "../src/protocol.ts";
import type { ResolvedRoute } from "../src/types.ts";

const route: ResolvedRoute = { id: "test", provider: "test", model: "provider-model", capability: { display_name: "Test", enabled: true, tool_call_support: true, streaming_support: true, image_input_support: true, file_input_support: false, max_context: 1000, max_output: 100 } };

test("translates Anthropic tool results before user content", () => {
  const body = anthropicToChat({ model: "test", stream: false, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "done" }, { type: "text", text: "continue" }] }] }, route, "be concise");
  expect(body.messages[0]).toEqual({ role: "system", content: "be concise" });
  expect(body.messages[1]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
  expect(body.messages[2]).toMatchObject({ role: "user", content: "continue" });
});

test("translates Responses input and tool output", () => {
  const body = responsesToChat({ model: "test", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }, { type: "function_call", call_id: "call-1", name: "search", arguments: "{\"q\":\"x\"}" }, { type: "function_call_output", call_id: "call-1", output: "ok" }] }, route);
  expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }, { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "search", arguments: "{\"q\":\"x\"}" } }] }, { role: "tool", tool_call_id: "call-1", content: "ok" }]);
  expect(body.messages[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call-1" }] });
  expect(body.stream).toBe(false);
});

test("maps provider tool calls to both client response shapes", () => {
  const payload = { choices: [{ message: { content: "done", tool_calls: [{ id: "call-1", function: { name: "search", arguments: '{"q":"x"}' } }] } }], usage: { prompt_tokens: 2, completion_tokens: 3 } };
  expect((chatToAnthropic(payload, "test").content as any[])[1]).toMatchObject({ type: "tool_use", id: "call-1" });
  expect((chatToResponses(payload, "test").output as any[])[1]).toMatchObject({ type: "function_call", call_id: "call-1" });
});

test("route policy can disable tool forwarding", () => {
  const disabled = { ...route, toolcalling: false };
  const body = anthropicToChat({ model: "test", stream: false, tools: [{ name: "search", input_schema: { type: "object" } }], messages: [{ role: "user", content: "hello" }] }, disabled);
  expect(body.tools).toBeUndefined();
});

test("keeps stream lifecycle events for Claude and Codex", async () => {
  const upstream = new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  const anthropic = await (await anthropicStream(upstream.clone(), "test")).text();
  expect(anthropic).toContain("content_block_start");
  expect(anthropic).toContain("text_delta");
  const responses = await (await responsesStream(upstream, "test")).text();
  expect(responses).toContain("response.created");
  expect(responses).toContain("response.output_text.done");
  expect(responses).toContain("response.completed");
});

test("keeps streamed tool calls visible to Claude", async () => {
  const upstream = new Response('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"search","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  const output = await (await anthropicStream(upstream, "test")).text();
  expect(output).toContain('"type":"tool_use"');
  expect(output).toContain("input_json_delta");
  expect(output).toContain('"stop_reason":"tool_use"');
});
