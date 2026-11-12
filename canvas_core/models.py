"""The model behind the agent, reached over HTTP with the installation's own key. Two wire formats cover most
company gateways: "openai" (chat completions with tools; also Azure OpenAI and most internal gateways) and
"anthropic" (messages with tools). Each adapter turns one step of the conversation into
{"text": str, "calls": [{"id", "name", "args"}]} and keeps the transcript in its own format.
"""
from __future__ import annotations

import json

import requests


class ModelError(Exception):
    pass


def _post(url: str, headers: dict, body: dict, timeout: int) -> dict:
    try:
        reply = requests.post(url, headers=headers, json=body, timeout=timeout)
    except requests.RequestException as exc:
        raise ModelError(f"the model endpoint did not answer: {type(exc).__name__}") from exc
    if reply.status_code != 200:
        raise ModelError(f"the model endpoint answered {reply.status_code}: {reply.text[:300]}")
    return reply.json()


class OpenAIChat:
    def __init__(self, settings, system: str, tools: list[dict]):
        m = settings.model
        self.url = m["base_url"].rstrip("/") + m.get("path", "/chat/completions")
        self.model, self.timeout = m["model"], int(m.get("timeout", 180))
        key = settings.secret(m, "api_key_env") if m.get("api_key_env") else ""
        self.headers = {"Content-Type": "application/json", **({m.get("key_header", "Authorization"): m.get("key_prefix", "Bearer ") + key} if key else {}),
                        **m.get("headers", {})}
        self.tools = [{"type": "function", "function": t} for t in tools]
        self.messages = [{"role": "system", "content": system}]
        self.extra = m.get("extra", {})

    def user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def step(self) -> dict:
        data = _post(self.url, self.headers, {"model": self.model, "messages": self.messages, "tools": self.tools, **self.extra}, self.timeout)
        message = data["choices"][0]["message"]
        self.messages.append({k: v for k, v in message.items() if k in ("role", "content", "tool_calls")})
        calls = []
        for call in message.get("tool_calls") or []:
            raw = call["function"].get("arguments") or "{}"
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                args = {"_invalid_json": raw[:300]}
            calls.append({"id": call.get("id") or call["function"]["name"], "name": call["function"]["name"], "args": args})
        return {"text": message.get("content") or "", "calls": calls}

    def results(self, results: list[tuple[dict, str]]) -> None:
        for call, text in results:
            self.messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})


class AnthropicMessages:
    def __init__(self, settings, system: str, tools: list[dict]):
        m = settings.model
        self.url = m["base_url"].rstrip("/") + m.get("path", "/v1/messages")
        self.model, self.timeout, self.system = m["model"], int(m.get("timeout", 180)), system
        key = settings.secret(m, "api_key_env")
        self.headers = {"Content-Type": "application/json", m.get("key_header", "x-api-key"): m.get("key_prefix", "") + key,
                        "anthropic-version": m.get("version", "2023-06-01"), **m.get("headers", {})}
        self.tools = [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools]
        self.messages: list[dict] = []
        self.max_tokens = int(m.get("max_tokens", 4096))

    def user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def step(self) -> dict:
        data = _post(self.url, self.headers, {"model": self.model, "system": self.system, "messages": self.messages, "tools": self.tools,
                                              "max_tokens": self.max_tokens}, self.timeout)
        content = data.get("content") or []
        self.messages.append({"role": "assistant", "content": content})
        return {"text": "".join(b.get("text", "") for b in content if b.get("type") == "text"),
                "calls": [{"id": b["id"], "name": b["name"], "args": b.get("input") or {}} for b in content if b.get("type") == "tool_use"]}

    def results(self, results: list[tuple[dict, str]]) -> None:
        self.messages.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": call["id"], "content": text} for call, text in results]})


def connect(settings, system: str, tools: list[dict]):
    return (OpenAIChat if settings.model["kind"] == "openai" else AnthropicMessages)(settings, system, tools)
