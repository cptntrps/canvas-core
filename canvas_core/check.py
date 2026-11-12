"""Check an installation before the first question: settings, database, chart renderer, model.

usage: python -m canvas_core.check
Each line says what was checked and whether it passed. A failed line says what to change. Nothing is written to the
database, and the model gets one short test message.
"""
from __future__ import annotations

import sys

from . import config, models, render
from .db import MySQL, QueryRefused

WRITE_WORDS = ("INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "ALL PRIVILEGES", "GRANT OPTION", "FILE", "SUPER")


def line(ok: bool, what: str, detail: str = "") -> bool:
    print(f"{'PASS' if ok else 'FAIL'}  {what}{': ' + detail if detail else ''}")
    return ok


def main() -> int:
    results = []
    try:
        settings = config.load()
        results.append(line(True, "settings file", f"{settings.root / 'canvas.toml'}"))
    except config.ConfigError as exc:
        line(False, "settings file", str(exc))
        return 1
    try:
        glossary = settings.glossary_text()
        results.append(line(True, "glossary", f"{len(glossary.split())} words" if glossary else "none set: answers improve a lot with one (glossary.example.md)"))
    except config.ConfigError as exc:
        results.append(line(False, "glossary", str(exc)))
    database = None
    try:
        database = MySQL(settings)
        tables = database.run(f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '{database.schema}'")["rows"][0][0]
        results.append(line(tables > 0, "database connection", f"{tables} tables in {database.schema}" if tables else f"no tables visible in {database.schema}"))
        grants = " ".join(str(r[0]).upper() for r in database.run("SHOW GRANTS")["rows"])
        writes = [w for w in WRITE_WORDS if w in grants]
        results.append(line(not writes, "database user is read-only",
                            f"the user also has {', '.join(writes)}: give it SELECT only" if writes else "SELECT only"))
        try:
            database.run("DELETE FROM information_schema.tables")
            results.append(line(False, "write guard", "a write statement was not refused"))
        except QueryRefused:
            results.append(line(True, "write guard", "a write statement is refused before it reaches the database"))
    except config.ConfigError as exc:
        results.append(line(False, "database connection", str(exc)))
    except Exception as exc:  # the first run of a new installation: say what the driver said
        results.append(line(False, "database connection", f"{type(exc).__name__}: {str(exc)[:200]}"))
    try:
        render.render_block({"kind": "insight", "title": "Check", "text": "The renderer works."})
        results.append(line(True, "chart renderer (Node.js)"))
    except Exception as exc:
        results.append(line(False, "chart renderer (Node.js)", str(exc)[:200]))
    try:
        tool = {"name": "ping", "description": "Answer the check.", "parameters": {"type": "object", "properties": {"word": {"type": "string"}}, "required": ["word"]}}
        model = models.connect(settings, "You are a connection check. Call the tool `ping` with the word \"ok\".", [tool])
        model.user("Call ping now.")
        step = model.step()
        called = any(c["name"] == "ping" for c in step["calls"])
        results.append(line(called, "model endpoint", f"{settings.model['model']} answered and called a tool" if called
                            else f"{settings.model['model']} answered but did not call the tool: this model or deployment may not support tools"))
    except (models.ModelError, config.ConfigError) as exc:
        results.append(line(False, "model endpoint", str(exc)[:300]))
    print("\nAll checks passed. Start the app: python -m canvas_core.app" if all(results) else "\nFix the FAIL lines, then run the check again.")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
