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
    assert tools.family(CHART) == ["bar", "hbar", "pareto", "donut", "treemap", "funnel"]
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
    assert tools.alternatives(database, dict(CHART)) == ["bar", "donut", "treemap", "funnel"]


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
