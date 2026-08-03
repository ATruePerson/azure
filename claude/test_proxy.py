import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import proxy


class ACCPythonGatewayTest(unittest.TestCase):
    def test_current_claude_code_request_and_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "Prompt").write_text("Route identity")
            config = {
                "claude_root": root,
                "system_prepend": "Global rule",
                "effort": {},
            }
            route = {
                "provider": "nvidia",
                "model": "test/model",
                "reasoning_effort": "high",
                "reasoning_locked": True,
                "max_tokens": 65536,
                "system_prepend": "@Prompt",
                "extra_body": {"reasoning_budget": 32000},
            }
            request = {
                "model": "claude-sonnet-4-6",
                "max_tokens": 32000,
                "stream": True,
                "thinking": {"type": "adaptive"},
                "output_config": {"effort": "high"},
                "context_management": {"edits": [{"type": "clear_thinking_20251015"}]},
                "system": [{"type": "text", "text": "Claude Code system", "cache_control": {"type": "ephemeral"}}],
                "messages": [
                    {"role": "assistant", "content": [{"type": "tool_use", "id": "call_1", "name": "Read", "input": {"file_path": "a"}}]},
                    {"role": "user", "content": [
                        {"type": "tool_result", "tool_use_id": "call_1", "content": "contents"},
                        {"type": "text", "text": "continue", "cache_control": {"type": "ephemeral"}},
                    ]},
                ],
                "tools": [{"name": "Read", "description": "read", "input_schema": {"type": "object"}}],
            }

            translated = proxy.translate_request(request, route, config)
            self.assertEqual(translated["model"], "test/model")
            self.assertEqual(translated["max_tokens"], 65536)
            self.assertEqual(translated["reasoning_effort"], "high")
            self.assertEqual(translated["reasoning_budget"], 32000)
            self.assertEqual(translated["stream_options"], {"include_usage": True})
            self.assertTrue(translated["messages"][0]["content"].startswith("Claude Code system"))
            self.assertTrue(translated["messages"][0]["content"].endswith("Route identity"))
            self.assertEqual([item["role"] for item in translated["messages"][1:]], ["assistant", "tool", "user"])
            self.assertEqual(translated["tools"][0]["function"]["parameters"], {"type": "object"})

            chunks = [
                b'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n',
                b'data: {"choices":[{"delta":{"content":"done"}}]}\n',
                b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"Read","arguments":"{\\"file_path\\":\\"b\\"}"}}]}}]}\n',
                b'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n',
                b'data: [DONE]\n',
            ]
            stream = b"".join(proxy.anthropic_stream(chunks, request["model"])).decode()
            self.assertIn('"type":"thinking_delta","thinking":"plan"', stream)
            self.assertIn('"type":"signature_delta","signature":"acc"', stream)
            self.assertIn('"type":"text_delta","text":"done"', stream)
            self.assertIn('"type":"tool_use","id":"call_2","name":"Read"', stream)
            self.assertIn('"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"b\\"}"', stream)
            self.assertIn('"stop_reason":"tool_use"', stream)
            self.assertIn('"input_tokens":7,"output_tokens":2', stream)
            self.assertIn("event: message_stop", stream)

    def test_codex_request_routing_tools_and_stream_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prompts = root / "system_prompts"
            prompts.mkdir()
            (prompts / "persona.md").write_text(
                "## Core behavior\nBackend {{backend}}\n\n"
                "## Runtime: claude-code\nWrong runtime\n\n"
                "## Runtime: codex\nCodex runtime\n\n"
                "## Personal instructions\nBe direct\n"
            )
            route = {
                "provider": "nvidia", "model": "test/model", "enabled": True,
                "reasoning": {"minimal": {}, "high": {"effort": "high", "extra_body": {"reasoning_budget": 2048}}},
                "tool_call_support": True, "streaming_support": True,
                "image_input_support": False, "file_input_support": False, "max_output": 4096,
            }
            config = {"config_root": root, "system_prepend": "Global rule", "codex_models": {"codex-test": route}}
            request = {
                "model": "codex-test", "instructions": "Client rule", "stream": True,
                "max_output_tokens": 5000, "reasoning": {"effort": "high"},
                "input": [{"type": "message", "role": "user",
                           "content": [{"type": "input_text", "text": "work"}]}],
                "tools": [
                    {"type": "function", "name": "Read", "parameters": {"type": "object"}},
                    {"type": "custom", "name": "patch", "description": "apply patch"},
                    {"type": "namespace", "name": "mcp", "tools": [
                        {"type": "function", "name": "search", "parameters": {"type": "object"}}
                    ]},
                ],
            }

            resolved, capability = proxy.resolve_codex_route("codex-test", {"codex_models": {"codex-test": route}})
            self.assertEqual((resolved["provider"], resolved["model"]), ("nvidia", "test/model"))
            self.assertIs(capability, route)
            translated, mapping, backend_effort = proxy.translate_responses_request(request, route, config)
            self.assertEqual(translated["model"], "test/model")
            self.assertEqual(translated["max_tokens"], 4096)
            self.assertEqual(translated["reasoning_effort"], "high")
            self.assertEqual(translated["reasoning_budget"], 2048)
            self.assertEqual(backend_effort, "high")
            self.assertIn("Backend nvidia/test/model", translated["messages"][0]["content"])
            self.assertIn("Codex runtime", translated["messages"][0]["content"])
            self.assertNotIn("Wrong runtime", translated["messages"][0]["content"])
            self.assertEqual(len(translated["tools"]), 3)

            custom_bridge = next(iter(mapping["custom_by_bridge"]))
            chunks = [
                b'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n',
                b'data: {"choices":[{"delta":{"content":"done"}}]}\n',
                (f'data: {{"choices":[{{"delta":{{"tool_calls":[{{"index":0,"id":"call_1",'
                 f'"function":{{"name":"{custom_bridge}","arguments":"{{\\"input\\":\\"diff\\"}}"}}}}]}}}}]}}\n').encode(),
                b'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n',
                b'data: [DONE]\n',
            ]
            stream = b"".join(proxy.responses_stream(chunks, request["model"], mapping)).decode()
            self.assertIn("event: response.created", stream)
            self.assertIn('"type":"custom_tool_call"', stream)
            self.assertIn('"name":"patch","input":"diff"', stream)
            self.assertIn('"input_tokens":9,"output_tokens":3,"total_tokens":12', stream)
            self.assertIn("event: response.completed", stream)

            empty = b"".join(proxy.responses_stream([b"data: [DONE]\n"], request["model"], mapping)).decode()
            self.assertIn("event: response.incomplete", empty)
            self.assertNotIn("event: response.completed", empty)

            bad = {**request, "reasoning": {"effort": "max"}}
            with self.assertRaises(proxy.ProxyError):
                proxy.translate_responses_request(bad, route, config)


if __name__ == "__main__":
    unittest.main()
