"""Bridge to render/render.mjs: the one place that validates a block spec and draws it (one node process per block).
A spec defect comes back as Refused with a message for the agent; a crash of the renderer is an error, never a silent skip."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "render"


class Refused(Exception):
    """The block spec is not valid; the text says what to change."""


def node() -> str:
    path = os.environ.get("CANVAS_NODE") or shutil.which("node")
    if not path:
        raise RuntimeError("Node.js is not installed (version 18 or newer); set CANVAS_NODE to its path")
    return path


def shell() -> str:
    page = (ROOT / "shell.html").read_text(encoding="utf-8")
    return (page.replace("/*LEAFLET_CSS*/", (ROOT / "vendor/leaflet.css").read_text(encoding="utf-8"))
                .replace("/*LEAFLET_JS*/", (ROOT / "vendor/leaflet.js").read_text(encoding="utf-8").replace("</script>", "<\\/script>")))


def render_block(spec: dict, columns: int = 1) -> dict:
    """{"kind", "chart", "html"} or Refused. `columns` (1 to 3) is the width of the tile: a chart on a wide tile is
    drawn on a wider plot, so its text keeps its size."""
    env = {**os.environ, "CANVAS_COLUMNS": str(columns)} if columns != 1 else None
    proc = subprocess.run([node(), str(ROOT / "render.mjs")], input=json.dumps(spec), capture_output=True, text=True, timeout=30, check=False, env=env)
    if proc.returncode != 0:
        raise RuntimeError(f"renderer failed ({proc.returncode}): {proc.stderr.strip()[-400:]}")
    out = json.loads(proc.stdout)
    if not out["ok"]:
        raise Refused(out["error"])
    return {"kind": out["kind"], "chart": out["chart"], "html": out["html"]}
