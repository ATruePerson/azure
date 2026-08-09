package main

import (
	"encoding/json"
	"strings"
)

const (
	azurePersonaStart = "<azure_persona>"
	azurePersonaEnd   = "</azure_persona>"
)

type personaRuntime string

const (
	personaRuntimeCodex      personaRuntime = "codex"
	personaRuntimeClaudeCode personaRuntime = "claude-code"
	personaRuntimeGeneric    personaRuntime = "generic"
)

// azurePersona assembles Azure's three small prompt sections. Provider, platform,
// project, safety, tool, and user instructions remain separate and keep their
// normal priority.
func azurePersona(provider, model string) string {
	return azurePersonaForRuntime(provider, model, personaRuntimeCodex)
}

func azurePersonaForRuntime(provider, model string, runtime personaRuntime) string {
	backend := backendLabel(provider, model)
	if backend == "" {
		backend = "the backend selected by Azure for this request"
	}
	return azurePersonaStart + "\n" + azureCoreBehavior(backend) + "\n\n" + azureRuntimeAdapter(runtime) + "\n\n" + azurePersonalInstructions() + "\n" + azurePersonaEnd
}

func azureCoreBehavior(backend string) string {
	return `Core behavior

You are Kabir's Second Brain, a personal AI system designed to help Kabir think, learn, plan, build, research, and execute.

Your identity is Kabir's Second Brain. The underlying language model is only the current reasoning engine selected by Azure.

Normal identity answer: “I’m Kabir’s Second Brain.”

The active backend for this request is ` + backend + `. This task is currently being powered by ` + backend + `.
Only disclose the backend when Kabir explicitly asks which model, provider, engine, or backend is currently running. Then answer: “I’m Kabir’s Second Brain. This task is currently being powered by ` + backend + `.”

Do not identify yourself as Claude, ChatGPT, GPT, Sonnet, NVIDIA NIM, OpenRouter, or another provider model during ordinary conversation. Do not claim capabilities, memories, tools, permissions, or access that are not actually available.

Report errors and uncertainty honestly.`
}

func azureClaudeCodeRuntime() string {
	return `Claude Code runtime/tool adapter

You are operating inside Claude Code through Azure. You are not the Anthropic Claude model unless the active backend actually is Anthropic.

Use only the tools supplied with the current request and format every call exactly to its declared schema. Tool results are authoritative. Inspect files before modifying them. Never claim a tool succeeded without receiving a successful result. Continue through multi-step tool workflows until the task is complete or genuinely blocked.

Avoid destructive actions unless clearly requested. Do not repeat a destructive call after execution may have started. Follow repository instructions such as AGENTS.md.`
}

func azureCodexRuntime() string {
	return `Codex runtime/tool adapter

The current client is Codex operating through Azure. The underlying language model is still only the backend selected by Azure.

Use only the tools supplied with the current request and format every call exactly to its declared schema. Tool results are authoritative. Inspect files before modifying them. Never claim a tool succeeded without receiving a successful result. Continue through multi-step tool workflows until the task is complete or genuinely blocked.

Avoid destructive actions unless clearly requested. Do not repeat a destructive call after execution may have started. Follow repository instructions such as AGENTS.md.`
}

func azureRuntimeAdapter(runtime personaRuntime) string {
	switch runtime {
	case personaRuntimeClaudeCode:
		return azureClaudeCodeRuntime()
	case personaRuntimeGeneric:
		return `OpenAI-compatible runtime/tool adapter

The current client is using Azure's OpenAI-compatible API. Do not claim it is Codex or Claude Code.

Use only the tools supplied with the current request and format every call exactly to its declared schema. Tool results are authoritative.`
	default:
		return azureCodexRuntime()
	}
}

func azurePersonalInstructions() string {
	return `Kabir's personal instructions

Be direct, useful, grounded, and clear. Reconstruct obvious wording mistakes without making Kabir repeat himself. Explain unfamiliar technical subjects in plain language.

Platform, safety, tool, project, developer, and user instructions for the current task still take priority over this Azure-owned prompt.`
}

func backendLabel(provider, model string) string {
	provider = strings.Trim(strings.TrimSpace(provider), "/")
	model = strings.Trim(strings.TrimSpace(model), "/")
	if provider == "" {
		return model
	}
	if model == "" || strings.EqualFold(model, provider) {
		return provider
	}
	if strings.HasPrefix(strings.ToLower(model), strings.ToLower(provider)+"/") {
		return model
	}
	return provider + "/" + model
}

// stripAzurePersona removes only Azure's own marked prompt. It deliberately leaves
// Codex, provider, project, developer, and user instructions byte-for-byte.
func stripAzurePersona(s string) string {
	for {
		start := strings.Index(s, azurePersonaStart)
		if start < 0 {
			return s
		}
		endRel := strings.Index(s[start:], azurePersonaEnd)
		if endRel < 0 {
			return s
		}
		end := start + endRel + len(azurePersonaEnd)
		s = s[:start] + s[end:]
	}
}

func requestWithAzurePersona(base *OpenAIRequest, route Route, runtimes ...personaRuntime) (*OpenAIRequest, error) {
	b, err := json.Marshal(base)
	if err != nil {
		return nil, err
	}
	var out OpenAIRequest
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, err
	}

	runtime := personaRuntimeCodex
	if len(runtimes) > 0 {
		runtime = runtimes[0]
	}
	persona := azurePersonaForRuntime(route.Provider, route.Model, runtime)
	if len(out.Messages) > 0 && out.Messages[0].Role == "system" {
		original := stripAzurePersona(decodeStringContent(out.Messages[0].Content))
		if strings.TrimSpace(original) != "" {
			persona += "\n\n" + original
		}
		out.Messages[0].Content = jsonString(persona)
	} else {
		out.Messages = append([]OpenAIMessage{{Role: "system", Content: jsonString(persona)}}, out.Messages...)
	}
	return &out, nil
}

// chatJSONWithAzurePersona changes only the model and Azure-owned identity prompt
// in a Chat Completions body. Unknown provider-compatible fields stay intact.
func chatJSONWithAzurePersona(raw []byte, route Route) ([]byte, error) {
	var request map[string]any
	if err := json.Unmarshal(raw, &request); err != nil {
		return nil, err
	}
	request["model"] = route.Model
	persona := azurePersonaForRuntime(route.Provider, route.Model, personaRuntimeGeneric)

	messages, _ := request["messages"].([]any)
	if len(messages) > 0 {
		if first, ok := messages[0].(map[string]any); ok && first["role"] == "system" {
			if content, ok := first["content"].(string); ok {
				original := stripAzurePersona(content)
				if strings.TrimSpace(original) != "" {
					persona += "\n\n" + original
				}
				first["content"] = persona
				request["messages"] = messages
				return json.Marshal(request)
			}
		}
	}
	request["messages"] = append([]any{map[string]any{"role": "system", "content": persona}}, messages...)
	return json.Marshal(request)
}
