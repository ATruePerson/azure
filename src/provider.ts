import type { ChatRequest, Config, ResolvedRoute } from "./types.ts";
import { anthropicToChatResponse, chatToAnthropicRequest } from "./protocol.ts";

function provider(config: Config, route: ResolvedRoute) {
  const value = config.providers[route.provider];
  if (!value) throw new Error(`unknown provider: ${route.provider}`);
  return value;
}

function adapter(config: Config, route: ResolvedRoute): string {
  return (provider(config, route).adapter || "openai").toLowerCase();
}

export function providerURL(config: Config, route: ResolvedRoute): string {
  const base = provider(config, route).base_url.replace(/\/$/, "");
  if (adapter(config, route) === "anthropic") return /\/messages$/.test(base) ? base : `${base.endsWith("/v1") ? base : `${base}/v1`}/messages`;
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

function boundedSignal(parent: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  parent?.addEventListener("abort", () => controller.abort(), { once: true });
  return controller.signal;
}

export async function callProvider(config: Config, route: ResolvedRoute, body: ChatRequest, signal?: AbortSignal): Promise<Response> {
  const current = provider(config, route);
  const isAnthropic = adapter(config, route) === "anthropic";
  const requestBody = isAnthropic ? chatToAnthropicRequest(body) : body;
  const headers: Record<string, string> = { "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" };
  if (current.api_key) {
    if (isAnthropic) headers["x-api-key"] = current.api_key;
    else headers.authorization = `Bearer ${current.api_key}`;
  }
  if (isAnthropic) headers["anthropic-version"] = "2023-06-01";
  return fetch(providerURL(config, route), { method: "POST", headers, body: JSON.stringify(requestBody), signal: boundedSignal(signal, 120_000) });
}

export async function providerPayload(config: Config, route: ResolvedRoute, response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json() as Record<string, unknown>;
  return adapter(config, route) === "anthropic" ? anthropicToChatResponse(payload) : payload;
}

export function providerStream(config: Config, route: ResolvedRoute, response: Response): Response {
  return adapter(config, route) === "anthropic" ? anthropicProviderStream(response, route.model) : response;
}

function sse(data: unknown): Uint8Array { return new TextEncoder().encode(`data: ${data === "[DONE]" ? "[DONE]" : JSON.stringify(data)}\n\n`); }

function anthropicProviderStream(response: Response, model: string): Response {
  if (!response.body) return new Response("", { status: response.status });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      const tools = new Map<number, { id: string; name: string }>();
      const emit = (data: unknown) => controller.enqueue(sse(data));
      const process = (line: string) => {
        if (!line.startsWith("data:")) return;
        let event: any; try { event = JSON.parse(line.slice(5).trim()); } catch { return; }
        if (event.type === "message_start") {
          emit({ id: event.message?.id || `chatcmpl_${crypto.randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        } else if (event.type === "content_block_start") {
          const block = event.content_block || {};
          if (block.type === "tool_use") {
            const index = Number(event.index || 0);
            tools.set(index, { id: String(block.id || `tool_${index}`), name: String(block.name || "") });
            emit({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: tools.get(index)?.id, type: "function", function: { name: tools.get(index)?.name, arguments: "" } }] }, finish_reason: null }] });
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta || {};
          if (delta.type === "text_delta") {
            emit({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: delta.text || "" }, finish_reason: null }] });
          } else if (delta.type === "input_json_delta") {
            const index = Number(event.index || 0);
            emit({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: tools.get(index)?.id, type: "function", function: { arguments: delta.partial_json || "" } }] }, finish_reason: null }] });
          } else if (delta.type === "thinking_delta") {
            emit({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { reasoning_content: delta.thinking || "" }, finish_reason: null }] });
          }
        } else if (event.type === "message_delta") {
          const reason = event.delta?.stop_reason === "tool_use" ? "tool_calls" : event.delta?.stop_reason === "max_tokens" ? "length" : "stop";
          emit({ object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: event.usage });
        } else if (event.type === "message_stop") emit("[DONE]");
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) { if (buffer) process(buffer); emit("[DONE]"); controller.close(); return; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
        for (const line of lines) process(line);
      }
    },
  });
  return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

export function errorResponse(response: Response): Response {
  return new Response(JSON.stringify({ error: { type: "upstream_error", message: `provider returned HTTP ${response.status}` } }), { status: response.status, headers: { "content-type": "application/json" } });
}
