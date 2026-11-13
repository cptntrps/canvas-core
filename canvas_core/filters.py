"""Page filters: one control narrows every block of a dashboard, with no model in the loop.

A block's query carries optional clauses in double square brackets. Each names one or more filter values with a
leading colon:

    SELECT d.name AS label, SUM(l.amount) AS value FROM expense_lines l JOIN departments d ON d.id = l.department_id
    WHERE 1 = 1 [[AND d.name = :department]] [[AND l.spent_on >= :period_from]] [[AND l.spent_on <= :period_to]]
    GROUP BY d.name

A clause is kept when every value it names is set, and left out otherwise, so the query is valid with no filter. A
kept value travels to MySQL as a bound parameter, never as query text: a value cannot change the statement.
"""
from __future__ import annotations

import re

SEGMENT = re.compile(r"\[\[(.*?)\]\]", re.S)
PARAM = re.compile(r":([a-z_][a-z0-9_]*)")
NAME = re.compile(r"^[a-z][a-z0-9_]{0,29}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
KINDS = ("choice", "date_range")
MAX_FILTERS = 4
MAX_OPTIONS = 200


class FilterError(Exception):
    """The filter set or a value is not valid; the text says what to change."""


def names_in(sql: str) -> set[str]:
    """The filter values a query can follow."""
    return {n for seg in SEGMENT.findall(sql or "") for n in PARAM.findall(seg)}


def expand(sql: str, values: dict) -> tuple[str, dict | None]:
    """(query text, bound parameters or None). Clauses whose values are not all set are left out."""
    if "[[" not in (sql or ""):
        return sql, None
    used: dict = {}

    def keep(match):
        inner, named = match.group(1), PARAM.findall(match.group(1))
        if not named or any(values.get(n) in (None, "") for n in named):
            return ""
        used.update({n: values[n] for n in named})
        return PARAM.sub(lambda m: "\u0000" + m.group(1) + "\u0000", inner)

    text = SEGMENT.sub(keep, sql)
    if not used:
        return text, None
    text = text.replace("%", "%%")                      # the driver reads % as a parameter mark
    return re.sub("\u0000([a-z_][a-z0-9_]*)\u0000", r"%(\1)s", text), used


def params_of(definition: dict) -> list[str]:
    p = definition["param"]
    return [p + "_from", p + "_to"] if definition["kind"] == "date_range" else [p]


def define(database, asked) -> list[dict]:
    """The filter set of a page, checked: names, kinds, and the list of values of each choice, read from the database."""
    if not isinstance(asked, list) or not 1 <= len(asked) <= MAX_FILTERS:
        raise FilterError(f"filters must be a list of 1 to {MAX_FILTERS} filters")
    out, seen = [], set()
    for i, f in enumerate(asked):
        if not isinstance(f, dict):
            raise FilterError(f"filters[{i}] must be an object {{name, param, kind, options_sql?}}")
        name, param, kind = " ".join(str(f.get("name") or "").split()), f.get("param"), f.get("kind")
        if not name or len(name) > 24:
            raise FilterError(f"filters[{i}].name is the label the reader sees (1 to 24 characters)")
        if not isinstance(param, str) or not NAME.match(param):
            raise FilterError(f"filters[{i}].param must be a short lower-case name such as department (letters, digits, _)")
        if kind not in KINDS:
            raise FilterError(f"filters[{i}].kind must be one of {', '.join(KINDS)}")
        one = {"name": name, "param": param, "kind": kind}
        if set(params_of(one)) & seen:
            raise FilterError(f"filters[{i}].param \"{param}\" is used twice")
        seen |= set(params_of(one))
        if kind == "choice":
            one["options_sql"] = f.get("options_sql")
            one["options"] = options(database, one)
        out.append(one)
    return out


def options(database, definition: dict) -> list[str]:
    sql = definition.get("options_sql")
    if not isinstance(sql, str) or not sql.strip():
        raise FilterError(f"the choice filter \"{definition['param']}\" needs options_sql: a query that returns its values in one column")
    rows = database.run(sql, MAX_OPTIONS + 1)["rows"]
    found = list(dict.fromkeys(str(r[0]) for r in rows if r and r[0] is not None))
    if len(found) < 2:
        raise FilterError(f"options_sql of \"{definition['param']}\" returned {len(found)} value(s); a filter needs 2 or more")
    if len(found) > MAX_OPTIONS:
        raise FilterError(f"options_sql of \"{definition['param']}\" returned more than {MAX_OPTIONS} values; filter on a column with fewer values")
    return found


def clean(definitions: list[dict], values) -> dict:
    """The values a page can apply: known names only, a choice from its list, dates as YYYY-MM-DD."""
    if not isinstance(values, dict):
        raise FilterError("values must be an object {param: value}")
    out = {}
    for d in definitions:
        for p in params_of(d):
            v = values.get(p)
            if v in (None, ""):
                continue
            v = str(v)
            if d["kind"] == "choice" and v not in d["options"]:
                raise FilterError(f"\"{v}\" is not a value of the filter {d['name']}")
            if d["kind"] == "date_range" and not DATE.match(v):
                raise FilterError(f"{d['name']} takes dates as YYYY-MM-DD")
            out[p] = v
    unknown = set(values) - {p for d in definitions for p in params_of(d)}
    if unknown:
        raise FilterError(f"unknown filter value: {', '.join(sorted(unknown))}")
    return out


class Filtered:
    """A database that applies the page's filter values to every query. `skip` names values this block ignores (the
    chart a cross-filter click came from stays whole)."""

    def __init__(self, database, values: dict | None = None, skip=()):
        self.database, self.values = database, {k: v for k, v in (values or {}).items() if k not in skip}

    def run(self, query: str, max_rows: int = 500) -> dict:
        text, params = expand(query, self.values)
        return self.database.run(text, max_rows, params) if params else self.database.run(text, max_rows)

    def catalog(self) -> str:
        return self.database.catalog()
