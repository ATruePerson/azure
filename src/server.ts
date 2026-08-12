import type { ConfigStore } from "./config.ts";
import { resolveEffort, resolveRoute } from "./config.ts";
import { callProvider, errorResponse, providerPayload, providerStream } from "./provider.ts";
import { anthropicStream, anthropicToChat, chatToAnthropic, chatToResponses, responsesStream, responsesToChat } from "./protocol.ts";
import type { AnthropicRequest, ChatRequest, ResponsesRequest } from "./types.ts";
import { AZURE_SEARCH_ICON } from "./mcp.ts";

const maxRequestBytes = 32 * 1024 * 1024;

function json(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
function bad(message: string, status = 400): Response { return json({ error: { type: "invalid_request_error", message } }, status); }
async function body(request: Request): Promise<Record<string, any>> {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxRequestBytes) throw new Error("request body exceeds 32 MiB");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new Error("request body must be valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be a JSON object");
  return value as Record<string, any>;
}
function hasImage(value: unknown): boolean { return JSON.stringify(value).includes('"image"') || JSON.stringify(value).includes('"input_image"'); }
function hasFile(value: unknown): boolean { return JSON.stringify(value).includes('"file"') || JSON.stringify(value).includes('"input_file"'); }
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "content-type, authorization, x-api-key, anthropic-version");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}

function statusPage(config: { port: number; providers: Record<string, unknown>; models: Record<string, unknown> }): Response {
  const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character] || character));
  const providerNames = Object.keys(config.providers).sort();
  const modelNames = Object.keys(config.models).sort();
  const routes = ["/health", "/v1/models", "/v1/messages", "/v1/chat/completions", "/v1/responses"];
  const html = `<!doctype html><meta charset="utf-8"><title>Azure</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:0;background:#07111f;color:#eaf2ff}main{max-width:760px;margin:8vh auto;padding:32px}img{width:52px;vertical-align:middle;margin-right:12px}h1{display:inline}section{background:#0d1d31;border:1px solid #1d3959;border-radius:16px;padding:18px;margin-top:20px}code{color:#9dcbff}</style><main><img src="${AZURE_SEARCH_ICON}" alt="Azure Search"><h1>Azure</h1><p>Healthy · loopback:${escape(String(config.port))}</p><section><strong>Providers</strong><p>${providerNames.map((name) => `<code>${escape(name)}</code>`).join(" · ") || "none"}</p></section><section><strong>Models</strong><p>${modelNames.map((name) => `<code>${escape(name)}</code>`).join("<br>") || "none"}</p></section><section><strong>Routes</strong><p>${routes.map((route) => `<code>${route}</code>`).join(" · ")}</p></section></main>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function createAzureFetch(store: ConfigStore): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
    try {
      const config = await store.get();
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET") return withCors(new Response("azure ok"));
      if (url.pathname === "/app" && request.method === "GET") return withCors(statusPage(config));
      if (url.pathname === "/v1/models" && request.method === "GET") {
        const data = Object.entries(config.models).filter(([, model]) => model.enabled).map(([id, model]) => ({ id, object: "model", created: 0, owned_by: model.display_name || "azure" }));
        return withCors(json({ object: "list", data }));
      }
      if (!["/v1/messages", "/v1/chat/completions", "/v1/responses"].includes(url.pathname)) return withCors(new Response("Not found", { status: 404 }));
      if (request.method !== "POST") return withCors(bad("POST is required", 405));
      const input = await body(request);
      const modelId = typeof input.model === "string" ? input.model : "";
      if (!modelId) return withCors(bad("model is required"));
      if (url.pathname === "/v1/messages" && !Array.isArray(input.messages)) return withCors(bad("messages must be an array"));
      if (url.pathname === "/v1/responses" && typeof input.input !== "string" && !Array.isArray(input.input)) return withCors(bad("input must be a string or array"));
      if (url.pathname === "/v1/chat/completions" && !Array.isArray(input.messages)) return withCors(bad("messages must be an array"));
      if (input.tools !== undefined && !Array.isArray(input.tools)) return withCors(bad("tools must be an array"));
      const route = resolveRoute(config, modelId);
      if (input.tools?.length && route.capability && !route.capability.tool_call_support) return withCors(bad(`model ${modelId} does not support tools`));
      if (input.tools?.length && route.toolcalling === false) return withCors(bad(`model ${modelId} does not support tools`));
      if (hasImage(input) && route.capability && !route.capability.image_input_support) return withCors(bad(`model ${modelId} does not support image input`));
      if (hasFile(input) && route.capability && !route.capability.file_input_support) return withCors(bad(`model ${modelId} does not support file input`));
      let chat: ChatRequest;
      if (url.pathname === "/v1/messages") chat = anthropicToChat(input as AnthropicRequest, route, config.system_prepend);
      else if (url.pathname === "/v1/responses") chat = responsesToChat(input as ResponsesRequest, route, config.system_prepend);
      else {
        chat = { ...(input as ChatRequest), model: route.model, max_tokens: input.max_tokens ?? route.max_tokens, stream: input.stream ?? route.stream ?? false, tools: route.toolcalling === false ? undefined : input.tools, ...route.extra_body, ...resolveEffort(route, input.reasoning_effort) };
      }
      if (chat.stream && route.capability && !route.capability.streaming_support) return withCors(bad(`model ${modelId} does not support streaming`));
      const upstream = await callProvider(config, route, chat, request.signal);
      if (!upstream.ok) return withCors(errorResponse(upstream));
      if (chat.stream) {
        const normalized = providerStream(config, route, upstream);
        const stream = url.pathname === "/v1/messages" ? await anthropicStream(normalized, modelId) : url.pathname === "/v1/responses" ? await responsesStream(normalized, modelId) : normalized;
        return withCors(stream);
      }
      const payload = await providerPayload(config, route, upstream);
      const result = url.pathname === "/v1/messages" ? chatToAnthropic(payload, modelId) : url.pathname === "/v1/responses" ? chatToResponses(payload, modelId) : payload;
      return withCors(json(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return withCors(bad(message, /required|must be|unknown model|disabled|missing|invalid|does not support/.test(message) ? 400 : 500));
    }
  };
}

export async function startServer(store: ConfigStore): Promise<ReturnType<typeof Bun.serve>> {
  const config = await store.get();
  const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: createAzureFetch(store) });
  console.error(`Azure listening on http://127.0.0.1:${server.port}`);
  return server;
}
