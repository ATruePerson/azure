"""ACC's dependency-free Claude Messages and Codex Responses gateway."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from typing import Any, Iterable


MAX_BODY = 32 << 20
ENV_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


class ProxyError(Exception):
    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None):
        super().__init__(message)
        self.status = status
        self.headers = headers or {}


def _load_json(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_text()
        raw = ENV_VAR.sub(lambda match: os.environ.get(match.group(1), ""), raw)
        return json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        raise ProxyError(500, f"config {path}: {error}") from error


def load_config(root: Path) -> dict[str, Any]:
    providers_path = root / "providers.json"
    claude_path = root / "claude" / "config.json"
    codex_path = root / "codex" / "config.json"
    if providers_path.exists():
        config = _load_json(providers_path)
        config["alias_routes"] = _load_json(claude_path).get("alias_routes", {}) if claude_path.exists() else {}
        config["codex_models"] = _load_json(codex_path).get("models", {}) if codex_path.exists() else {}
        config["claude_root"] = claude_path.parent
    else:
        config = _load_json(root / "config.json")
        config["claude_root"] = root
        config["codex_models"] = config.get("models", {})
    config["config_root"] = root
    if not config.get("providers"):
        raise ProxyError(500, "providers are missing")
    return config


def _model_id(value: str) -> str:
    value = value.lower().removeprefix("anthropic/").replace("_", "-")
    return value.removeprefix("claude-")


def resolve_route(model: str, config: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    normalized = _model_id(model)
    aliases = config["alias_routes"]
    for alias, route in aliases.items():
        key = _model_id(alias)
        if normalized == key or (
            key in {"fable", "opus", "sonnet", "haiku"}
            and normalized.startswith(key + "-")
            and normalized[len(key) + 1 : len(key) + 2].isdigit()
        ):
            return key, route
    raise ProxyError(400, f'unrecognized Claude model "{model}"')


def _prompt(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(
            block.get("text", "")
            for block in value
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


def _route_prompt(route: dict[str, Any], root: Path) -> str:
    value = str(route.get("system_prepend", "")).strip()
    if not value.startswith("@"):
        return value
    path = (root / value[1:]).resolve()
    try:
        path.relative_to(root.resolve())
        return path.read_text().strip()
    except (OSError, ValueError) as error:
        raise ProxyError(500, f"system_prepend {value}: {error}") from error


def _tool_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return json.dumps(content, separators=(",", ":"))


def _messages(messages: list[dict[str, Any]], provider: str) -> list[dict[str, Any]]:
    translated: list[dict[str, Any]] = []
    for message in messages:
        role, content = message.get("role", "user"), message.get("content", "")
        if isinstance(content, str):
            translated.append({"role": role, "content": content})
            continue

        parts: list[dict[str, Any]] = []
        tool_calls: list[dict[str, Any]] = []
        tool_results: list[dict[str, Any]] = []
        reasoning: list[str] = []
        for block in content if isinstance(content, list) else []:
            kind = block.get("type")
            if kind == "text":
                parts.append({"type": "text", "text": block.get("text", "")})
            elif kind == "image":
                source = block.get("source", {})
                if source.get("type") == "base64":
                    parts.append({
                        "type": "image_url",
                        "image_url": {"url": f'data:{source.get("media_type", "application/octet-stream")};base64,{source.get("data", "")}'},
                    })
                elif source.get("type") == "url":
                    parts.append({"type": "image_url", "image_url": {"url": source.get("url", "")}})
            elif kind == "thinking":
                reasoning.append(block.get("thinking", ""))
            elif kind == "tool_use":
                tool_id, _, signature = str(block.get("id", "")).partition("__thought__")
                function: dict[str, Any] = {
                    "name": block.get("name", ""),
                    "arguments": json.dumps(block.get("input", {}), separators=(",", ":")),
                }
                call: dict[str, Any] = {"id": tool_id, "type": "function", "function": function}
                if provider == "gemini":
                    call["extra_content"] = {"google": {"thought_signature": signature or "skip_thought_signature_validator"}}
                tool_calls.append(call)
            elif kind == "tool_result":
                tool_id = str(block.get("tool_use_id", "")).partition("__thought__")[0]
                text = _tool_text(block.get("content", ""))
                if block.get("is_error"):
                    text = "[tool error]\n" + text
                tool_results.append({"role": "tool", "tool_call_id": tool_id, "content": text})

        translated.extend(tool_results)
        if parts or tool_calls or reasoning:
            item: dict[str, Any] = {"role": role}
            if len(parts) == 1 and parts[0]["type"] == "text":
                item["content"] = parts[0]["text"]
            elif parts:
                item["content"] = parts
            if tool_calls:
                item["tool_calls"] = tool_calls
            if reasoning:
                item["reasoning_content"] = "\n".join(reasoning)
            translated.append(item)
    return translated


def _effort(request: dict[str, Any], route: dict[str, Any], config: dict[str, Any]) -> str:
    if route.get("reasoning_locked"):
        value = route.get("reasoning_effort", "")
    else:
        value = request.get("output_config", {}).get("effort", "")
        budget = request.get("thinking", {}).get("budget_tokens", 0)
        if not value and budget:
            eligible = [
                item for item in config.get("effort", {}).values()
                if item.get("budget", 0) <= budget
            ]
            if eligible:
                value = max(eligible, key=lambda item: item["budget"]).get("reasoning", "")
        value = value or route.get("reasoning_effort", "")

    allowed = {
        "opencode": {"low", "medium", "high", "max", "xhigh"},
        "nvidia": {"low", "medium", "high"},
        "gemini": {"low", "medium", "high"},
        "openrouter": {"low", "medium", "high"},
        "cloudflare": {"low", "medium", "high"},
        "zai": {"low", "medium", "high"},
    }.get(route.get("provider"))
    if value and allowed is not None and value not in allowed:
        raise ProxyError(400, f'{route.get("provider")} does not support reasoning effort "{value}"')
    return value


def translate_request(request: dict[str, Any], route: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    provider = route.get("provider", "")
    if not provider or not route.get("model"):
        raise ProxyError(500, "Claude route requires provider and model")
    system = [
        _prompt(request.get("system")),
        str(config.get("system_prepend", "")).strip(),
        _route_prompt(route, Path(config["claude_root"])),
    ]
    messages = _messages(request.get("messages", []), provider)
    combined = "\n\n".join(part for part in system if part)
    if combined:
        messages.insert(0, {"role": "system", "content": combined})

    output: dict[str, Any] = {
        "model": route.get("model"),
        "messages": messages,
        "max_tokens": route.get("max_tokens") or request.get("max_tokens"),
        "stream": bool(request.get("stream")),
    }
    for field in ("temperature", "top_p"):
        value = route.get(field, request.get(field))
        if value is not None:
            output[field] = value
    if route.get("toolcalling", True) and request.get("tools"):
        output["tools"] = [{
            "type": "function",
            "function": {
                "name": tool.get("name", ""),
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {}),
            },
        } for tool in request["tools"]]
    effort = _effort(request, route, config)
    if effort:
        output["reasoning_effort"] = effort
    if output["stream"]:
        output["stream_options"] = {"include_usage": True}
    output.update(route.get("extra_body", {}))
    return output


def _open_upstream(config: dict[str, Any], provider_name: str, outgoing: dict[str, Any]):
    provider = config["providers"].get(provider_name)
    if not provider or not provider.get("base_url"):
        raise ProxyError(500, f'unknown provider "{provider_name}"')
    if not provider.get("api_key"):
        raise ProxyError(401, f'API key for provider "{provider_name}" is not configured')
    request = urllib.request.Request(
        provider["base_url"].rstrip("/") + "/chat/completions",
        data=json.dumps(outgoing, separators=(",", ":")).encode(),
        headers={"Authorization": "Bearer " + provider["api_key"], "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(2):
        try:
            return urllib.request.urlopen(request, timeout=300)
        except urllib.error.HTTPError as error:
            body = error.read()
            try:
                parsed = json.loads(body)
                detail = parsed.get("error", parsed)
                message = detail.get("message", str(detail)) if isinstance(detail, dict) else str(detail)
            except (json.JSONDecodeError, UnicodeDecodeError):
                message = body.decode("utf-8", "replace") or str(error.reason)
            headers = {name: error.headers[name] for name in ("Retry-After", "request-id", "x-request-id") if error.headers.get(name)}
            if error.code == 503 and attempt == 0:
                continue
            raise ProxyError(error.code, message, headers) from error
        except urllib.error.URLError as error:
            if attempt == 0:
                continue
            raise ProxyError(502, f"upstream connection failed: {error.reason}") from error
    raise ProxyError(502, "upstream connection failed")


def _content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(part.get("text", "") for part in value if isinstance(part, dict))
    return ""


def _event(name: str, data: dict[str, Any]) -> bytes:
    return f"event: {name}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n".encode()


def anthropic_stream(lines: Iterable[bytes], model: str) -> Iterable[bytes]:
    message_id = "msg_" + secrets.token_hex(8)
    yield _event("message_start", {
        "type": "message_start",
        "message": {"id": message_id, "type": "message", "role": "assistant", "model": model,
                    "content": [], "stop_reason": None,
                    "usage": {"input_tokens": 0, "output_tokens": 0}},
    })
    next_index = 0
    open_block: tuple[str, int] | None = None
    tools: dict[int, dict[str, Any]] = {}
    stop_reason, input_tokens, output_tokens = "end_turn", 0, 0
    saw_done = saw_output = False

    def stop_open() -> bytes | None:
        nonlocal open_block
        if open_block is None:
            return None
        payload = _event("content_block_stop", {"type": "content_block_stop", "index": open_block[1]})
        open_block = None
        return payload

    for raw in lines:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            saw_done = True
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if chunk.get("error"):
            error = chunk["error"]
            message = error.get("message", str(error)) if isinstance(error, dict) else str(error)
            yield _event("error", {"type": "error", "error": {"type": "api_error", "message": message}})
            return
        usage = chunk.get("usage") or {}
        input_tokens = usage.get("prompt_tokens", input_tokens) or input_tokens
        output_tokens = usage.get("completion_tokens", output_tokens) or output_tokens
        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        if choice.get("finish_reason") == "tool_calls":
            stop_reason = "tool_use"
        elif choice.get("finish_reason") == "length":
            stop_reason = "max_tokens"
        delta = choice.get("delta") or {}

        reasoning = _content_text(delta.get("reasoning_content") or delta.get("reasoning"))
        if reasoning:
            saw_output = True
            if open_block is None or open_block[0] != "thinking":
                closed = stop_open()
                if closed:
                    yield closed
                open_block = ("thinking", next_index)
                next_index += 1
                yield _event("content_block_start", {"type": "content_block_start", "index": open_block[1],
                    "content_block": {"type": "thinking", "thinking": "", "signature": ""}})
            yield _event("content_block_delta", {"type": "content_block_delta", "index": open_block[1],
                "delta": {"type": "thinking_delta", "thinking": reasoning}})

        text = _content_text(delta.get("content"))
        if text:
            saw_output = True
            if open_block is None or open_block[0] != "text":
                if open_block and open_block[0] == "thinking":
                    yield _event("content_block_delta", {"type": "content_block_delta", "index": open_block[1],
                        "delta": {"type": "signature_delta", "signature": "acc"}})
                closed = stop_open()
                if closed:
                    yield closed
                open_block = ("text", next_index)
                next_index += 1
                yield _event("content_block_start", {"type": "content_block_start", "index": open_block[1],
                    "content_block": {"type": "text", "text": ""}})
            yield _event("content_block_delta", {"type": "content_block_delta", "index": open_block[1],
                "delta": {"type": "text_delta", "text": text}})

        for tool in delta.get("tool_calls") or []:
            index = tool.get("index", 0)
            state = tools.setdefault(index, {"id": "", "name": "", "args": "", "block": None})
            function = tool.get("function") or {}
            state["id"] = tool.get("id") or state["id"]
            state["name"] = function.get("name") or state["name"]
            signature = function.get("thought_signature", "")
            signature = ((tool.get("extra_content") or {}).get("google") or {}).get("thought_signature", signature)
            if signature and "__thought__" not in state["id"]:
                state["id"] += "__thought__" + signature
            arguments = function.get("arguments", "")
            if state["block"] is None and (state["id"] or state["name"]):
                closed = stop_open()
                if closed:
                    yield closed
                state["block"] = next_index
                next_index += 1
                saw_output = True
                yield _event("content_block_start", {"type": "content_block_start", "index": state["block"],
                    "content_block": {"type": "tool_use", "id": state["id"], "name": state["name"], "input": {}}})
                if state["args"]:
                    yield _event("content_block_delta", {"type": "content_block_delta", "index": state["block"],
                        "delta": {"type": "input_json_delta", "partial_json": state["args"]}})
                    state["args"] = ""
            if state["block"] is None:
                state["args"] += arguments
            elif arguments:
                yield _event("content_block_delta", {"type": "content_block_delta", "index": state["block"],
                    "delta": {"type": "input_json_delta", "partial_json": arguments}})

    if open_block and open_block[0] == "thinking":
        yield _event("content_block_delta", {"type": "content_block_delta", "index": open_block[1],
            "delta": {"type": "signature_delta", "signature": "acc"}})
    closed = stop_open()
    if closed:
        yield closed
    for state in sorted(tools.values(), key=lambda item: item["block"] if item["block"] is not None else 1 << 30):
        if state["block"] is not None:
            yield _event("content_block_stop", {"type": "content_block_stop", "index": state["block"]})
    if not saw_done or not saw_output:
        message = "Upstream stream ended without a completion signal" if saw_output else "Upstream returned no usable output"
        yield _event("error", {"type": "error", "error": {"type": "api_error", "message": message}})
        return
    yield _event("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None},
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens}})
    yield _event("message_stop", {"type": "message_stop"})


def anthropic_response(response: dict[str, Any], model: str) -> dict[str, Any]:
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content: list[dict[str, Any]] = []
    reasoning = _content_text(message.get("reasoning_content") or message.get("reasoning"))
    if reasoning:
        content.append({"type": "thinking", "thinking": reasoning, "signature": "acc"})
    text = _content_text(message.get("content"))
    if text:
        content.append({"type": "text", "text": text})
    for tool in message.get("tool_calls") or []:
        function = tool.get("function") or {}
        try:
            arguments = json.loads(function.get("arguments") or "{}")
        except json.JSONDecodeError:
            arguments = {}
        content.append({"type": "tool_use", "id": tool.get("id", ""), "name": function.get("name", ""), "input": arguments})
    finish = choice.get("finish_reason")
    usage = response.get("usage") or {}
    return {"id": "msg_" + secrets.token_hex(8), "type": "message", "role": "assistant", "model": model,
        "content": content, "stop_reason": "tool_use" if finish == "tool_calls" else "max_tokens" if finish == "length" else "end_turn",
        "stop_sequence": None, "usage": {"input_tokens": usage.get("prompt_tokens", 0), "output_tokens": usage.get("completion_tokens", 0)}}


HOSTED_TOOLS = {"web_search", "file_search", "computer_use_preview", "computer", "image_generation",
                "code_interpreter", "shell", "apply_patch", "mcp", "tool_search"}


def _decode_codex_slug(value: str) -> tuple[str, str]:
    provider, separator, encoded = value.partition("/")
    if not separator or not provider or not encoded:
        raise ProxyError(400, f'unrecognized Codex model "{value}"')
    model, index = "", 0
    while index < len(encoded):
        if encoded[index] != "~":
            model += encoded[index]
            index += 1
            continue
        if index + 1 >= len(encoded) or encoded[index + 1] not in {"s", "~"}:
            raise ProxyError(400, f'malformed Codex model "{value}"')
        model += "/" if encoded[index + 1] == "s" else "~"
        index += 2
    return provider, model


def resolve_codex_route(model: str, config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    models = config.get("codex_models", {})
    capability = models.get(model)
    if capability is None:
        provider, backend = _decode_codex_slug(model)
        capability = next((item for item in models.values() if _capability_route(item, config)[0] == provider
                           and _capability_route(item, config)[1] == backend), None)
        if capability is None:
            if provider not in config.get("providers", {}):
                raise ProxyError(400, f'Codex provider "{provider}" is not configured')
            capability = {
                "provider": provider, "model": backend, "enabled": True,
                "streaming_support": True, "tool_call_support": True,
                "image_input_support": False, "file_input_support": False,
                "reasoning": {name: {} if name == "minimal" else {"effort": name}
                              for name in ("minimal", "low", "medium", "high", "xhigh", "max")},
            }
    if capability.get("enabled", True) is False:
        raise ProxyError(400, f'Codex model "{model}" is disabled')
    provider, backend = _capability_route(capability, config)
    route = {**config.get("routes", {}).get(capability.get("route", ""), {}), **capability,
             "provider": provider, "model": backend}
    if not route["provider"] or not route["model"]:
        raise ProxyError(500, f'Codex model "{model}" has no provider route')
    return route, capability


def _capability_route(capability: dict[str, Any], config: dict[str, Any]) -> tuple[str, str]:
    route = config.get("routes", {}).get(capability.get("route", ""), {})
    return capability.get("provider") or route.get("provider", ""), capability.get("model") or route.get("model", "")


def _contains_part(value: Any, part_type: str) -> bool:
    if isinstance(value, dict):
        return value.get("type") == part_type or any(_contains_part(item, part_type) for item in value.values())
    if isinstance(value, list):
        return any(_contains_part(item, part_type) for item in value)
    return False


def _validate_responses(request: dict[str, Any], route: dict[str, Any]) -> None:
    backend = f'{route.get("provider")}/{route.get("model")}'
    if request.get("stream") and route.get("streaming_support", True) is False:
        raise ProxyError(400, f"backend {backend} does not support streaming")
    if request.get("tools") and route.get("tool_call_support", True) is False:
        raise ProxyError(400, f"backend {backend} does not support tool calls")
    if _contains_part(request.get("input"), "input_image") and route.get("image_input_support", False) is False:
        raise ProxyError(400, f"backend {backend} does not support image input")
    if _contains_part(request.get("input"), "input_file") and route.get("file_input_support", False) is False:
        raise ProxyError(400, f"backend {backend} does not support file input")
    effort = (request.get("reasoning") or {}).get("effort", "")
    if effort and effort not in route.get("reasoning", {}):
        raise ProxyError(400, f'backend {backend} does not support reasoning effort "{effort}"')


def _persona(config: dict[str, Any], backend: str) -> str:
    path = Path(config["config_root"]) / "system_prompts" / "persona.md"
    if not path.exists():
        return ""
    try:
        sections: dict[str, list[str]] = {}
        current = ""
        for line in path.read_text().splitlines():
            if line.startswith("## "):
                current = line[3:].strip().lower()
                sections[current] = []
            elif current:
                sections[current].append(line)
        selected = [sections.get(name, []) for name in ("core behavior", "runtime: codex", "personal instructions")]
        body = "\n\n".join("\n".join(lines).strip() for lines in selected if lines).replace("{{backend}}", backend)
        return f"<acc_persona>\n{body}\n</acc_persona>" if body else ""
    except OSError as error:
        raise ProxyError(500, f"persona {path}: {error}") from error


def _bridge_name(prefix: str, value: bytes) -> str:
    return prefix + hashlib.sha256(value).hexdigest()[:20]


def _responses_tools(request: dict[str, Any], route: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    translated: list[dict[str, Any]] = []
    mapping: dict[str, dict[str, Any]] = {
        "custom_by_bridge": {}, "custom_by_name": {},
        "namespace_by_bridge": {}, "namespace_by_name": {},
    }
    backend = f'{route.get("provider")}/{route.get("model")}'
    for tool in request.get("tools") or []:
        kind = tool.get("type", "function")
        if kind in {"", "function"}:
            function = tool.get("function") or tool
            name = function.get("name", "")
            if name:
                item = {"type": "function", "function": {
                    "name": name, "description": function.get("description", ""),
                    "parameters": function.get("parameters", {}),
                }}
                if tool.get("strict") is not None:
                    item["function"]["strict"] = tool["strict"]
                translated.append(item)
            continue
        if kind == "custom":
            name = tool.get("name", "")
            if not name:
                raise ProxyError(400, f"backend {backend} cannot bridge unnamed custom tool")
            format_ = tool.get("format")
            if format_ and (format_.get("type") != "grammar" or format_.get("syntax") not in {"lark", "regex"}
                            or not format_.get("definition")):
                raise ProxyError(400, f'backend {backend} cannot bridge custom tool "{name}" format')
            raw = json.dumps(tool, separators=(",", ":"), sort_keys=True).encode()
            bridge = _bridge_name("acc_custom_", raw)
            definition = {"name": name, "bridge": bridge}
            if name in mapping["custom_by_name"]:
                raise ProxyError(400, f'duplicate custom tool name "{name}"')
            mapping["custom_by_bridge"][bridge] = definition
            mapping["custom_by_name"][name] = definition
            translated.append({"type": "function", "function": {
                "name": bridge,
                "description": (tool.get("description", "") +
                    f'\n\nACC custom-tool bridge for "{name}". Put the exact raw input in the required input field.'),
                "parameters": {"type": "object", "properties": {"input": {"type": "string"}},
                               "required": ["input"], "additionalProperties": False},
                "strict": True,
            }})
            continue
        if kind == "namespace":
            namespace = tool.get("name", "")
            if not namespace:
                raise ProxyError(400, f"backend {backend} cannot bridge unnamed namespace")
            for child in tool.get("tools") or []:
                if child.get("type", "function") not in {"", "function"}:
                    raise ProxyError(400, f'backend {backend} cannot bridge namespace tool type "{child.get("type")}"')
                function = child.get("function") or child
                name = function.get("name", "")
                if not name:
                    raise ProxyError(400, f'backend {backend} cannot bridge unnamed tool in namespace "{namespace}"')
                raw = json.dumps(child, separators=(",", ":"), sort_keys=True)
                bridge = _bridge_name("acc_ns_", (namespace + "\0" + raw).encode())
                definition = {"namespace": namespace, "name": name, "bridge": bridge}
                qualified = namespace + "\0" + name
                if qualified in mapping["namespace_by_name"]:
                    raise ProxyError(400, f'duplicate namespace tool "{namespace}.{name}"')
                mapping["namespace_by_bridge"][bridge] = definition
                mapping["namespace_by_name"][qualified] = definition
                description = function.get("description", "")
                if tool.get("description"):
                    description = tool["description"] + "\n\n" + description
                item = {"type": "function", "function": {
                    "name": bridge, "description": description,
                    "parameters": function.get("parameters", {}),
                }}
                if child.get("strict") is not None:
                    item["function"]["strict"] = child["strict"]
                translated.append(item)
            continue
        if kind in HOSTED_TOOLS:
            raise ProxyError(400, f'backend {backend} does not support hosted tool "{kind}" through Chat Completions')
        raise ProxyError(400, f'backend {backend} does not support tool type "{kind}"')
    return translated, mapping


def _responses_content(content: Any) -> Any:
    if isinstance(content, str):
        return content
    parts: list[dict[str, Any]] = []
    for part in content if isinstance(content, list) else []:
        kind = part.get("type")
        if kind in {"input_text", "output_text", "text"}:
            parts.append({"type": "text", "text": part.get("text", "")})
        elif kind == "input_image":
            url = part.get("image_url") or part.get("url")
            if url:
                parts.append({"type": "image_url", "image_url": {"url": url}})
    if len(parts) == 1 and parts[0]["type"] == "text":
        return parts[0]["text"]
    return parts


def _response_tool_output(output: Any) -> str:
    if isinstance(output, str):
        return output
    if isinstance(output, list):
        text = "".join(part.get("text", "") for part in output if isinstance(part, dict)
                       and part.get("type") in {"input_text", "output_text", "text"})
        if text:
            return text
    return json.dumps(output, separators=(",", ":"))


def _append_tool_call(messages: list[dict[str, Any]], call: dict[str, Any]) -> None:
    if messages and messages[-1].get("role") == "assistant" and "content" not in messages[-1]:
        messages[-1].setdefault("tool_calls", []).append(call)
    else:
        messages.append({"role": "assistant", "tool_calls": [call]})


def _responses_messages(input_: Any, provider: str, mapping: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    if isinstance(input_, str):
        return [{"role": "user", "content": input_}]
    messages: list[dict[str, Any]] = []
    for item in input_ if isinstance(input_, list) else []:
        kind = item.get("type", "message")
        if kind == "message":
            messages.append({"role": item.get("role", "user"), "content": _responses_content(item.get("content", ""))})
        elif kind == "reasoning":
            text = "\n".join(part.get("text", "") for part in item.get("summary") or [] if part.get("text"))
            if text:
                messages.append({"role": "assistant", "reasoning_content": text})
        elif kind == "function_call":
            call_id, _, signature = str(item.get("call_id") or item.get("id", "")).partition("__thought__")
            name = item.get("name", "")
            if item.get("namespace"):
                definition = mapping["namespace_by_name"].get(item["namespace"] + "\0" + name)
                if not definition:
                    raise ProxyError(400, f'namespace tool call "{item["namespace"]}.{name}" has no matching definition')
                name = definition["bridge"]
            function: dict[str, Any] = {"name": name, "arguments": item.get("arguments", "")}
            call: dict[str, Any] = {"id": call_id, "type": "function", "function": function}
            if provider == "gemini":
                call["extra_content"] = {"google": {"thought_signature": signature or "skip_thought_signature_validator"}}
            _append_tool_call(messages, call)
        elif kind == "function_call_output":
            call_id = str(item.get("call_id", "")).partition("__thought__")[0]
            messages.append({"role": "tool", "tool_call_id": call_id, "content": _response_tool_output(item.get("output"))})
        elif kind == "custom_tool_call":
            definition = mapping["custom_by_name"].get(item.get("name", ""))
            if not definition:
                raise ProxyError(400, f'custom tool call "{item.get("name", "")}" has no matching definition')
            arguments = json.dumps({"input": item.get("input", "")}, separators=(",", ":"))
            _append_tool_call(messages, {"id": item.get("call_id") or item.get("id", ""), "type": "function",
                                         "function": {"name": definition["bridge"], "arguments": arguments}})
        elif kind == "custom_tool_call_output":
            messages.append({"role": "tool", "tool_call_id": item.get("call_id", ""),
                             "content": _response_tool_output(item.get("output"))})
    return messages


def translate_responses_request(request: dict[str, Any], route: dict[str, Any], config: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]], str]:
    _validate_responses(request, route)
    tools, mapping = _responses_tools(request, route)
    backend = f'{route["provider"]}/{route["model"]}'
    system = [_persona(config, backend), str(config.get("system_prepend", "")).strip(), str(request.get("instructions", "")).strip()]
    messages = _responses_messages(request.get("input", ""), route["provider"], mapping)
    combined = "\n\n".join(part for part in system if part)
    if combined:
        messages.insert(0, {"role": "system", "content": combined})
    requested_tokens = request.get("max_output_tokens") or request.get("max_tokens") or 0
    route_limit = route.get("max_output") or route.get("max_tokens") or 0
    max_tokens = min(value for value in (requested_tokens, route_limit) if value > 0) if requested_tokens or route_limit else 0
    outgoing: dict[str, Any] = {"model": route["model"], "messages": messages, "stream": bool(request.get("stream"))}
    if max_tokens:
        outgoing["max_tokens"] = max_tokens
    for field in ("temperature", "top_p", "parallel_tool_calls", "tool_choice"):
        if request.get(field) is not None:
            outgoing[field] = request[field]
    if tools:
        outgoing["tools"] = tools
    requested_effort = (request.get("reasoning") or {}).get("effort", "")
    target = route.get("reasoning", {}).get(requested_effort, {}) if requested_effort else {}
    backend_effort = target.get("effort", requested_effort)
    if target.get("effort"):
        outgoing["reasoning_effort"] = target["effort"]
    if outgoing["stream"]:
        outgoing["stream_options"] = {"include_usage": True}
    outgoing.update(route.get("extra_body", {}))
    outgoing.update(target.get("extra_body", {}))
    return outgoing, mapping, backend_effort


def _responses_response(response: dict[str, Any], model: str, mapping: dict[str, dict[str, Any]]) -> dict[str, Any]:
    output: list[dict[str, Any]] = []
    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    reasoning = _content_text(message.get("reasoning_content") or message.get("reasoning"))
    if reasoning:
        output.append({"id": "rs_" + secrets.token_hex(8), "type": "reasoning", "status": "completed",
                       "summary": [{"type": "summary_text", "text": reasoning}]})
    text = _content_text(message.get("content"))
    if text:
        output.append({"id": "item_" + secrets.token_hex(8), "type": "message", "status": "completed",
                       "role": "assistant", "content": [{"type": "output_text", "text": text, "annotations": []}]})
    for tool in message.get("tool_calls") or []:
        function = tool.get("function") or {}
        name, arguments = function.get("name", ""), function.get("arguments", "")
        call_id = tool.get("id", "")
        signature = function.get("thought_signature", "") or ((tool.get("extra_content") or {}).get("google") or {}).get("thought_signature", "")
        if signature:
            call_id += "__thought__" + signature
        custom = mapping["custom_by_bridge"].get(name)
        namespace = mapping["namespace_by_bridge"].get(name)
        if custom:
            try:
                raw_input = json.loads(arguments).get("input", "")
            except json.JSONDecodeError as error:
                raise ProxyError(502, f'custom bridge returned invalid arguments: {error}') from error
            output.append({"id": "ctc_" + secrets.token_hex(8), "type": "custom_tool_call", "status": "completed",
                           "call_id": call_id, "name": custom["name"], "input": raw_input})
        else:
            item = {"id": "fc_" + secrets.token_hex(8), "type": "function_call", "status": "completed",
                    "call_id": call_id, "name": namespace["name"] if namespace else name, "arguments": arguments}
            if namespace:
                item["namespace"] = namespace["namespace"]
            output.append(item)
    if not output:
        raise ProxyError(502, "upstream returned no usable output")
    usage = response.get("usage") or {}
    input_tokens, output_tokens = usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
    return {"id": "resp_" + secrets.token_hex(8), "object": "response", "created_at": int(time.time()),
            "status": "completed", "model": model, "output": output,
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens,
                      "total_tokens": input_tokens + output_tokens}}


def _response_event(event_name: str, sequence: int, **values: Any) -> bytes:
    return _event(event_name, {"type": event_name, "sequence_number": sequence, **values})


def responses_stream(lines: Iterable[bytes], model: str, mapping: dict[str, dict[str, Any]], on_completion=None) -> Iterable[bytes]:
    response_id, sequence = "resp_" + secrets.token_hex(8), 0
    shell = {"id": response_id, "object": "response", "status": "in_progress", "model": model, "output": []}
    yield _response_event("response.created", sequence, response=shell); sequence += 1
    yield _response_event("response.in_progress", sequence, response=shell); sequence += 1
    reasoning: dict[str, Any] | None = None
    message: dict[str, Any] | None = None
    tools: dict[int, dict[str, Any]] = {}
    output_order: list[tuple[int, dict[str, Any]]] = []
    next_index = input_tokens = output_tokens = 0
    saw_done = False

    for raw in lines:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            saw_done = True
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue
        usage = chunk.get("usage") or {}
        input_tokens = usage.get("prompt_tokens", input_tokens) or input_tokens
        output_tokens = usage.get("completion_tokens", output_tokens) or output_tokens
        choices = chunk.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        reasoning_delta = _content_text(delta.get("reasoning_content") or delta.get("reasoning"))
        if reasoning_delta:
            if reasoning is None:
                reasoning = {"id": "rs_" + secrets.token_hex(8), "type": "reasoning", "status": "in_progress",
                             "summary": [], "index": next_index, "text": ""}
                next_index += 1
                output_order.append((reasoning["index"], reasoning))
                item = {key: value for key, value in reasoning.items() if key not in {"index", "text"}}
                yield _response_event("response.output_item.added", sequence, response_id=response_id,
                                      output_index=reasoning["index"], item=item); sequence += 1
            reasoning["text"] += reasoning_delta
            yield _response_event("response.reasoning_summary_text.delta", sequence, response_id=response_id,
                                  output_index=reasoning["index"], item_id=reasoning["id"], delta=reasoning_delta); sequence += 1

        text_delta = _content_text(delta.get("content"))
        if text_delta:
            if message is None:
                message = {"id": "item_" + secrets.token_hex(8), "type": "message", "status": "in_progress",
                           "role": "assistant", "content": [], "index": next_index, "text": ""}
                next_index += 1
                output_order.append((message["index"], message))
                item = {key: value for key, value in message.items() if key not in {"index", "text"}}
                yield _response_event("response.output_item.added", sequence, response_id=response_id,
                                      output_index=message["index"], item=item); sequence += 1
                yield _response_event("response.content_part.added", sequence, response_id=response_id,
                                      output_index=message["index"], content_index=0, item_id=message["id"],
                                      part={"type": "output_text", "text": "", "annotations": []}); sequence += 1
            message["text"] += text_delta
            yield _response_event("response.output_text.delta", sequence, response_id=response_id,
                                  output_index=message["index"], content_index=0, item_id=message["id"], delta=text_delta); sequence += 1

        for call in delta.get("tool_calls") or []:
            index = call.get("index", 0)
            state = tools.setdefault(index, {"id": "", "name": "", "arguments": "", "index": None})
            function = call.get("function") or {}
            state["id"] = call.get("id") or state["id"]
            state["name"] = function.get("name") or state["name"]
            state["arguments"] += function.get("arguments", "")
            signature = function.get("thought_signature", "") or ((call.get("extra_content") or {}).get("google") or {}).get("thought_signature", "")
            if signature and "__thought__" not in state["id"]:
                state["id"] += "__thought__" + signature
            if state["index"] is None and (state["id"] or state["name"]):
                state["index"] = next_index
                next_index += 1
                custom = mapping["custom_by_bridge"].get(state["name"])
                namespace = mapping["namespace_by_bridge"].get(state["name"])
                state["custom"], state["namespace"] = custom, namespace
                item = {"id": "ctc_" + secrets.token_hex(8) if custom else "fc_" + secrets.token_hex(8),
                        "type": "custom_tool_call" if custom else "function_call", "status": "in_progress",
                        "call_id": state["id"], "name": custom["name"] if custom else namespace["name"] if namespace else state["name"]}
                item["input" if custom else "arguments"] = ""
                if namespace:
                    item["namespace"] = namespace["namespace"]
                state["item"] = item
                output_order.append((state["index"], state))
                yield _response_event("response.output_item.added", sequence, response_id=response_id,
                                      output_index=state["index"], item=item); sequence += 1
            if state["index"] is not None and function.get("arguments") and not state.get("custom"):
                yield _response_event("response.function_call_arguments.delta", sequence, response_id=response_id,
                                      output_index=state["index"], item_id=state["item"]["id"],
                                      delta=function["arguments"]); sequence += 1

    completed: list[dict[str, Any]] = []
    for _index, state in sorted(output_order, key=lambda item: item[0]):
        if state is reasoning:
            item = {"id": state["id"], "type": "reasoning", "status": "completed",
                    "summary": [{"type": "summary_text", "text": state["text"]}]}
            yield _response_event("response.reasoning_summary_text.done", sequence, response_id=response_id,
                                  output_index=state["index"], item_id=state["id"], text=state["text"]); sequence += 1
        elif state is message:
            item = {"id": state["id"], "type": "message", "status": "completed", "role": "assistant",
                    "content": [{"type": "output_text", "text": state["text"], "annotations": []}]}
            yield _response_event("response.output_text.done", sequence, response_id=response_id,
                                  output_index=state["index"], content_index=0, item_id=state["id"], text=state["text"]); sequence += 1
            yield _response_event("response.content_part.done", sequence, response_id=response_id,
                                  output_index=state["index"], content_index=0, item_id=state["id"], part=item["content"][0]); sequence += 1
        elif state.get("custom"):
            try:
                raw_input = json.loads(state["arguments"]).get("input", "")
            except json.JSONDecodeError:
                raw_input = ""
            item = {**state["item"], "status": "completed", "call_id": state["id"], "input": raw_input}
            yield _response_event("response.custom_tool_call_input.delta", sequence, response_id=response_id,
                                  output_index=state["index"], item_id=item["id"], delta=raw_input); sequence += 1
            yield _response_event("response.custom_tool_call_input.done", sequence, response_id=response_id,
                                  output_index=state["index"], item_id=item["id"], name=item["name"], input=raw_input); sequence += 1
        else:
            item = {**state["item"], "status": "completed", "call_id": state["id"], "arguments": state["arguments"]}
            yield _response_event("response.function_call_arguments.done", sequence, response_id=response_id,
                                  output_index=state["index"], item_id=item["id"], name=item["name"],
                                  arguments=state["arguments"], **({"namespace": item["namespace"]} if item.get("namespace") else {})); sequence += 1
        yield _response_event("response.output_item.done", sequence, response_id=response_id,
                              output_index=state["index"], item=item); sequence += 1
        completed.append(item)

    status = "completed" if saw_done and completed else "incomplete"
    event = "response.completed" if status == "completed" else "response.incomplete"
    response = {"id": response_id, "object": "response", "created_at": int(time.time()), "model": model,
                "status": status, "output": completed,
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens,
                          "total_tokens": input_tokens + output_tokens}}
    if status == "incomplete":
        response["incomplete_details"] = {"reason": "upstream_stream_ended"}
    yield _response_event(event, sequence, response=response)
    if on_completion:
        on_completion(response)


def _error_type(status: int) -> str:
    return "authentication_error" if status in {401, 403} else "rate_limit_error" if status == 429 else "invalid_request_error" if status == 400 else "api_error"


class Handler(BaseHTTPRequestHandler):
    server: "Server"

    def log_message(self, _format: str, *_args: Any) -> None:
        pass

    def _json(self, status: int, value: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        body = json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        self._json(status, {"type": "error", "error": {"type": _error_type(status), "message": message}}, headers)

    def _request_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            raise ProxyError(400, "request body is empty or larger than 32 MiB")
        request = json.loads(self.rfile.read(length))
        if not isinstance(request, dict):
            raise ProxyError(400, "request body must be a JSON object")
        return request

    def _sse(self, headers: dict[str, str] | None = None) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True

    def _handle_messages(self, request: dict[str, Any]) -> None:
        config = load_config(self.server.config_root)
        if not config.get("alias_routes"):
            raise ProxyError(500, "Claude alias_routes are missing")
        _alias, route = resolve_route(str(request.get("model", "")), config)
        outgoing = translate_request(request, route, config)
        response = _open_upstream(config, route.get("provider", ""), outgoing)
        if request.get("stream"):
            self._sse()
            with response:
                for event in anthropic_stream(response, str(request.get("model", ""))):
                    self.wfile.write(event)
                    self.wfile.flush()
        else:
            with response:
                self._json(200, anthropic_response(json.load(response), str(request.get("model", ""))))

    def _handle_responses(self, request: dict[str, Any]) -> None:
        config = load_config(self.server.config_root)
        model = str(request.get("model", ""))
        route, _capability = resolve_codex_route(model, config)
        previous_id = str(request.get("previous_response_id", ""))
        if previous_id:
            previous = self.server.response(previous_id)
            if previous is None:
                raise ProxyError(404, f'previous response "{previous_id}" was not found in this ACC process')
            current = request.get("input", [])
            if isinstance(current, str):
                current = [{"type": "message", "role": "user",
                            "content": [{"type": "input_text", "text": current}]}]
            if not isinstance(current, list):
                raise ProxyError(400, "previous response continuation has invalid input")
            request = {**request, "input": previous.get("output", []) + current}
        outgoing, mapping, backend_effort = translate_responses_request(request, route, config)
        response = _open_upstream(config, route["provider"], outgoing)
        headers = {
            "X-ACC-Requested-Model": model,
            "X-ACC-Backend-Provider": route["provider"],
            "X-ACC-Backend-Model": route["model"],
            "X-ACC-Capability-Reroute": "false",
            "X-ACC-Backend-Effort": backend_effort,
        }
        requested_effort = (request.get("reasoning") or {}).get("effort", "")
        if requested_effort:
            headers["X-ACC-Requested-Effort"] = requested_effort
        should_store = request.get("store", True) is not False
        if request.get("stream"):
            self._sse(headers)
            with response:
                callback = self.server.remember if should_store else None
                for event in responses_stream(response, model, mapping, callback):
                    self.wfile.write(event)
                    self.wfile.flush()
        else:
            with response:
                output = _responses_response(json.load(response), model, mapping)
            if should_store:
                self.server.remember(output)
            self._json(200, output, headers)

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        try:
            if path == "/health":
                self._json(200, {"status": "ok", "runtime": "python", "service": "acc-python"})
                return
            if path == "/v1/models":
                config = load_config(self.server.config_root)
                ids = ["claude-" + _model_id(alias) for alias in config.get("alias_routes", {})]
                data = [{"type": "model", "id": item, "display_name": item, "created_at": "2025-01-01T00:00:00Z"} for item in ids]
                self._json(200, {"data": data, "has_more": False, "first_id": ids[0] if ids else None, "last_id": ids[-1] if ids else None})
                return
            self._error(404, "not found")
        except ProxyError as error:
            self._error(error.status, str(error), error.headers)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path not in {"/v1/messages", "/v1/responses"}:
            self._error(404, "not found")
            return
        try:
            request = self._request_json()
            self._handle_messages(request) if path == "/v1/messages" else self._handle_responses(request)
        except (ProxyError, json.JSONDecodeError, ValueError) as error:
            self._error(error.status if isinstance(error, ProxyError) else 400, str(error),
                        error.headers if isinstance(error, ProxyError) else None)
        except (BrokenPipeError, ConnectionResetError):
            pass


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], root: Path):
        self.config_root = root
        self.responses: dict[str, dict[str, Any]] = {}
        self.response_lock = threading.Lock()
        super().__init__(address, Handler)

    def remember(self, response: dict[str, Any]) -> None:
        if not response.get("id"):
            return
        # ponytail: process-local history; add encrypted persistence only when cross-restart continuation is required.
        with self.response_lock:
            self.responses[response["id"]] = json.loads(json.dumps(response))
            while len(self.responses) > 100:
                self.responses.pop(next(iter(self.responses)))

    def response(self, response_id: str) -> dict[str, Any] | None:
        with self.response_lock:
            value = self.responses.get(response_id)
            return json.loads(json.dumps(value)) if value else None

    def server_bind(self) -> None:
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def main() -> None:
    parser = argparse.ArgumentParser(description="ACC Python gateway")
    parser.add_argument("--config-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = Server(("127.0.0.1", args.port), args.config_root)
    print(f"READY http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
