"use strict";
var TrueoxAPI;
(function (TrueoxAPI) {
    const baseURL = "http://localhost:8000";
    async function request(path, init) {
        const response = await fetch(baseURL + path, init);
        if (!response.ok) {
            throw new Error(`Trueox request failed: ${response.status}`);
        }
        return response.json();
    }
    async function checkConnection() {
        try {
            const response = await fetch(baseURL + "/api/tools");
            return response.ok;
        }
        catch {
            return false;
        }
    }
    TrueoxAPI.checkConnection = checkConnection;
    function loadSettings() {
        return request("/api/settings");
    }
    TrueoxAPI.loadSettings = loadSettings;
    function saveSettings(settings) {
        return request("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
        });
    }
    TrueoxAPI.saveSettings = saveSettings;
    function execute(toolName, args) {
        return request("/api/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool_name: toolName, arguments: args }),
        });
    }
    TrueoxAPI.execute = execute;
    async function streamChat(payload, onPacket) {
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
                if (!line.trim())
                    continue;
                onPacket(JSON.parse(line));
            }
            if (done)
                break;
        }
        if (buffer.trim()) {
            onPacket(JSON.parse(buffer));
        }
    }
    TrueoxAPI.streamChat = streamChat;
})(TrueoxAPI || (TrueoxAPI = {}));
