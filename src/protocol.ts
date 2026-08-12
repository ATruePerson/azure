import type { AnthropicRequest, ChatMessage, ChatRequest, ResponsesRequest, ResolvedRoute } from "./types.ts";
import { resolveEffort } from "./config.ts";

const asRecord = (value: unknown): Record<string, any> => (value && typeof value === "object" ? value as Record<string, any> : {});
const textOf = (value: unknown): string => typeof value === "string" ? value : asRecord(value).text || "";
const messageText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => textOf(part)).filter(Boolean).join("") : textOf(value);

function imagePart(block: Record<string, any>): Record<string, unknown> | undefined {
  const source = asRecord(block.source);
  if (source.type === "base64" && source.media_type && source.data) return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  if (source.type === "url" && source.url) return { type: "image_url", image_url: { url: source.url } };
  return undefined;
}

function anthropicContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: unknown[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (block.type === "text") parts.push({ type: "text", text: textOf(block) });
    if (block.type === "thinking") parts.push({ type: "thinking", thinking: String(block.thinking || ""), signature: block.signature || "" });
    if (block.type === "image") {
      const part = imagePart(block);
      if (part) parts.push(part);
    }
  }
  return parts.length === 1 && asRecord(parts[0]).type === "text" ? asRecord(parts[0]).text : parts;
}

function anthropicMessages(messages: AnthropicRequest["messages"]): ChatMessage[] {
  const output: ChatMessage[] = [];
  for (const message of messages) {
    const blocks = Array.isArray(message.content) ? message.content.map(asRecord) : [];
    const toolResults = blocks.filter((block) => block.type === "tool_result");
    for (const result of toolResults) {
      output.push({ role: "tool", tool_call_id: String(result.tool_use_id || ""), content: anthropicContent(result.content) });
    }
    const toolUses = blocks.filter((block) => block.type === "tool_use");
    const regular = blocks.filter((block) => !["tool_result", "tool_use"].includes(block.type));
    if (message.role === "assistant" && toolUses.length) {
      output.push({
        role: "assistant",
        content: regular.length ? anthropicContent(regular) : null,
        tool_calls: toolUses.map((tool) => ({ id: String(tool.id), type: "function", function: { name: String(tool.name), arguments: JSON.stringify(tool.input || {}) } })),
      });
    } else if (regular.length || !toolResults.length) {
      output.push({ role: message.role, content: regular.length ? anthropicContent(regular) : anthropicContent(message.content) });
    }
  }
  return output;
}

function systemText(system: AnthropicRequest["system"]): string {
  if (typeof system === "string") return system;
  return (system || []).map((block) => textOf(block)).filter(Boolean).join("\n\n");
}

export function chatToAnthropicRequest(request: ChatRequest): Record<string, unknown> {
  const anthropicContent = (content: unknown): unknown => {
    if (typeof content === "string" || content === null || content === undefined) return content ?? "";
    if (!Array.isArray(content)) return content;
    return content.map((part) => {
      const value = asRecord(part);
      if (value.type === "text") return { type: "text", text: textOf(value) };
      if (value.type === "image_url") {
        const url = String(asRecord(value.image_url).url || "");
        if (url.startsWith("data:")) {
          const match = url.match(/^data:([^;]+);base64,(.*)$/s);
          if (match) return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
        }
        if (url) return { type: "image", source: { type: "url", url } };
      }
      if (value.type === "thinking") return { type: "thinking", thinking: String(value.thinking || ""), signature: value.signature || "" };
      if (value.type === "file") {
        const file = asRecord(value.file);
        if (file.file_data) return { type: "document", source: { type: "base64", media_type: String(file.media_type || "application/octet-stream"), data: String(file.file_data) } };
        if (file.file_url) return { type: "document", source: { type: "url", url: String(file.file_url) } };
      }
      return value;
    });
  };
  const system = request.messages.filter((message) => message.role === "system").map((message) => messageText(message.content)).filter(Boolean).join("\n\n");
  const messages = request.messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id || "", content: messageText(message.content) }] };
    if (message.role === "assistant" && message.tool_calls?.length) {
      const content: unknown[] = [];
      const text = messageText(message.content);
      if (text) content.push({ type: "text", text });
      for (const call of message.tool_calls) {
        let input: unknown = {};
        try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = { raw_arguments: call.function.arguments || "" }; }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      return { role: "assistant", content };
    }
    return { role: message.role, content: anthropicContent(message.content) };
  });
  const tools = request.tools?.map((tool: any) => tool.type === "function" && tool.function ? { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters || {} } : { name: tool.name, description: tool.description, input_schema: tool.input_schema || tool.parameters || {} });
  const body: Record<string, unknown> = { model: request.model, messages, max_tokens: request.max_tokens || 4096, stream: request.stream ?? false };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  return body;
}

export function anthropicToChatResponse(payload: any): Record<string, unknown> {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  const text = content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text || "")).join("");
  const reasoning = content.filter((part: any) => part?.type === "thinking").map((part: any) => String(part.thinking || "")).join("");
  const toolCalls = content.filter((part: any) => part?.type === "tool_use").map((part: any) => ({ id: String(part.id || ""), type: "function", function: { name: String(part.name || ""), arguments: JSON.stringify(part.input || {}) } }));
  const message: Record<string, unknown> = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { id: payload?.id || `chatcmpl_${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: payload?.model, choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : payload?.stop_reason === "max_tokens" ? "length" : "stop" }], usage: { prompt_tokens: payload?.usage?.input_tokens || 0, completion_tokens: payload?.usage?.output_tokens || 0, total_tokens: (payload?.usage?.input_tokens || 0) + (payload?.usage?.output_tokens || 0) } };
}

export function anthropicToChat(request: AnthropicRequest, route: ResolvedRoute, globalSystem = ""): ChatRequest {
  const system = [globalSystem.trim(), systemText(request.system).trim()].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push(...anthropicMessages(request.messages));
  const body: ChatRequest = {
    model: route.model,
    messages,
    max_tokens: request.max_tokens ?? route.max_tokens,
    stream: request.stream ?? route.stream ?? false,
    tools: route.toolcalling === false ? undefined : request.tools?.map((tool: any) => tool.type === "function" ? tool : { type: "function", function: tool.input_schema ? { name: tool.name, description: tool.description, parameters: tool.input_schema } : tool }),
    temperature: request.temperature,
    top_p: request.top_p,
    ...route.extra_body,
    ...resolveEffort(route, request.thinking?.type === "enabled" ? "high" : undefined),
  };
  if (!body.tools?.length) delete body.tools;
  if (body.temperature === undefined) delete body.temperature;
  if (body.top_p === undefined) delete body.top_p;
  return body;
}

function responseInputToMessages(input: ResponsesRequest["input"]): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const result: ChatMessage[] = [];
  for (const raw of input || []) {
    const item = asRecord(raw);
    if (item.type === "function_call_output") {
      result.push({ role: "tool", tool_call_id: String(item.call_id || item.id || ""), content: item.output ?? "" });
      continue;
    }
    if (item.type === "function_call") {
      result.push({ role: "assistant", content: null, tool_calls: [{ id: String(item.call_id || item.id || ""), type: "function", function: { name: String(item.name || ""), arguments: String(item.arguments || "{}") } }] });
      continue;
    }
    const role = item.role === "developer" ? "system" : item.role;
    if (!["system", "user", "assistant"].includes(role)) continue;
    const content = Array.isArray(item.content) ? item.content.map((part) => {
      const p = asRecord(part);
      if (p.type === "input_text" || p.type === "output_text") return { type: "text", text: p.text || "" };
      if (p.type === "input_image" && p.image_url) return { type: "image_url", image_url: { url: typeof p.image_url === "string" ? p.image_url : asRecord(p.image_url).url } };
      if (p.type === "input_file" && (p.file_url || p.file_data)) return { type: "file", file: { file_data: p.file_data, file_url: p.file_url } };
      return p;
    }) : item.content ?? "";
    result.push({ role, content });
  }
  return result;
}

export function responsesToChat(request: ResponsesRequest, route: ResolvedRoute, globalSystem = ""): ChatRequest {
  const messages = responseInputToMessages(request.input);
  const system = [globalSystem.trim(), (request.instructions || "").trim()].filter(Boolean).join("\n\n");
  if (system && !messages.some((message) => message.role === "system")) messages.unshift({ role: "system", content: system });
  const body: ChatRequest = {
    model: route.model,
    messages,
    max_tokens: request.max_output_tokens ?? route.max_tokens,
    stream: request.stream ?? route.stream ?? false,
    tools: route.toolcalling === false ? undefined : request.tools?.map((tool: any) => tool.type === "function" && tool.function ? tool : { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters || tool.input_schema } }),
    temperature: request.temperature,
    top_p: request.top_p,
    ...route.extra_body,
    ...resolveEffort(route, request.reasoning?.effort),
  };
  if (!body.tools?.length) delete body.tools;
  if (body.temperature === undefined) delete body.temperature;
  if (body.top_p === undefined) delete body.top_p;
  return body;
}

export function chatToAnthropic(payload: any, model: string): Record<string, unknown> {
  const message = asRecord(payload?.choices?.[0]?.message);
  const content: unknown[] = [];
  const reasoning = textOf(message.reasoning_content || message.reasoning);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (message.content) content.push({ type: "text", text: messageText(message.content) });
  for (const call of message.tool_calls || []) {
    let input: unknown = {};
    try { input = JSON.parse(call.function?.arguments || "{}"); } catch { input = { raw_arguments: call.function?.arguments || "" }; }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content, stop_reason: message.tool_calls?.length ? "tool_use" : payload?.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn", stop_sequence: null, usage: { input_tokens: payload?.usage?.prompt_tokens || 0, output_tokens: payload?.usage?.completion_tokens || 0 } };
}

export function chatToResponses(payload: any, model: string): Record<string, unknown> {
  const message = asRecord(payload?.choices?.[0]?.message);
  const output: any[] = [];
  const text = messageText(message.content);
  const reasoning = textOf(message.reasoning_content || message.reasoning);
  if (reasoning) output.push({ type: "reasoning", id: `reasoning_${crypto.randomUUID()}`, status: "completed", summary: [{ type: "summary_text", text: reasoning }] });
  if (text || !(message.tool_calls || []).length) output.push({ type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
  for (const call of message.tool_calls || []) output.push({ type: "function_call", id: call.id, call_id: call.id, name: call.function?.name, arguments: call.function?.arguments || "{}", status: "completed" });
  return { id: `resp_${crypto.randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000), model, status: "completed", output, usage: { input_tokens: payload?.usage?.prompt_tokens || 0, output_tokens: payload?.usage?.completion_tokens || 0, total_tokens: (payload?.usage?.prompt_tokens || 0) + (payload?.usage?.completion_tokens || 0) } };
}

function sseEvent(event: string, data: unknown): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

export async function anthropicStream(response: Response, model: string): Promise<Response> {
  if (!response.body) return new Response("", { status: response.status });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let sentStart = false;
      let sentTextBlock = false;
      let sentStop = false;
      let textBlock: number | undefined;
      let thinkingBlock: number | undefined;
      const toolBlocks = new Map<number, { block: number; id: string }>();
      let nextBlock = 0;
      const enqueue = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseEvent(event, data)));
      const ensureStart = () => {
        if (sentStart) return;
        sentStart = true;
        enqueue("message_start", { type: "message_start", message: { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      };
      const closeBlocks = () => {
        if (textBlock !== undefined) enqueue("content_block_stop", { type: "content_block_stop", index: textBlock });
        if (thinkingBlock !== undefined) enqueue("content_block_stop", { type: "content_block_stop", index: thinkingBlock });
        for (const { block } of toolBlocks.values()) enqueue("content_block_stop", { type: "content_block_stop", index: block });
      };
      const process = (line: string) => {
        if (!line.startsWith("data:")) return;
        const text = line.slice(5).trim();
        if (!text || text === "[DONE]") return;
        let chunk: any;
        try { chunk = JSON.parse(text); } catch { return; }
        const delta = asRecord(chunk.choices?.[0]?.delta);
        const textDelta = textOf(delta.content);
        const reasoningDelta = textOf(delta.reasoning_content || delta.reasoning);
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        if (textDelta) {
          ensureStart();
          if (!sentTextBlock) {
            sentTextBlock = true;
            textBlock = nextBlock++;
            enqueue("content_block_start", { type: "content_block_start", index: textBlock, content_block: { type: "text", text: "" } });
          }
          enqueue("content_block_delta", { type: "content_block_delta", index: textBlock, delta: { type: "text_delta", text: textDelta } });
        }
        if (reasoningDelta) {
          ensureStart();
          if (thinkingBlock === undefined) {
            thinkingBlock = nextBlock++;
            enqueue("content_block_start", { type: "content_block_start", index: thinkingBlock, content_block: { type: "thinking", thinking: "" } });
          }
          enqueue("content_block_delta", { type: "content_block_delta", index: thinkingBlock, delta: { type: "thinking_delta", thinking: reasoningDelta } });
        }
        for (const call of toolCalls) {
          ensureStart();
          const index = Number(call.index || 0);
          let tool = toolBlocks.get(index);
          if (!tool) {
            tool = { block: nextBlock++, id: String(call.id || `tool_${index}`) };
            toolBlocks.set(index, tool);
            enqueue("content_block_start", { type: "content_block_start", index: tool.block, content_block: { type: "tool_use", id: tool.id, name: call.function?.name || "", input: {} } });
          }
          const partial = call.function?.arguments;
          if (partial) enqueue("content_block_delta", { type: "content_block_delta", index: tool.block, delta: { type: "input_json_delta", partial_json: partial } });
        }
        const finish = chunk.choices?.[0]?.finish_reason;
        if (finish && !sentStop) {
          ensureStart();
          closeBlocks();
          sentStop = true;
          enqueue("message_delta", { type: "message_delta", delta: { stop_reason: finish === "tool_calls" ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: chunk.usage?.completion_tokens || 0 } });
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) process(buffer);
          ensureStart();
          if (!sentStop) {
            closeBlocks();
            enqueue("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
          }
          enqueue("message_stop", { type: "message_stop" });
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) process(line);
      }
    },
  });
  return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

export async function responsesStream(response: Response, model: string): Promise<Response> {
  if (!response.body) return new Response("", { status: response.status });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      const id = `resp_${crypto.randomUUID()}`;
      let text = "";
      const tools = new Map<number, { id: string; callId: string; name: string; arguments: string }>();
      const emit = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      emit("response.created", { type: "response.created", response: { id, object: "response", model, status: "in_progress", output: [] } });
      const process = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let chunk: any; try { chunk = JSON.parse(data); } catch { return; }
        const deltaObject = asRecord(chunk.choices?.[0]?.delta);
        const delta = textOf(deltaObject.content);
        const reasoning = textOf(deltaObject.reasoning_content || deltaObject.reasoning);
        if (delta) {
          text += delta;
          emit("response.output_text.delta", { type: "response.output_text.delta", item_id: `${id}_msg`, output_index: 0, content_index: 0, delta, response: { id, object: "response", model } });
        }
        if (reasoning) emit("response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: `${id}_reasoning`, output_index: 0, summary_index: 0, delta: reasoning });
        for (const call of Array.isArray(deltaObject.tool_calls) ? deltaObject.tool_calls : []) {
          const index = Number(call.index || 0);
          let tool = tools.get(index);
          if (!tool) {
            tool = { id: String(call.id || `fc_${crypto.randomUUID()}`), callId: String(call.id || `call_${crypto.randomUUID()}`), name: String(call.function?.name || ""), arguments: "" };
            tools.set(index, tool);
            emit("response.output_item.added", { type: "response.output_item.added", output_index: index + 1, item: { type: "function_call", id: tool.id, call_id: tool.callId, name: tool.name, arguments: "", status: "in_progress" } });
          }
          const partial = String(call.function?.arguments || "");
          if (partial) {
            tool.arguments += partial;
            emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: tool.id, output_index: index + 1, call_id: tool.callId, delta: partial });
          }
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) process(buffer);
          emit("response.output_text.done", { type: "response.output_text.done", item_id: `${id}_msg`, output_index: 0, content_index: 0, text });
          for (const [index, call] of tools) {
            emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: call.id, output_index: index + 1, call_id: call.callId, name: call.name, arguments: call.arguments });
            emit("response.output_item.done", { type: "response.output_item.done", output_index: index + 1, item: { type: "function_call", id: call.id, call_id: call.callId, name: call.name, arguments: call.arguments, status: "completed" } });
          }
          emit("response.completed", { type: "response.completed", response: { id, object: "response", model, status: "completed" } });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) process(line);
      }
    },
  });
  return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
