export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Provider = {
  base_url: string;
  api_key?: string;
  adapter?: string;
};

export type ReasoningTarget = {
  effort?: string;
  extra_body?: Record<string, Json>;
};

export type Route = {
  provider: string;
  model: string;
  reasoning_effort?: string;
  reasoning_locked?: boolean;
  max_tokens?: number;
  max_context?: number;
  stream?: boolean;
  extra_body?: Record<string, Json>;
  reasoning?: Record<string, ReasoningTarget>;
  toolcalling?: boolean;
};

export type ModelCapability = {
  display_name: string;
  description?: string;
  catalog_priority?: number;
  catalog_visible?: boolean;
  route?: string;
  provider?: string;
  model?: string;
  reasoning?: Record<string, ReasoningTarget>;
  tool_call_support: boolean;
  streaming_support: boolean;
  image_input_support: boolean;
  file_input_support: boolean;
  max_context: number;
  max_output: number;
  enabled: boolean;
};

export type Config = {
  port: number;
  providers: Record<string, Provider>;
  routes: Record<string, Route>;
  alias_routes: Record<string, Route>;
  aliases?: Record<string, Route>;
  models: Record<string, ModelCapability>;
  effort?: Record<string, { budget: number; reasoning: string }>;
  system_prepend?: string;
};

export type ResolvedRoute = Route & {
  id: string;
  capability?: ModelCapability;
};

export type AnthropicRequest = {
  model: string;
  max_tokens?: number;
  system?: string | Array<{ type: string; text?: string }>;
  messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }>;
  stream?: boolean;
  tools?: unknown[];
  thinking?: { type: string; budget_tokens?: number };
  temperature?: number;
  top_p?: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
};

export type ResponsesRequest = {
  model: string;
  input: string | unknown[];
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  reasoning?: { effort?: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
};
