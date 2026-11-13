"""The four tools of the agent and the rules that keep a report honest. Each returns text for the model; a Refused
tells the model what to change. The rules are code, so a model cannot talk its way past them."""
from __future__ import annotations

from . import bind, cluster, filters, render, store
from .db import QueryRefused

MAX_BLOCKS = {"answer": 5, "report": 24, "dashboard": 12}
BASIC = {"line", "area", "bar", "hbar", "donut"}
VARIETY = "the report uses only basic charts"
DATA_KINDS = ("chart", "kpi", "table", "map", "timeline")


class Refused(Exception):
    pass


SCHEMAS = [
    {"name": "run_sql", "description": "Run one read-only SQL statement on the database and get its rows (500 at most). Use it to explore and to check a query before you bind it to a block.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "set_title", "description": "Set the report title: first a working title, at the end the main finding (60 characters at most).",
     "parameters": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}},
    {"name": "add_block", "description": "Add one block to the report. A block that shows data carries \"sql\" and \"bind\": the door runs the query and fills the data itself.",
     "parameters": {"type": "object", "properties": {"block": {"type": "object"}}, "required": ["block"]}},
    {"name": "find_groups", "description": "Cluster analysis: find groups of items that are alike on 2 to 6 measures. The query returns one row per item (a label column and the measure columns). You get the groups, their averages, example members and how strong the grouping is. Call it before you add a cluster block, so you can say what each group is.",
     "parameters": {"type": "object", "properties": {"sql": {"type": "string"}, "label": {"type": "string"}, "measures": {"type": "array", "items": {"type": "string"}}, "k": {"type": "integer"}}, "required": ["sql", "label", "measures"]}},
    {"name": "set_filters", "description": "Dashboard only: give the page its filters (1 to 4), before the first block. Each filter is {name, param, kind} with kind \"choice\" (plus options_sql: a query that returns its values in one column) or \"date_range\". The blocks then follow a filter through optional clauses in their sql.",
     "parameters": {"type": "object", "properties": {"filters": {"type": "array", "items": {"type": "object"}}}, "required": ["filters"]}},
    {"name": "finish", "description": "Close the report with 3 short follow-up questions.",
     "parameters": {"type": "object", "properties": {"suggestions": {"type": "array", "items": {"type": "string"}}}, "required": ["suggestions"]}},
]


def preview(result: dict, limit: int = 60) -> str:
    lines = [" | ".join(result["columns"])]
    lines += [" | ".join("" if v is None else str(v) for v in row) for row in result["rows"][:limit]]
    extra = len(result["rows"]) - limit
    if extra > 0:
        lines.append(f"... {extra} more rows")
    if result.get("truncated"):
        lines.append("(the result was cut at the row limit: aggregate in SQL)")
    return "\n".join(lines) if result["rows"] else "(no rows)"


LABEL_VALUE = {"bar": "data", "hbar": "data", "pareto": "data", "donut": "slices", "treemap": "items", "funnel": "stages", "bubbles": "items"}


LABEL_MAX = {"bar": 14, "hbar": 40, "pareto": 12, "donut": 20, "treemap": 24, "bubbles": 24, "funnel": 28}


def _short(rows: list[dict], chart: str) -> list[dict]:
    """Group names cut to what the chart's labels hold, so a long name never refuses the block."""
    limit = LABEL_MAX.get(chart, 20)
    return [{**r, "label": r["label"] if len(r["label"]) <= limit else r["label"][:limit - 1] + "…"} for r in rows]


def fill(database, spec: dict) -> dict:
    """The spec with its data placed from its query. A block without bind is returned as it is."""
    if not spec.get("bind"):
        return spec
    if not isinstance(spec.get("sql"), str) or not spec["sql"].strip():
        raise Refused('"bind" needs "sql": the query whose rows fill the block')
    try:
        result = database.run(spec["sql"])
        if spec["bind"] in ("cluster", "cluster_profile", "cluster_sizes"):
            found = cluster.from_result(result, spec)
            ask, out = spec["cluster"], dict(spec)
            names = cluster.display_names(found, ask)
            if spec["bind"] == "cluster":
                out["groups"] = cluster.scatter_groups(found, result, ask.get("x", found["measures"][0]), ask.get("y", found["measures"][1]), names)
            elif spec["bind"] == "cluster_profile":
                out.setdefault("columns", [{"name": "Group"}, {"name": "Items", "format": "integer"}]
                               + [{"name": m.replace("_", " ")[:14], "format": "number"} for m in found["measures"]])
                out["rows"] = cluster.profile_rows(found, names)
            else:
                if spec.get("chart") not in LABEL_VALUE:
                    raise Refused('"bind": "cluster_sizes" draws the size of each group as hbar, bar, donut, treemap or bubbles')
                out[LABEL_VALUE[spec["chart"]]] = _short(cluster.size_rows(found, names), spec["chart"])
            return out
        return bind.apply(spec, result)
    except (QueryRefused, bind.BindError, cluster.ClusterError) as exc:
        raise Refused(str(exc)) from exc


def draw(spec: dict, columns: int = 1) -> dict:
    drawn = {k: v for k, v in spec.items() if k not in ("sql", "bind", "repeat_reason", "cluster", "through_sql", "unfiltered")}
    try:
        return render.render_block(drawn, columns) if columns != 1 else render.render_block(drawn)
    except render.Refused as exc:
        raise Refused(str(exc)) from exc


# Charts that draw the same rows. A block can change form inside its family with no model: the query stays, the
# door fills the new form and draws it.
SERIES = ("line", "area", "stacked_area", "grouped", "small_multiples", "bump")
COMMON = ("kind", "chart", "title", "takeaway", "unit", "source", "sql", "bind", "data_through", "through_sql", "format", "decimals", "suffix", "repeat_reason", "unfiltered")


def family(spec: dict) -> list[str]:
    chart = spec.get("chart")
    if spec.get("kind") != "chart" or not spec.get("bind") or str(spec.get("bind")).startswith("cluster"):
        return []          # a cluster view keeps its form: its data comes from the grouping, not straight from the rows
    if chart in LABEL_VALUE:
        return list(LABEL_VALUE)
    return list(SERIES) if chart in SERIES else []


def convert(database, spec: dict, chart: str, columns: int = 1) -> tuple[dict, dict]:
    """(filled spec, drawing) of the same block as another chart of its family. Raises Refused when it does not fit."""
    if chart not in family(spec):
        raise Refused(f"this block cannot be drawn as {chart}")
    base = {k: v for k, v in spec.items() if k in COMMON}
    base["chart"] = chart
    base["bind"] = LABEL_VALUE[chart] if chart in LABEL_VALUE else "series"
    filled = fill(database, base)
    return filled, draw(filled, columns)


def alternatives(database, spec: dict) -> list[str]:
    """The other forms this block can take, tried for real: a form the renderer refuses for this data is left out."""
    out = []
    for chart in family(spec):
        if chart == spec.get("chart"):
            continue
        try:
            convert(database, spec, chart)
            out.append(chart)
        except Refused:
            continue
    return out


class Tools:
    def __init__(self, database, report_id: str, mode: str):
        self.db, self.rid, self.mode = database, report_id, mode

    def call(self, name: str, args: dict) -> str:
        handler = {"run_sql": self.run_sql, "set_title": self.set_title, "add_block": self.add_block, "finish": self.finish,
                   "find_groups": self.find_groups, "set_filters": self.set_filters}.get(name)
        if handler is None:
            return f"REFUSED: there is no tool named {name}"
        try:
            return handler(args if isinstance(args, dict) else {})
        except Refused as exc:
            store.event(self.rid, "refusal", name, {"error": str(exc), "args": args})
            return f"REFUSED: {exc}"
        except store.Closed as exc:
            return f"REFUSED: {exc}"

    def run_sql(self, args: dict) -> str:
        try:
            return preview(self.db.run(args.get("query", "")))
        except QueryRefused as exc:
            raise Refused(str(exc)) from exc

    def find_groups(self, args: dict) -> str:
        spec = {"cluster": {"label": args.get("label"), "measures": args.get("measures"), **({"k": args["k"]} if args.get("k") is not None else {})}}
        try:
            return cluster.describe(cluster.from_result(self.db.run(args.get("sql", "")), spec))
        except (QueryRefused, cluster.ClusterError) as exc:
            raise Refused(str(exc)) from exc

    def set_filters(self, args: dict) -> str:
        if self.mode != "dashboard":
            raise Refused("page filters belong to a dashboard")
        if store.block_count(self.rid) > 0:
            raise Refused("set the filters before the first block: the blocks on the page were written without them")
        try:
            defs = filters.define(self.db, args.get("filters"))
        except (filters.FilterError, QueryRefused) as exc:
            raise Refused(str(exc)) from exc
        store.set_filters(self.rid, {"defs": defs, "values": {}, "cross": {}})
        names = ", ".join(":" + p for d in defs for p in filters.params_of(d))
        return (f"ok: the page has {len(defs)} filter(s). Values you can use in a block's sql: {names}. Put each condition in an optional clause, "
                "for example WHERE 1 = 1 [[AND d.name = :department]] [[AND l.spent_on >= :period_from]] [[AND l.spent_on <= :period_to]]. "
                "A clause is left out while its filter is not set.")

    def _follows(self, spec: dict) -> None:
        """On a page with filters, a data block follows at least one of them or says why it does not."""
        defs = store.get_filters(self.rid)["defs"]
        if not defs or not spec.get("bind") or str(spec.get("unfiltered") or "").strip():
            return
        known = {p for d in defs for p in filters.params_of(d)}
        named = filters.names_in(str(spec.get("sql") or ""))
        if named - known:
            raise Refused(f"the sql names filter value(s) this page does not have: {', '.join(':' + n for n in sorted(named - known))}. The page has: {', '.join(':' + n for n in sorted(known))}")
        if not named:
            raise Refused("this block follows none of the page filters. Add the optional clauses to its sql, for example "
                          f"[[AND <column> = :{sorted(known)[0]}]], or add \"unfiltered\": \"<why it must show all the data>\".")

    def set_title(self, args: dict) -> str:
        title = " ".join(str(args.get("title") or "").split())
        if not title:
            raise Refused("title is required")
        if len(title) > 70:
            raise Refused(f"the title has {len(title)} characters; the limit is 70. Shorten it.")
        store.set_title(self.rid, title)
        return "ok"

    def add_block(self, args: dict) -> str:
        spec = args.get("block")
        if not isinstance(spec, dict):
            raise Refused('block must be a JSON object such as {"kind": "kpi", ...}')
        if spec.get("kind") in DATA_KINDS and not spec.get("bind"):
            raise Refused(f'a {spec.get("kind")} block shows data, so it needs "sql" and "bind": the door runs the query and fills the numbers. '
                          "Never type numbers into a block.")
        count = store.block_count(self.rid)
        if count >= MAX_BLOCKS[self.mode]:
            raise Refused(f"the report has {count} blocks, the limit. Call finish.")
        self._follows(spec)
        filled = fill(self.db, spec)
        rendered = draw(filled)
        kind = rendered["chart"]
        if kind is not None and kind in store.chart_kinds(self.rid) and self.mode != "dashboard" and not str(spec.get("repeat_reason") or "").strip():
            raise Refused(f'this report already has a "{kind}" chart. Choose another type by the shape of the data, or add "repeat_reason" '
                          "when the same type is truly right.")
        seq = store.add_block(self.rid, filled, rendered)
        return f"ok: block {seq} is on the page."

    def finish(self, args: dict) -> str:
        suggestions = args.get("suggestions")
        if not isinstance(suggestions, list) or len(suggestions) < 1 or not all(isinstance(s, str) and s.strip() for s in suggestions):
            raise Refused("suggestions must be a list of 3 short questions")
        suggestions = [" ".join(s.split())[:80] for s in suggestions][:3]
        if store.block_count(self.rid) == 0:
            raise Refused("the report is empty: add at least one block before you finish")
        kinds = store.chart_kinds(self.rid)
        if self.mode == "report" and len(kinds) >= 3 and set(kinds) <= BASIC and not store.refused_before(self.rid, "finish", VARIETY):
            raise Refused(f"{VARIETY} ({', '.join(kinds)}). Add one chart that shows a change, a spread, a flow or a second dimension "
                          "(waterfall, heatmap, pareto, treemap, boxplot, sankey, stacked_area, slope, combo, bump, small_multiples, strip), then call finish again.")
        if not store.finish(self.rid, "ok", suggestions=suggestions):
            raise store.Closed("the report is closed")
        return "ok: the report is closed. Stop now."
