interface TrueoxChatMessage {
  role: string;
  content: string;
}

interface TrueoxChatPayload {
  messages: TrueoxChatMessage[];
  provider: string;
  model?: string;
}

interface TrueoxSettings {
  [key: string]: string | undefined;
}

interface TrueoxPacket {
  step?: string;
  response?: string;
  text?: string;
  done?: boolean;
  error?: string;
  action_start?: { name: string; arguments?: Record<string, unknown> };
  action_complete?: { name: string; result?: unknown };
}

namespace TrueoxAPI {
  const baseURL = "http://localhost:8000";

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(baseURL + path, init);
    if (!response.ok) {
      throw new Error(`Trueox request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  export async function checkConnection(): Promise<boolean> {
    try {
      const response = await fetch(baseURL + "/api/tools");
      return response.ok;
    } catch {
      return false;
    }
  }

  export function loadSettings(): Promise<TrueoxSettings> {
    return request<TrueoxSettings>("/api/settings");
  }

  export function saveSettings(settings: TrueoxSettings): Promise<unknown> {
    return request<unknown>("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  export function execute(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result?: unknown; [key: string]: unknown }> {
    return request<{ result?: unknown; [key: string]: unknown }>("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: toolName, arguments: args }),
    });
  }

  export async function streamChat(
    payload: TrueoxChatPayload,
    onPacket: (packet: TrueoxPacket) => void,
  ): Promise<void> {
    const response = await fetch(baseURL + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Trueox chat failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        onPacket(JSON.parse(line) as TrueoxPacket);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      onPacket(JSON.parse(buffer) as TrueoxPacket);
    }
  }
}
