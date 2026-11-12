"""Settings of one installation, from canvas.toml (path in CANVAS_CONFIG, else ./canvas.toml).

Secrets are never in the file: the file names the environment variables that hold them (password_env, api_key_env).
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


class ConfigError(Exception):
    pass


@dataclass
class Settings:
    name: str = "Canvas"
    language: str = "English"
    currency: str = "USD"
    port: int = 8570
    store: str = "canvas.db"
    glossary: str = ""
    database: dict = field(default_factory=dict)
    model: dict = field(default_factory=dict)
    root: Path = Path(".")

    def secret(self, section: dict, key: str) -> str:
        """The value of the environment variable that section[key] names. Fails loud when it is not set."""
        env = section.get(key)
        if not env:
            raise ConfigError(f"canvas.toml: {key} is missing (the NAME of the environment variable that holds the secret)")
        value = os.environ.get(env)
        if not value:
            raise ConfigError(f"environment variable {env} is not set")
        return value

    def glossary_text(self) -> str:
        if not self.glossary:
            return ""
        path = (self.root / self.glossary) if not os.path.isabs(self.glossary) else Path(self.glossary)
        if not path.exists():
            raise ConfigError(f"glossary file not found: {path}")
        return path.read_text(encoding="utf-8")


def load(path: str | None = None) -> Settings:
    file = Path(path or os.environ.get("CANVAS_CONFIG") or "canvas.toml").resolve()
    if not file.exists():
        raise ConfigError(f"settings file not found: {file} (copy canvas.example.toml to canvas.toml)")
    raw = tomllib.loads(file.read_text(encoding="utf-8"))
    app = raw.get("app", {})
    settings = Settings(
        name=app.get("name", "Canvas"), language=app.get("language", "English"), currency=app.get("currency", "USD"),
        port=int(app.get("port", 8570)), store=app.get("store", "canvas.db"), glossary=app.get("glossary", ""),
        database=raw.get("database", {}), model=raw.get("model", {}), root=file.parent)
    if settings.database.get("kind") != "mysql":
        raise ConfigError("canvas.toml: [database] kind must be \"mysql\"")
    kind = settings.model.get("kind")
    if kind not in ("openai", "claude"):
        raise ConfigError("canvas.toml: [model] kind must be \"claude\" (Claude API or Claude on Azure) or \"openai\" (chat completions with tools)")
    if not settings.model.get("model"):
        raise ConfigError("canvas.toml: [model] model is missing (the model name, or the deployment name on Azure)")
    if kind == "openai" and not settings.model.get("base_url"):
        raise ConfigError("canvas.toml: [model] base_url is missing")
    return settings
