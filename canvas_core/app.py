"""The local web app: one page to ask, and the API behind it. It listens on this machine only (127.0.0.1) and has
no login: one user, local."""
from __future__ import annotations

from pathlib import Path

from flask import Flask, Response, jsonify, request

from . import agent, config, render, store, tools
from .db import MySQL

WEB = Path(__file__).resolve().parent.parent / "web"
MODES = ("answer", "report", "dashboard")


def create_app(settings=None, database=None) -> Flask:
    settings = settings or config.load()
    database = database or MySQL(settings)
    store.open_store(str(settings.root / settings.store))
    store.fail_running("the app restarted during this run")
    app = Flask(__name__)

    @app.get("/")
    def index():
        return Response((WEB / "index.html").read_text(encoding="utf-8").replace("{{name}}", settings.name), mimetype="text/html")

    @app.get("/shell")
    def shell():
        return Response(render.shell(), mimetype="text/html")

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "name": settings.name})

    @app.get("/api/reports")
    def reports():
        return jsonify({"reports": store.list_reports()})

    @app.post("/api/reports")
    def ask():
        body = request.get_json(silent=True) or {}
        question, mode = " ".join(str(body.get("question") or "").split()), body.get("mode", "answer")
        if len(question) < 3:
            return jsonify({"error": "the question is empty"}), 400
        if mode not in MODES:
            return jsonify({"error": f"mode must be one of {', '.join(MODES)}"}), 400
        context = ""
        parent = store.get_report(body["parent_id"]) if body.get("parent_id") else None
        if parent:
            context = (f"This follows an earlier page. Its request was: {parent['question']}\nIts title was: {parent['title'] or ''}\n"
                       "Answer the new request; do not repeat the earlier page.\n\n")
        rid = store.create_report(question[:2000], mode, parent["id"] if parent else None)
        agent.start(settings, database, rid, question[:2000], mode, context)
        return jsonify({"id": rid}), 201

    @app.get("/api/reports/<rid>")
    def report(rid):
        found = store.get_report(rid)
        return (jsonify(found), 200) if found else (jsonify({"error": "no such report"}), 404)

    @app.post("/api/reports/<rid>/cancel")
    def cancel(rid):
        agent.cancel(rid)
        return jsonify({"result": "stopping"})

    @app.post("/api/reports/<rid>/pin")
    def pin(rid):
        if store.get_report(rid) is None:
            return jsonify({"error": "no such report"}), 404
        store.set_pinned(rid, bool((request.get_json(silent=True) or {}).get("pinned", True)))
        return jsonify({"result": "ok"})

    @app.delete("/api/reports/<rid>")
    def delete(rid):
        store.delete_report(rid)
        return jsonify({"result": "deleted"})

    @app.post("/api/reports/<rid>/refresh")
    def refresh(rid):
        """Run each block's own query again and draw it with the new rows. No model is called."""
        found = store.get_report(rid, with_spec=True)
        if found is None:
            return jsonify({"error": "no such report"}), 404
        if found["status"] == "running":
            return jsonify({"error": "the report still runs"}), 409
        done, kept = 0, []
        for block in found["blocks"]:
            spec = block["spec"]
            if not spec.get("bind"):
                continue
            try:
                if spec.get("through_sql"):
                    rows = database.run(spec["through_sql"])["rows"]
                    if rows and rows[0][0]:
                        spec["data_through"] = str(rows[0][0])[:10]
                filled = tools.fill(database, spec)
                rendered = tools.draw(filled)
                store.replace_block(rid, block["seq"], filled, rendered["html"], None)
                done += 1
            except Exception as exc:  # the block keeps its last good drawing, and the page says so
                store.replace_block(rid, block["seq"], None, None, str(exc)[:300])
                kept.append({"seq": block["seq"], "error": str(exc)[:300]})
        return jsonify({"refreshed": done, "kept_old": kept})

    return app


def main() -> None:
    settings = config.load()
    create_app(settings).run(host="127.0.0.1", port=settings.port, threaded=True)


if __name__ == "__main__":
    main()
