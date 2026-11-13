"""What Canvas keeps: reports, their blocks and the log of each run, in one SQLite file. One user, one machine."""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS report (
  id TEXT PRIMARY KEY, parent_id TEXT, mode TEXT NOT NULL CHECK (mode IN ('answer', 'report', 'dashboard')),
  question TEXT NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  activity TEXT, error TEXT, suggestions TEXT NOT NULL DEFAULT '[]', rev INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, finished_at TEXT, refreshed_at TEXT, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS block (
  report_id TEXT NOT NULL REFERENCES report (id), seq INTEGER NOT NULL, kind TEXT NOT NULL, chart TEXT, spec TEXT NOT NULL,
  html TEXT NOT NULL, refresh_error TEXT, PRIMARY KEY (report_id, seq));
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, detail TEXT);
"""
_lock = threading.Lock()
_path = "canvas.db"


class Closed(Exception):
    """The report is finished and takes no more changes."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def open_store(path: str) -> None:
    global _path
    _path = path
    with tx() as db:
        db.executescript(SCHEMA)
        have = {r["name"] for r in db.execute("PRAGMA table_info(report)")}
        for column in ("filters", "layout"):        # added after the first release: an older file gains them here
            if column not in have:
                db.execute(f"ALTER TABLE report ADD COLUMN {column} TEXT NOT NULL DEFAULT '{{}}'")


@contextmanager
def tx():
    with _lock:
        db = sqlite3.connect(_path, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()


def create_report(question: str, mode: str, parent_id: str | None = None) -> str:
    rid = uuid.uuid4().hex[:12]
    with tx() as db:
        db.execute("INSERT INTO report (id, parent_id, mode, question, activity, created_at) VALUES (?,?,?,?,?,?)",
                   (rid, parent_id, mode, question, "Starts", now()))
    return rid


def get_report(rid: str, with_spec: bool = False) -> dict | None:
    with tx() as db:
        row = db.execute("SELECT * FROM report WHERE id = ? AND deleted = 0", (rid,)).fetchone()
        if row is None:
            return None
        report = dict(row)
        report["suggestions"] = json.loads(report["suggestions"])
        report["pinned"] = bool(report["pinned"])
        report["filters"], report["layout"] = json.loads(report["filters"] or "{}"), json.loads(report["layout"] or "{}")
        blocks = db.execute("SELECT seq, kind, chart, html, spec, refresh_error FROM block WHERE report_id = ? ORDER BY seq", (rid,)).fetchall()
        report["blocks"] = [{"seq": b["seq"], "kind": b["kind"], "chart": b["chart"], "html": b["html"], "refresh_error": b["refresh_error"],
                             **({"spec": json.loads(b["spec"])} if with_spec else {})} for b in blocks]
        return report


def list_reports() -> list[dict]:
    with tx() as db:
        rows = db.execute("SELECT id, mode, question, title, status, pinned, created_at, refreshed_at FROM report WHERE deleted = 0 "
                          "ORDER BY created_at DESC LIMIT 200").fetchall()
        return [dict(r, pinned=bool(r["pinned"])) for r in rows]


def _running(db, rid: str) -> None:
    row = db.execute("SELECT status FROM report WHERE id = ?", (rid,)).fetchone()
    if row is None or row["status"] != "running":
        raise Closed("the report is closed")


def set_title(rid: str, title: str) -> None:
    with tx() as db:
        _running(db, rid)
        db.execute("UPDATE report SET title = ?, rev = rev + 1 WHERE id = ?", (title, rid))


def set_activity(rid: str, text: str) -> None:
    with tx() as db:
        db.execute("UPDATE report SET activity = ?, rev = rev + 1 WHERE id = ? AND status = 'running'", (text, rid))


def chart_kinds(rid: str) -> list[str]:
    with tx() as db:
        return [r["chart"] for r in db.execute("SELECT chart FROM block WHERE report_id = ? AND chart IS NOT NULL ORDER BY seq", (rid,))]


def block_count(rid: str) -> int:
    with tx() as db:
        return db.execute("SELECT count(*) FROM block WHERE report_id = ?", (rid,)).fetchone()[0]


def add_block(rid: str, spec: dict, rendered: dict) -> int:
    with tx() as db:
        _running(db, rid)
        seq = db.execute("SELECT coalesce(max(seq), 0) + 1 FROM block WHERE report_id = ?", (rid,)).fetchone()[0]
        db.execute("INSERT INTO block (report_id, seq, kind, chart, spec, html) VALUES (?,?,?,?,?,?)",
                   (rid, seq, rendered["kind"], rendered["chart"], json.dumps(spec), rendered["html"]))
        db.execute("UPDATE report SET rev = rev + 1 WHERE id = ?", (rid,))
        return seq


def replace_block(rid: str, seq: int, spec: dict | None, html: str | None, error: str | None) -> None:
    """A refresh: new data and drawing, or the reason the block kept its old ones."""
    with tx() as db:
        if html is not None:
            db.execute("UPDATE block SET spec = ?, html = ?, refresh_error = NULL WHERE report_id = ? AND seq = ?", (json.dumps(spec), html, rid, seq))
        else:
            db.execute("UPDATE block SET refresh_error = ? WHERE report_id = ? AND seq = ?", (error, rid, seq))
        db.execute("UPDATE report SET rev = rev + 1, refreshed_at = ? WHERE id = ?", (now(), rid))


def get_block(rid: str, seq: int) -> dict | None:
    with tx() as db:
        row = db.execute("SELECT spec FROM block WHERE report_id = ? AND seq = ?", (rid, seq)).fetchone()
        return json.loads(row["spec"]) if row else None


def set_block(rid: str, seq: int, spec: dict, rendered: dict) -> None:
    with tx() as db:
        db.execute("UPDATE block SET spec = ?, html = ?, kind = ?, chart = ?, refresh_error = NULL WHERE report_id = ? AND seq = ?",
                   (json.dumps(spec), rendered["html"], rendered["kind"], rendered["chart"], rid, seq))
        db.execute("UPDATE report SET rev = rev + 1 WHERE id = ?", (rid,))


def get_filters(rid: str) -> dict:
    """{"defs": [...], "values": {param: value}, "cross": {param: seq}} of a page; empty parts when it has no filter."""
    with tx() as db:
        row = db.execute("SELECT filters FROM report WHERE id = ?", (rid,)).fetchone()
    found = json.loads(row["filters"] or "{}") if row else {}
    return {"defs": found.get("defs", []), "values": found.get("values", {}), "cross": found.get("cross", {})}


def set_filters(rid: str, filters: dict) -> None:
    with tx() as db:
        db.execute("UPDATE report SET filters = ?, rev = rev + 1 WHERE id = ?", (json.dumps(filters), rid))


def set_layout(rid: str, layout: dict) -> None:
    with tx() as db:
        db.execute("UPDATE report SET layout = ?, rev = rev + 1 WHERE id = ?", (json.dumps(layout), rid))


def block_sqls(rid: str) -> list[str]:
    with tx() as db:
        return [json.loads(r["spec"]).get("sql") or "" for r in db.execute("SELECT spec FROM block WHERE report_id = ?", (rid,))]


def delete_block(rid: str, seq: int) -> None:
    with tx() as db:
        db.execute("DELETE FROM block WHERE report_id = ? AND seq = ?", (rid, seq))
        db.execute("UPDATE report SET rev = rev + 1 WHERE id = ?", (rid,))


def reopen(rid: str) -> bool:
    """A finished page takes more blocks again (the person asked to add to it)."""
    with tx() as db:
        done = db.execute("UPDATE report SET status = 'running', error = NULL, activity = 'Starts', rev = rev + 1 WHERE id = ? AND status <> 'running'", (rid,))
        return done.rowcount == 1


def finish(rid: str, status: str, error: str | None = None, suggestions: list[str] | None = None) -> bool:
    with tx() as db:
        done = db.execute("UPDATE report SET status = ?, error = ?, suggestions = ?, activity = NULL, finished_at = ?, rev = rev + 1 "
                          "WHERE id = ? AND status = 'running'", (status, error, json.dumps(suggestions or []), now(), rid))
        return done.rowcount == 1


def set_pinned(rid: str, pinned: bool) -> None:
    with tx() as db:
        db.execute("UPDATE report SET pinned = ?, rev = rev + 1 WHERE id = ?", (1 if pinned else 0, rid))


def delete_report(rid: str) -> None:
    with tx() as db:
        db.execute("UPDATE report SET deleted = 1 WHERE id = ?", (rid,))


def event(rid: str, kind: str, name: str | None = None, detail=None) -> None:
    with tx() as db:
        db.execute("INSERT INTO event (report_id, at, kind, name, detail) VALUES (?,?,?,?,?)",
                   (rid, now(), kind, name, json.dumps(detail, default=str)[:20000] if detail is not None else None))


def refused_before(rid: str, name: str, marker: str) -> bool:
    with tx() as db:
        return db.execute("SELECT 1 FROM event WHERE report_id = ? AND kind = 'refusal' AND name = ? AND detail LIKE ? LIMIT 1",
                          (rid, name, f"%{marker}%")).fetchone() is not None


def fail_running(reason: str) -> None:
    """At start: a run that was cut by a restart never finishes by itself."""
    with tx() as db:
        db.execute("UPDATE report SET status = 'failed', error = ?, activity = NULL, finished_at = ? WHERE status = 'running'", (reason, now()))
