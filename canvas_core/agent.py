"""One run: the model reads the brief, calls the tools, and the page fills. The loop is plain: ask the model for
its next step, run the tool calls it names, hand back the results, until it calls finish or a limit is reached."""
from __future__ import annotations

import threading
import time
from datetime import date
from pathlib import Path

from . import models, store
from .tools import SCHEMAS, Tools

MAX_STEPS = {"answer": 16, "report": 60, "dashboard": 40}
MAX_SECONDS = {"answer": 240, "report": 900, "dashboard": 600}
_cancel: dict[str, threading.Event] = {}
ASK = {"answer": "This is an ANSWER request (one question).", "report": "This is a REPORT request (several questions or a broad subject).",
       "dashboard": "This is a DASHBOARD request (a standing view to refresh later)."}


def system_prompt(settings, catalog: str) -> str:
    text = (Path(__file__).parent / "prompt.md").read_text(encoding="utf-8")
    return text.format(name=settings.name, today=date.today().isoformat(), currency=settings.currency, language=settings.language,
                       catalog=catalog or "(the schema could not be read)", glossary=settings.glossary_text() or "(none: read real values to learn the terms)")


def phrase(name: str, args: dict) -> str:
    if name == "run_sql":
        return "Reads the database"
    if name == "add_block":
        block = args.get("block") if isinstance(args.get("block"), dict) else {}
        return "Draws " + str(block.get("title") or block.get("text") or block.get("kind") or "a block")[:60]
    return {"set_title": "Names the report", "finish": "Finishes"}.get(name, "Works")


def run(settings, database, report_id: str, question: str, mode: str, context: str = "") -> None:
    stop = _cancel.setdefault(report_id, threading.Event())
    tools = Tools(database, report_id, mode)
    started = time.monotonic()
    try:
        model = models.connect(settings, system_prompt(settings, database.catalog()), SCHEMAS)
        model.user(f"{ASK[mode]}\n\n{context}Request: {question}")
        idle = 0
        for _ in range(MAX_STEPS[mode]):
            if stop.is_set():
                store.finish(report_id, "failed", "cancelled")
                return
            if time.monotonic() - started > MAX_SECONDS[mode]:
                store.finish(report_id, "failed", f"the run passed its time limit of {MAX_SECONDS[mode]} seconds")
                return
            step = model.step()
            if not step["calls"]:
                idle += 1
                if idle >= 2:
                    break
                model.user("You answered in text. The person sees only blocks. Continue with tool calls, and call finish when the page is complete.")
                continue
            idle = 0
            results = []
            for call in step["calls"]:
                store.set_activity(report_id, phrase(call["name"], call["args"]))
                store.event(report_id, "tool_call", call["name"], call["args"])
                text = tools.call(call["name"], call["args"])
                store.event(report_id, "tool_result", call["name"], text[:2000])
                results.append((call, text))
            model.results(results)
            report = store.get_report(report_id)
            if report is None or report["status"] != "running":
                return
        if store.block_count(report_id) > 0:
            store.finish(report_id, "ok", suggestions=[])
        else:
            store.finish(report_id, "failed", "the model stopped before it added a block")
    except Exception as exc:  # the page must say that the run failed, and why
        store.event(report_id, "error", type(exc).__name__, str(exc)[:1000])
        store.finish(report_id, "failed", f"{type(exc).__name__}: {str(exc)[:300]}")
    finally:
        _cancel.pop(report_id, None)


def start(settings, database, report_id: str, question: str, mode: str, context: str = "") -> None:
    _cancel[report_id] = threading.Event()
    threading.Thread(target=run, args=(settings, database, report_id, question, mode, context), daemon=True).start()


def cancel(report_id: str) -> None:
    if report_id in _cancel:
        _cancel[report_id].set()
