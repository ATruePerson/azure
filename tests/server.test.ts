import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config.ts";
import { createAzureFetch } from "../src/server.ts";

test("loopback app exposes health, models, and status without provider calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-server-"));
  await Bun.write(`${root}/config.json`, JSON.stringify({ port: 9999, providers: { test: { base_url: "https://provider.test" } }, models: { fast: { display_name: "Fast", provider: "test", model: "fast", enabled: true, tool_call_support: true, streaming_support: true, image_input_support: false, file_input_support: false, max_context: 1000, max_output: 100 } } }));
  const fetchApp = createAzureFetch(new ConfigStore(root));
  expect(await (await fetchApp(new Request("http://127.0.0.1/health"))).text()).toBe("azure ok");
  expect((await (await fetchApp(new Request("http://127.0.0.1/v1/models"))).json() as any).data[0].id).toBe("fast");
  expect((await fetchApp(new Request("http://127.0.0.1/app"))).headers.get("content-type")).toContain("text/html");
});

test("serves Anthropic, Chat, and Responses protocol boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "azure-protocol-"));
  await Bun.write(`${root}/config.json`, JSON.stringify({ port: 9999, system_prepend: "system", providers: { test: { base_url: "https://provider.test/v1" } }, alias_routes: { sonnet: { provider: "test", model: "upstream" } }, models: {} }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    const payload = { choices: [{ message: { content: `reply:${request.messages.at(-1).content}` }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const fetchApp = createAzureFetch(new ConfigStore(root));
    const message = await (await fetchApp(new Request("http://127.0.0.1/v1/messages", { method: "POST", body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hello" }] }) }))).json() as any;
    expect(message.content[0].text).toContain("hello");
    const chat = await (await fetchApp(new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hello" }] }) }))).json() as any;
    expect(chat.choices[0].message.content).toContain("hello");
    const response = await (await fetchApp(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: JSON.stringify({ model: "sonnet", input: "hello", stream: false }) }))).json() as any;
    expect(response.output[0].content[0].text).toContain("hello");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
