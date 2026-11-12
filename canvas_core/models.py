"""The model behind the agent, reached with the installation's own key. Two adapters:

  kind = "claude"   Claude through the official Anthropic SDK: the Claude API, or Claude on Microsoft Foundry (Azure).
  kind = "openai"   any endpoint that speaks chat completions with tools: OpenAI, Azure OpenAI, a company gateway,
                    a local model server.

Each adapter turns one step of the conversation into {"text": str, "calls": [{"id", "name", "args"}]} and keeps the
transcript in its own format.
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


class Claude:
    """Claude through the official SDK. platform = "anthropic" (the Claude API) or "foundry" (Claude on Microsoft
    Foundry in Azure: `resource` is the Azure resource name, `model` is the deployment name)."""

    def __init__(self, settings, system: str, tools: list[dict]):
        import anthropic
        m = settings.model
        self.anthropic = anthropic
        timeout = float(m.get("timeout", 300))
        key = settings.secret(m, "api_key_env")
        platform = m.get("platform", "anthropic")
        if platform == "foundry":
            if not (m.get("resource") or m.get("base_url")):
                raise ModelError("canvas.toml: [model] platform \"foundry\" needs resource (the Azure resource name) or base_url")
            self.client = anthropic.AnthropicFoundry(api_key=key, resource=m.get("resource"), base_url=m.get("base_url"), timeout=timeout)
        elif platform == "anthropic":
            self.client = anthropic.Anthropic(api_key=key, base_url=m.get("base_url"), timeout=timeout)
        else:
            raise ModelError("canvas.toml: [model] platform must be \"anthropic\" or \"foundry\"")
        self.model, self.system = m["model"], system
        self.max_tokens = int(m.get("max_tokens", 16000))
        self.extra = {"output_config": {"effort": m["effort"]}} if m.get("effort") else {}
        self.tools = [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools]
        self.messages: list[dict] = []

    def user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text})

    def step(self) -> dict:
        a = self.anthropic
        try:
            reply = self.client.messages.create(model=self.model, max_tokens=self.max_tokens, system=self.system, tools=self.tools,
                                                messages=self.messages, **self.extra)
        except a.AuthenticationError as exc:
            raise ModelError("the model endpoint refused the key (check the key and the resource or base_url)") from exc
        except a.PermissionDeniedError as exc:
            raise ModelError("the key has no permission for this model or deployment") from exc
        except a.NotFoundError as exc:
            raise ModelError(f"the model endpoint does not know the model or deployment \"{self.model}\"") from exc
        except a.RateLimitError as exc:
            raise ModelError("the model endpoint is rate limited; try again in a minute") from exc
        except a.APIStatusError as exc:
            raise ModelError(f"the model endpoint answered {exc.status_code}: {str(exc.message)[:300]}") from exc
        except a.APIConnectionError as exc:
            raise ModelError("the model endpoint did not answer (network)") from exc
        if reply.stop_reason == "refusal":
            raise ModelError("the model declined this request")
        # The whole content goes back, unchanged: thinking blocks and tool calls must stay as the model wrote them.
        self.messages.append({"role": "assistant", "content": reply.content})
        if reply.stop_reason == "max_tokens" and not any(b.type == "tool_use" for b in reply.content):
            raise ModelError("the model's answer was cut at max_tokens; raise [model] max_tokens")
        return {"text": "".join(b.text for b in reply.content if b.type == "text"),
                "calls": [{"id": b.id, "name": b.name, "args": b.input if isinstance(b.input, dict) else {}} for b in reply.content if b.type == "tool_use"]}

    def results(self, results: list[tuple[dict, str]]) -> None:
        # Every tool result of the turn in ONE user message.
        self.messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": call["id"], "content": text, **({"is_error": True} if text.startswith("REFUSED") else {})}
            for call, text in results]})


def connect(settings, system: str, tools: list[dict]):
    return (OpenAIChat if settings.model["kind"] == "openai" else Claude)(settings, system, tools)
