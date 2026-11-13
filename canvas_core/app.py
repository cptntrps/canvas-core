"""The local web app: one page to ask, and the API behind it. It listens on this machine only (127.0.0.1) and has
no login: one user, local."""
from __future__ import annotations

from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

from . import agent, config, filters, layouts, render, store, tools
from .db import MySQL

WEB = Path(__file__).resolve().parent.parent / "web"
MODES = ("answer", "report", "dashboard")


def create_app(settings=None, database=None) -> Flask:
    settings = settings or config.load()
    database = database or MySQL(settings)
    store.open_store(str(settings.root / settings.store))
    store.fail_running("the app restarted during this run")
    app = Flask(__name__)

    def source(rid: str, seq: int | None = None):
        """The database as this page sees it: its filter values applied. The block a cross-filter click came from
        ignores that value, so it stays whole and shows where the click was."""
        state = store.get_filters(rid)
        skip = [p for p, origin in state["cross"].items() if origin == seq]
        return filters.Filtered(database, state["values"], skip)

    def columns(rid: str, seq: int, spec: dict) -> int:
        """How many grid columns the tile of this block takes: a chart on a wide tile is drawn wider."""
        if spec.get("kind") != "chart":
            return 1
        return {2: 2, "full": 3}.get((store.get_report(rid) or {}).get("layout", {}).get("width", {}).get(str(seq)), 1)

    def gap(spec: dict, reason: str) -> str:
        """The drawing of a block that has nothing to show under the page's filter. It never keeps numbers of another filter."""
        from html import escape
        title = escape(str(spec.get("title") or spec.get("kind") or "Block"))
        return (f'<section class="block chart"><h3>{title}</h3><p class="takeaway">Nothing to show under this filter</p>'
                f'<p class="source">{escape(reason[:200])}</p></section>')

    def labels_of(spec: dict) -> list[str]:
        rows = spec.get(tools.LABEL_VALUE.get(spec.get("chart"), ""))
        return [str(r.get("label")) for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []

    def redraw(rid: str, found: dict) -> dict:
        """Run each block's own query again and draw it with the new rows. No model is called."""
        state, done, kept, empty = store.get_filters(rid), 0, [], []
        for block in found["blocks"]:
            spec = block["spec"]
            if not spec.get("bind"):
                continue
            # A chart of a filter's own dimension (spend by department under the Department filter) stays whole and
            # marks the chosen value; so does the chart a click came from.
            names = labels_of(spec)
            own = next((d["param"] for d in state["defs"] if d["kind"] == "choice" and names and set(names) <= set(d["options"])), None)
            skip = ([own] if own else []) + [p for p, origin in state["cross"].items() if origin == block["seq"]]
            view = filters.Filtered(database, state["values"], skip)
            try:
                if spec.get("through_sql"):
                    rows = view.run(spec["through_sql"])["rows"]
                    if rows and rows[0][0]:
                        spec["data_through"] = str(rows[0][0])[:10]
                filled = tools.fill(view, spec)
                shown = dict(filled)
                picked = next((state["values"][p] for p in skip if state["values"].get(p)), None)
                if picked and filled.get("chart") == "hbar" and picked in labels_of(filled):
                    shown["highlight"] = [labels_of(filled).index(picked)]
                rendered = tools.draw(shown, columns(rid, block["seq"], filled))
                store.replace_block(rid, block["seq"], filled, rendered["html"], None)
                done += 1
            except Exception as exc:
                if view.values and isinstance(exc, tools.Refused):   # too few rows under the filter: say so on the tile
                    store.replace_block(rid, block["seq"], spec, gap(spec, str(exc)), None)
                    empty.append(block["seq"])
                else:                    # the block keeps its last good drawing, and the page says so
                    store.replace_block(rid, block["seq"], None, None, str(exc)[:300])
                    kept.append({"seq": block["seq"], "error": str(exc)[:300]})
        return {"refreshed": done, "kept_old": kept, "empty": empty}

    @app.get("/vendor/<path:name>")
    def vendor(name):
        return send_from_directory(render.ROOT / "vendor", name)

    @app.get("/")
    def index():
        return Response((WEB / "index.html").read_text(encoding="utf-8").replace("{{name}}", settings.name), mimetype="text/html")

    @app.get("/shell")
    def shell():
        return Response(render.shell(), mimetype="text/html")

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "name": settings.name})

    @app.get("/api/layouts")
    def dashboard_layouts():
        return jsonify({"layouts": layouts.names()})

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
        if mode == "dashboard":
            context += layouts.instruction(body.get("layout"))
        rid = store.create_report(question[:2000], mode, parent["id"] if parent else None)
        agent.start(settings, database, rid, question[:2000], mode, context)
        return jsonify({"id": rid}), 201

    @app.get("/api/reports/<rid>")
    def report(rid):
        found = store.get_report(rid, with_spec=True)
        if found is None:
            return jsonify({"error": "no such report"}), 404
        state = found["filters"] = {"defs": found["filters"].get("defs", []), "values": found["filters"].get("values", {}), "cross": found["filters"].get("cross", {})}
        for d in state["defs"]:          # how many blocks follow each filter, so the page can say it
            d["follows"] = sum(1 for b in found["blocks"] if set(filters.params_of(d)) & filters.names_in(str(b["spec"].get("sql") or "")))
        choices = [d for d in state["defs"] if d["kind"] == "choice"]
        for b in found["blocks"]:
            spec, b["cross"] = b.pop("spec"), None
            names = labels_of(spec)
            if names:                    # a chart whose labels are the values of a filter can set that filter by a click
                b["cross"] = next((d["param"] for d in choices if set(names) <= set(d["options"])), None)
        return jsonify(found)

    @app.post("/api/reports/<rid>/filters")
    def set_filter_values(rid):
        """Apply filter values to the page: every block that follows them runs its query again. No model is called."""
        found = store.get_report(rid, with_spec=True)
        if found is None:
            return jsonify({"error": "no such report"}), 404
        if found["status"] == "running":
            return jsonify({"error": "the report still runs"}), 409
        body, state = request.get_json(silent=True) or {}, store.get_filters(rid)
        try:
            values = filters.clean(state["defs"], body.get("values") or {})
        except filters.FilterError as exc:
            return jsonify({"error": str(exc)}), 422
        seqs = {b["seq"] for b in found["blocks"]}
        cross = {p: s for p, s in (body.get("cross") or {}).items() if p in values and s in seqs}
        store.set_filters(rid, {"defs": state["defs"], "values": values, "cross": cross})
        return jsonify(redraw(rid, found))

    @app.post("/api/reports/<rid>/layout")
    def set_layout(rid):
        """Keep the order and the width of the tiles as the person arranged them."""
        found = store.get_report(rid)
        if found is None:
            return jsonify({"error": "no such report"}), 404
        body, seqs = request.get_json(silent=True) or {}, [b["seq"] for b in found["blocks"]]
        order = [s for s in body.get("order") or [] if s in seqs]
        if len(set(order)) != len(order):
            return jsonify({"error": "order names a block twice"}), 422
        width = {str(s): w for s, w in (body.get("width") or {}).items() if str(s).isdigit() and int(s) in seqs and w in (1, 2, "full")}
        before = found["layout"].get("width", {})
        store.set_layout(rid, {"order": order, "width": width})
        for block in store.get_report(rid, with_spec=True)["blocks"]:      # a chart whose tile changed width is drawn again, from the data it has
            key = str(block["seq"])
            if block["kind"] == "chart" and before.get(key) != width.get(key):
                try:
                    store.replace_block(rid, block["seq"], block["spec"], tools.draw(block["spec"], columns(rid, block["seq"], block["spec"]))["html"], None)
                except tools.Refused:
                    pass                 # the drawing it has stays; the browser scales it to the tile
        return jsonify({"result": "ok"})

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

    @app.get("/api/reports/<rid>/blocks/<int:seq>/alternatives")
    def block_alternatives(rid, seq):
        spec = store.get_block(rid, seq)
        if spec is None:
            return jsonify({"error": "no such block"}), 404
        return jsonify({"current": spec.get("chart"), "alternatives": tools.alternatives(source(rid, seq), spec)})

    @app.post("/api/reports/<rid>/blocks/<int:seq>/chart")
    def block_chart(rid, seq):
        """Draw the same query as another chart form. No model is called."""
        spec = store.get_block(rid, seq)
        if spec is None:
            return jsonify({"error": "no such block"}), 404
        try:
            filled, rendered = tools.convert(source(rid, seq), spec, str((request.get_json(silent=True) or {}).get("chart")), columns(rid, seq, spec))
        except tools.Refused as exc:
            return jsonify({"error": str(exc)}), 422
        store.set_block(rid, seq, filled, rendered)
        return jsonify({"result": "ok", "chart": rendered["chart"]})

    @app.delete("/api/reports/<rid>/blocks/<int:seq>")
    def block_delete(rid, seq):
        store.delete_block(rid, seq)
        return jsonify({"result": "deleted"})

    @app.post("/api/reports/<rid>/extend")
    def extend(rid):
        """Add to a page that exists: the agent sees what is on it and adds only what is asked."""
        found = store.get_report(rid, with_spec=True)
        question = " ".join(str((request.get_json(silent=True) or {}).get("question") or "").split())
        if found is None:
            return jsonify({"error": "no such report"}), 404
        if len(question) < 3:
            return jsonify({"error": "the request is empty"}), 400
        if not store.reopen(rid):
            return jsonify({"error": "the report still runs"}), 409
        have = "\n".join(f"- block {b['seq']}: {b['kind']}{' ' + b['chart'] if b['chart'] else ''}: {b['spec'].get('title') or b['spec'].get('text') or ''}"
                         f"{' | sql: ' + b['spec']['sql'] if b['spec'].get('sql') else ''}" for b in found["blocks"])
        context = (f"This page exists already. Its request was: {found['question']}\nIt has these blocks:\n{have}\n\n"
                   "The person now asks to ADD to this page. Add only the new blocks that the request needs (1 to 3), in the style of the page. "
                   "Do not repeat a block that exists, do not call set_title, and call finish when the new blocks are on the page.\n\n")
        agent.start(settings, database, rid, question[:2000], found["mode"], context)
        return jsonify({"id": rid}), 202

    @app.post("/api/reports/<rid>/refresh")
    def refresh(rid):
        """Run each block's own query again and draw it with the new rows. No model is called."""
        found = store.get_report(rid, with_spec=True)
        if found is None:
            return jsonify({"error": "no such report"}), 404
        if found["status"] == "running":
            return jsonify({"error": "the report still runs"}), 409
        state = store.get_filters(rid)
        for d in state["defs"]:          # the lists of values of the choice filters are read again too
            if d["kind"] != "choice":
                continue
            try:
                d["options"] = filters.options(database, d)
            except Exception as exc:     # the filter keeps its last list, and the log says why
                store.event(rid, "error", "filter options", str(exc)[:300])
            if state["values"].get(d["param"]) not in d["options"]:
                state["values"].pop(d["param"], None)
                state["cross"].pop(d["param"], None)
        if state["defs"]:
            store.set_filters(rid, state)
        return jsonify(redraw(rid, found))

    return app


def main() -> None:
    settings = config.load()
    create_app(settings).run(host="127.0.0.1", port=settings.port, threaded=True)


if __name__ == "__main__":
    main()
