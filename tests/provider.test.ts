import { expect, test } from "bun:test";
import { callProvider, providerURL } from "../src/provider.ts";
import type { Config, ResolvedRoute } from "../src/types.ts";

const route: ResolvedRoute = { id: "claude", provider: "anthropic", model: "claude-3-7", capability: { display_name: "Claude", enabled: true, tool_call_support: true, streaming_support: true, image_input_support: true, file_input_support: false, max_context: 1000, max_output: 100 } };
const config: Config = { port: 9999, providers: { anthropic: { base_url: "https://api.anthropic.com", api_key: "secret", adapter: "anthropic" } }, routes: {}, alias_routes: {}, models: {}, effort: {} };

test("Anthropic providers use Messages URL, auth, and body shape", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => { captured = { url: String(input), init }; return new Response("{}", { status: 200 }); }) as typeof fetch;
  try {
    expect(providerURL(config, route)).toBe("https://api.anthropic.com/v1/messages");
    await callProvider(config, route, { model: "claude-3-7", messages: [{ role: "user", content: "hello" }], stream: false });
    expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
    expect((captured?.init?.headers as Record<string, string>)["x-api-key"]).toBe("secret");
    expect(JSON.parse(String(captured?.init?.body))).toMatchObject({ model: "claude-3-7", messages: [{ role: "user", content: "hello" }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
