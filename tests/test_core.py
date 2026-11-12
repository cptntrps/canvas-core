"""The rules that keep a report honest: the read-only guard, the binding of a query to a block, and the tool rules."""
import pytest

from canvas_core import bind, db, store, tools


# ---- the read-only guard ---------------------------------------------------------------------------------------

@pytest.mark.parametrize("query", [
    "SELECT 1", "  select * from t where note = 'please delete this; drop it' ", "WITH a AS (SELECT 1) SELECT * FROM a",
    "SHOW TABLES", "DESCRIBE expense_lines", "SELECT `update`, created FROM t -- insert a comment\n", "select 1;"])
def test_reading_statements_pass(query):
    assert db.check_read_only(query)


@pytest.mark.parametrize("query", [
    "", "DELETE FROM t", "SELECT 1; DROP TABLE t", "UPDATE t SET a = 1", "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    "INSERT INTO t VALUES (1)", "/* hide */ TRUNCATE t", "SET SESSION sql_mode = ''", "CALL wipe()", "select 1 union select 2; delete from t"])
def test_everything_else_is_refused(query):
    with pytest.raises(db.QueryRefused):
        db.check_read_only(query)


def test_a_word_inside_a_string_or_a_name_is_not_a_command():
    assert db.check_read_only("SELECT * FROM t WHERE action = 'delete' AND col = \"drop\"")


# ---- binding: the numbers come from the query ------------------------------------------------------------------

def result(columns, rows):
    return {"columns": columns, "rows": rows}


def test_rows_become_the_named_field():
    spec = {"kind": "chart", "chart": "hbar", "bind": "data", "sql": "..."}
    out = bind.apply(spec, result(["label", "value"], [["Sales", 10.5], ["Ops", 3]]))
    assert out["data"] == [{"label": "Sales", "value": 10.5}, {"label": "Ops", "value": 3}] and "data" not in spec


def test_series_takes_the_first_column_as_labels():
    out = bind.apply({"kind": "chart", "chart": "line", "bind": "series"}, result(["month", "Travel", "Events"], [["2026-01", 5, 9], ["2026-02", 6, 8]]))
    assert out["labels"] == ["2026-01", "2026-02"]
    assert out["series"] == [{"name": "Travel", "values": [5, 6]}, {"name": "Events", "values": [9, 8]}]
    grouped = bind.apply({"kind": "chart", "chart": "grouped", "bind": "series"}, result(["q", "A"], [["Q1", 1]]))
    assert grouped["categories"] == ["Q1"]


def test_a_table_takes_rows_as_lists_and_a_heatmap_gets_its_axes():
    table = bind.apply({"kind": "table", "bind": "rows"}, result(["d", "v"], [["2026-01-02", 4]]))
    assert table["rows"] == [["2026-01-02", 4]]
    heat = bind.apply({"kind": "chart", "chart": "heatmap", "bind": "cells"}, result(["row", "col", "value"], [["Mon", "Jan", 1], ["Tue", "Jan", 2], ["Mon", "Feb", 3]]))
    assert heat["rows"] == ["Mon", "Tue"] and heat["cols"] == ["Jan", "Feb"]


def test_a_combo_takes_bars_and_a_line_and_a_gantt_takes_dates_as_text():
    import datetime
    combo = bind.apply({"kind": "chart", "chart": "combo", "bind": "series"}, result(["month", "Spend", "Invoices"], [["2026-01", 500.0, 7], ["2026-02", 620.0, 9]]))
    assert combo["labels"] == ["2026-01", "2026-02"]
    assert combo["bars"] == {"name": "Spend", "values": [500.0, 620.0]} and combo["line"] == {"name": "Invoices", "values": [7, 9]}
    with pytest.raises(bind.BindError, match="3 columns"):
        bind.apply({"kind": "chart", "chart": "combo", "bind": "series"}, result(["month", "Spend"], [["2026-01", 5]]))
    gantt = bind.apply({"kind": "chart", "chart": "gantt", "bind": "rows"}, result(["label", "start", "end"], [["Offsite", datetime.date(2026, 3, 2), datetime.datetime(2026, 3, 6, 9, 0)]]))
    assert gantt["rows"] == [{"label": "Offsite", "start": "2026-03-02", "end": "2026-03-06"}]
    for chart in ("small_multiples", "bump"):
        assert bind.apply({"kind": "chart", "chart": chart, "bind": "series"}, result(["q", "A", "B"], [["Q1", 1, 2]]))["labels"] == ["Q1"]


def test_the_real_renderer_draws_every_new_form():
    from canvas_core import render
    base = {"kind": "chart", "title": "T", "takeaway": "A finding", "source": "s", "data_through": "2026-11-01"}
    months, series = ["Jan", "Feb", "Mar"], [{"name": "A", "values": [3, 5, 4]}, {"name": "B", "values": [4, 2, 6]}]
    forms = {
        "combo": {"labels": months, "bars": {"name": "Spend", "values": [5, 6, 7]}, "line": {"name": "Count", "values": [2, 1, 3]}, "line_axis": {"format": "integer"}},
        "small_multiples": {"labels": months, "series": series}, "bump": {"labels": months, "series": series},
        "bubbles": {"items": [{"label": "a", "value": 5}, {"label": "b", "value": 3}, {"label": "c", "value": 1}]},
        "gantt": {"rows": [{"label": "One", "start": "2026-01-05", "end": "2026-02-01"}, {"label": "Two", "start": "2026-01-20", "end": "2026-03-01", "group": "g"}]},
        "strip": {"points": [{"label": "x", "value": v} for v in (1, 2, 3, 4)] + [{"label": "y", "value": 9, "name": "big"}]},
    }
    for chart, fields in forms.items():
        drawn = render.render_block({**base, "chart": chart, **fields})
        assert drawn["chart"] == chart and "<svg" in drawn["html"] and "<title>" in drawn["html"], chart
    with pytest.raises(render.Refused, match="ends before"):
        render.render_block({**base, "chart": "gantt", "rows": [{"label": "a", "start": "2026-02-01", "end": "2026-01-01"}, {"label": "b", "start": "2026-01-01", "end": "2026-01-02"}]})


def test_binding_refuses_what_does_not_fit():
    with pytest.raises(bind.BindError, match="no rows"):
        bind.apply({"kind": "chart", "chart": "bar", "bind": "data"}, result(["label", "value"], []))
    with pytest.raises(bind.BindError, match="series"):
        bind.apply({"kind": "chart", "chart": "donut", "bind": "series"}, result(["a", "b"], [[1, 2]]))
    with pytest.raises(bind.BindError, match="row"):
        bind.apply({"kind": "chart", "chart": "heatmap", "bind": "cells"}, result(["a", "b", "value"], [[1, 2, 3]]))


# ---- the tools ---------------------------------------------------------------------------------------------------

class FakeDB:
    def __init__(self):
        self.queries = []

    def run(self, query, max_rows=500):
        self.queries.append(query)
        db.check_read_only(query)
        return {"columns": ["label", "value"], "rows": [["Travel", 120.0], ["Events", 80.0]], "truncated": False}


@pytest.fixture
def desk(tmp_path, monkeypatch):
    store.open_store(str(tmp_path / "t.db"))
    drawn = []

    def fake_render(spec):
        drawn.append(spec)
        if spec.get("kind") == "chart" and not spec.get("takeaway"):
            raise tools.render.Refused("takeaway is required")
        return {"kind": spec["kind"], "chart": spec.get("chart"), "html": "<section>x</section>"}

    monkeypatch.setattr(tools.render, "render_block", fake_render)
    database = FakeDB()

    def make(mode="report"):
        rid = store.create_report("q", mode)
        return tools.Tools(database, rid, mode), rid
    return make, database, drawn


CHART = {"kind": "chart", "chart": "hbar", "title": "T", "takeaway": "Travel leads", "source": "s", "data_through": "2026-11-01",
         "sql": "SELECT label, value FROM v", "bind": "data"}


def test_a_data_block_without_a_query_is_refused(desk):
    make, _, _ = desk
    t, _ = make()
    typed = {k: v for k, v in CHART.items() if k not in ("sql", "bind")} | {"data": [{"label": "Travel", "value": 999}]}
    assert "Never type numbers" in t.call("add_block", {"block": typed})
    assert "REFUSED" in t.call("add_block", {"block": {"kind": "kpi", "items": [{"label": "x", "value": 1}]}})


def test_the_door_fills_the_block_from_the_query_and_never_draws_the_sql(desk):
    make, database, drawn = desk
    t, rid = make()
    assert t.call("add_block", {"block": dict(CHART)}).startswith("ok")
    assert database.queries == ["SELECT label, value FROM v"]
    assert drawn[-1]["data"] == [{"label": "Travel", "value": 120.0}, {"label": "Events", "value": 80.0}]
    assert "sql" not in drawn[-1] and "bind" not in drawn[-1]
    saved = store.get_report(rid, with_spec=True)["blocks"][0]["spec"]
    assert saved["sql"] == CHART["sql"] and saved["bind"] == "data", "the stored block keeps its query, so it can refresh"


def test_words_need_no_query_and_a_bad_query_is_refused(desk):
    make, _, _ = desk
    t, _ = make()
    assert t.call("add_block", {"block": {"kind": "insight", "title": "A", "text": "B"}}).startswith("ok")
    assert "REFUSED" in t.call("add_block", {"block": dict(CHART, sql="DELETE FROM v")})
    assert "REFUSED" in t.call("run_sql", {"query": "DROP TABLE v"})


def test_the_same_chart_twice_needs_a_reason_except_on_a_dashboard(desk):
    make, _, _ = desk
    t, _ = make("report")
    t.call("add_block", {"block": dict(CHART)})
    assert "already has" in t.call("add_block", {"block": dict(CHART)})
    assert t.call("add_block", {"block": dict(CHART, repeat_reason="two rankings side by side")}).startswith("ok")
    d, _ = make("dashboard")
    d.call("add_block", {"block": dict(CHART)})
    assert d.call("add_block", {"block": dict(CHART)}).startswith("ok")


def test_finish_needs_a_block_and_a_report_of_basic_charts_is_pushed_once(desk):
    make, _, _ = desk
    t, rid = make("report")
    assert "empty" in t.call("finish", {"suggestions": ["a?", "b?", "c?"]})
    for chart in ("hbar", "bar", "donut"):
        t.call("add_block", {"block": dict(CHART, chart=chart, bind="slices" if chart == "donut" else "data")})
    assert "only basic charts" in t.call("finish", {"suggestions": ["a?"]})
    assert t.call("finish", {"suggestions": ["a?"]}).startswith("ok")
    assert store.get_report(rid)["status"] == "ok"
    assert "REFUSED" in t.call("set_title", {"title": "late"})


def test_an_answer_has_a_small_block_limit(desk):
    make, _, _ = desk
    t, _ = make("answer")
    for i in range(tools.MAX_BLOCKS["answer"]):
        assert t.call("add_block", {"block": {"kind": "insight", "title": f"A{i}", "text": "B"}}).startswith("ok")
    assert "limit" in t.call("add_block", {"block": {"kind": "insight", "title": "more", "text": "B"}})


# ---- the same query in another chart form ----------------------------------------------------------------------

def test_a_block_changes_form_inside_its_family_and_keeps_its_query(desk):
    make, database, drawn = desk
    assert tools.family(CHART) == ["bar", "hbar", "pareto", "donut", "treemap", "funnel", "bubbles"]
    filled, rendered = tools.convert(database, dict(CHART, highlight=[0]), "donut")
    assert rendered["chart"] == "donut" and filled["bind"] == "slices" and filled["sql"] == CHART["sql"]
    assert filled["slices"] == [{"label": "Travel", "value": 120.0}, {"label": "Events", "value": 80.0}]
    assert "data" not in filled and "highlight" not in filled, "fields of the old form do not travel"
    with pytest.raises(tools.Refused):
        tools.convert(database, dict(CHART), "line")
    assert tools.family({"kind": "chart", "chart": "heatmap", "bind": "cells"}) == []
    assert tools.family({"kind": "kpi", "bind": "items"}) == []


def test_alternatives_leave_out_the_current_form_and_any_form_the_renderer_refuses(desk, monkeypatch):
    make, database, _ = desk

    def picky(spec):
        if spec.get("chart") == "pareto":
            raise tools.render.Refused("pareto needs 3 bars")
        return {"kind": "chart", "chart": spec["chart"], "html": "<section/>"}
    monkeypatch.setattr(tools.render, "render_block", picky)
    assert tools.alternatives(database, dict(CHART)) == ["bar", "donut", "treemap", "funnel", "bubbles"]


# ---- the Claude adapter: the transcript the SDK needs -----------------------------------------------------------

class _Block:
    def __init__(self, **fields):
        self.__dict__.update(fields)


def _claude(monkeypatch, replies):
    from canvas_core import config, models
    sent = []

    class FakeMessages:
        def create(self, **kwargs):
            sent.append({**kwargs, "messages": list(kwargs["messages"])})
            return replies.pop(0)

    class FakeClient:
        def __init__(self, **kwargs):
            self.kwargs, self.messages = kwargs, FakeMessages()

    import anthropic
    made = {}
    monkeypatch.setattr(anthropic, "AnthropicFoundry", lambda **kw: made.setdefault("foundry", FakeClient(**kw)))
    monkeypatch.setattr(anthropic, "Anthropic", lambda **kw: made.setdefault("anthropic", FakeClient(**kw)))
    monkeypatch.setenv("TEST_MODEL_KEY", "k")
    settings = config.Settings(model={"kind": "claude", "platform": "foundry", "resource": "my-resource", "model": "my-deployment", "api_key_env": "TEST_MODEL_KEY"})
    return models.connect(settings, "brief", tools.SCHEMAS), sent, made


def test_claude_on_azure_uses_the_foundry_client_and_keeps_the_whole_turn(monkeypatch):
    thinking = _Block(type="thinking", thinking="", signature="s")
    call_a = _Block(type="tool_use", id="t1", name="run_sql", input={"query": "SELECT 1"})
    call_b = _Block(type="tool_use", id="t2", name="set_title", input={"title": "T"})
    reply = _Block(content=[thinking, call_a, call_b], stop_reason="tool_use")
    done = _Block(content=[_Block(type="text", text="done")], stop_reason="end_turn")
    model, sent, made = _claude(monkeypatch, [reply, done])
    assert "foundry" in made and made["foundry"].kwargs["resource"] == "my-resource"
    model.user("go")
    step = model.step()
    assert [c["name"] for c in step["calls"]] == ["run_sql", "set_title"]
    assert sent[0]["model"] == "my-deployment" and sent[0]["tools"][0]["input_schema"]["type"] == "object"
    assert "thinking" not in sent[0], "thinking is left to the model's default"
    model.results([(step["calls"][0], "ok"), (step["calls"][1], "REFUSED: too long")])
    model.step()
    history = sent[1]["messages"]
    assert history[1]["content"] == [thinking, call_a, call_b], "the assistant turn goes back unchanged, thinking block included"
    results = history[2]["content"]
    assert [r["tool_use_id"] for r in results] == ["t1", "t2"], "every result of the turn in one user message"
    assert "is_error" not in results[0] and results[1]["is_error"] is True


def test_a_refusal_and_a_cut_answer_are_errors_with_words(monkeypatch):
    from canvas_core import models
    model, _, _ = _claude(monkeypatch, [_Block(content=[], stop_reason="refusal")])
    model.user("go")
    with pytest.raises(models.ModelError, match="declined"):
        model.step()
    model, _, _ = _claude(monkeypatch, [_Block(content=[_Block(type="text", text="half")], stop_reason="max_tokens")])
    model.user("go")
    with pytest.raises(models.ModelError, match="max_tokens"):
        model.step()


# ---- cluster analysis --------------------------------------------------------------------------------------------

import random as _random

from canvas_core import cluster, layouts


def _blobs(seed=3, per=20, centres=((10, 100000), (60, 110000), (35, 900000))):
    rng = _random.Random(seed)
    labels, rows = [], []
    for c, (x, y) in enumerate(centres):
        for i in range(per):
            labels.append(f"item{c}_{i}")
            rows.append([x + rng.gauss(0, 3), y + rng.gauss(0, 20000)])
    return labels, rows


def test_three_planted_groups_are_found_with_no_k_given():
    labels, rows = _blobs()
    found = cluster.analyse(labels, rows, ["trips", "spend"])
    assert found["k"] == 3 and [g["items"] for g in found["groups"]] == [20, 20, 20]
    assert found["explained"] > 0.9 and found["silhouette"] > 0.7 and not found["weak"]
    for g in found["groups"]:
        assert len({labels[i].split("_")[0] for i in g["members"]}) == 1, "each found group is one planted group"


def test_a_measure_in_large_units_does_not_outweigh_one_in_small_units():
    # The groups differ ONLY in trips (10 against 60). Spend is noise in the hundreds of thousands.
    rng = _random.Random(5)
    rows = [[10 + rng.gauss(0, 2), 500000 + rng.gauss(0, 40000)] for _ in range(25)] + [[60 + rng.gauss(0, 2), 500000 + rng.gauss(0, 40000)] for _ in range(25)]
    found = cluster.analyse([f"i{i}" for i in range(50)], rows, ["trips", "spend"], k=2)
    assert [g["items"] for g in found["groups"]] == [25, 25]
    assert found["separation"][0]["measure"] == "trips" and found["separation"][0]["explained"] > 0.9


def test_the_same_rows_give_the_same_groups_and_names_say_what_sets_a_group_apart():
    labels, rows = _blobs()
    a, b = cluster.analyse(labels, rows, ["trips", "spend"]), cluster.analyse(labels, rows, ["trips", "spend"])
    assert a["assign"] == b["assign"] and [g["name"] for g in a["groups"]] == [g["name"] for g in b["groups"]]
    names = [g["name"] for g in a["groups"]]
    assert len(set(names)) == 3 and any("spend" in n and n.startswith("High") for n in names)
    text = cluster.describe(a)
    assert text.startswith("3 groups among 60 items") and "What separates the groups most" in text


def test_items_with_no_structure_are_reported_as_weak():
    rng = _random.Random(9)
    found = cluster.analyse([f"i{i}" for i in range(80)], [[rng.random(), rng.random(), rng.random()] for _ in range(80)], ["a", "b", "c"])
    assert found["silhouette"] < 0.4 and found["weak"] and "WEAK" in cluster.describe(found)
    assert found["explained"] > 0.5, "variation explained looks good even here, which is why it is not the test"


@pytest.mark.parametrize("labels,rows,measures,k,words", [
    (["a"] * 5, [[1, 2]] * 5, ["x", "y"], None, "only 5 items"),
    (["a"] * 12, [[i, 2] for i in range(12)], ["x", "y"], None, "same value"),
    (["a"] * 12, [[i, None] for i in range(12)], ["x", "y"], None, "not a number"),
    (["a"] * 12, [[i, i * 2] for i in range(12)], ["x"], None, "2 to 6 measures"),
    (["a"] * 12, [[i, i * 2] for i in range(12)], ["x", "y"], 9, "k must be"),
    (["a"] * 12, [[i, i * 2] for i in range(12)], ["x", "y"], 5, "too few"),
])
def test_what_cannot_be_grouped_is_refused_with_the_reason(labels, rows, measures, k, words):
    with pytest.raises(cluster.ClusterError, match=words):
        cluster.analyse(labels, [r[:len(measures)] for r in rows], measures, k)


class ClusterDB:
    def run(self, query, max_rows=500):
        labels, rows = _blobs()
        return {"columns": ["label", "trips", "spend"], "rows": [[l, *r] for l, r in zip(labels, rows)], "truncated": False}


def test_a_cluster_block_and_its_profile_are_filled_by_the_door(desk):
    ask = {"label": "label", "measures": ["trips", "spend"], "x": "trips", "y": "spend"}
    scatter = tools.fill(ClusterDB(), {"kind": "chart", "chart": "scatter", "takeaway": "three kinds", "sql": "SELECT ...", "bind": "cluster", "cluster": ask})
    assert len(scatter["groups"]) == 3 and sum(len(g["points"]) for g in scatter["groups"]) == 60
    assert all(len(g["name"]) <= 22 and set(g["points"][0]) == {"x", "y", "label"} for g in scatter["groups"])
    table = tools.fill(ClusterDB(), {"kind": "table", "title": "Profiles", "sql": "SELECT ...", "bind": "cluster_profile", "cluster": ask})
    assert [c["name"] for c in table["columns"]] == ["Group", "Items", "trips", "spend"] and len(table["rows"]) == 3 and table["rows"][0][1] == 20
    make, _, drawn = desk
    assert "cluster" not in tools.draw(scatter) and "cluster" not in drawn[-1], "the cluster settings are not sent to the renderer"
    with pytest.raises(tools.Refused, match="not a column"):
        tools.fill(ClusterDB(), {"kind": "chart", "chart": "scatter", "sql": "SELECT ...", "bind": "cluster", "cluster": {"label": "nope", "measures": ["trips", "spend"]}})


def test_find_groups_tells_the_model_what_the_groups_are(desk):
    make, _, _ = desk
    t, _ = make()
    t.db = ClusterDB()
    text = t.call("find_groups", {"sql": "SELECT ...", "label": "label", "measures": ["trips", "spend"]})
    assert text.startswith("3 groups among 60 items") and "for example item" in text
    assert "REFUSED" in t.call("find_groups", {"sql": "SELECT ...", "label": "label", "measures": ["trips"]})


def test_a_dashboard_layout_is_named_or_left_to_the_agent():
    assert "Plan against actual" in layouts.instruction("plan") and "bullet" in layouts.instruction("plan")
    auto = layouts.instruction(None)
    assert all(name in auto for name, _, _ in layouts.LAYOUTS.values())
    assert [l["key"] for l in layouts.names()] == ["overview", "trend", "plan", "ranking", "segments"]


def test_group_names_follow_the_group_and_not_its_position(desk):
    labels, rows = _blobs()
    found = cluster.analyse(labels, rows, ["trips", "spend"])
    own = [g["name"] for g in found["groups"]]
    assert all("_" not in n for n in own)
    ask = {"label": "label", "measures": ["trips", "spend"], "x": "trips", "y": "spend", "group_names": {own[1]: "Road warriors", "A name of no group": "Ghost"}}
    assert cluster.display_names(found, ask) == [own[0], "Road warriors", own[2]]
    scatter = tools.fill(ClusterDB(), {"kind": "chart", "chart": "scatter", "sql": "SELECT ...", "bind": "cluster", "cluster": ask})
    assert [g["name"] for g in scatter["groups"]] == [own[0], "Road warriors", own[2]]
    sizes = tools.fill(ClusterDB(), {"kind": "chart", "chart": "hbar", "sql": "SELECT ...", "bind": "cluster_sizes", "cluster": ask})
    assert sizes["data"] == [{"label": own[0], "value": 20}, {"label": "Road warriors", "value": 20}, {"label": own[2], "value": 20}]
    donut = tools.fill(ClusterDB(), {"kind": "chart", "chart": "donut", "sql": "SELECT ...", "bind": "cluster_sizes", "cluster": ask})
    assert len(donut["slices"]) == 3
    with pytest.raises(tools.Refused, match="cluster_sizes"):
        tools.fill(ClusterDB(), {"kind": "chart", "chart": "line", "sql": "SELECT ...", "bind": "cluster_sizes", "cluster": ask})
    assert tools.family({"kind": "chart", "chart": "hbar", "bind": "cluster_sizes"}) == [], "a cluster view does not change form"
