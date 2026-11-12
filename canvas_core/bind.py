"""Fill a block's data from its query, so every number on the page comes from the database and not from the model.

The agent sends a block with `sql` and `bind` and without the data. The door runs the query and puts the rows where
`bind` says. A pinned report refreshes the same way, with no model in the loop.

  bind = "<key>"   the rows become spec[key] as a list of objects, one per row, keyed by column name
                   (bar and hbar `data`, donut `slices`, kpi `items`, heatmap `cells`, map `points`, ...)
  bind = "series"  wide form for line, area, stacked_area, grouped, small_multiples and bump (combo: label, bars, line): the first column is the label of each point,
                   every other column is one series named by its column
  a table          bind = "rows": each row becomes a list in column order
"""
from __future__ import annotations

WIDE = {"line": "labels", "area": "labels", "stacked_area": "labels", "grouped": "categories", "small_multiples": "labels", "bump": "labels"}


class BindError(Exception):
    """The block and its query do not fit; the text says what to change."""


def apply(spec: dict, result: dict) -> dict:
    """A copy of spec with the data of `result` ({"columns", "rows"}) placed by spec["bind"]."""
    key = spec.get("bind")
    columns, rows = result["columns"], result["rows"]
    if not isinstance(key, str) or not key:
        raise BindError('"bind" must name the field that takes the rows, for example "data", "slices", "items" or "series"')
    if not rows:
        raise BindError("the query returned no rows: check its filters and dates, or say in an insight that there is no data")
    out = {k: v for k, v in spec.items()}
    if key == "series" and spec.get("chart") == "combo":
        if len(columns) != 3:
            raise BindError("a combo query returns 3 columns: the label, the measure of the bars, the measure of the line")
        out["labels"] = [str(r[0]) for r in rows]
        out["bars"] = {"name": columns[1], "values": [r[1] for r in rows]}
        out["line"] = {"name": columns[2], "values": [r[2] for r in rows]}
        return out
    if key == "series":
        label_key = WIDE.get(spec.get("chart"))
        if label_key is None:
            raise BindError('"bind": "series" works for line, area, stacked_area, grouped, small_multiples, bump and combo')
        if len(columns) < 2:
            raise BindError("a series query needs the label column first and one column per series after it")
        out[label_key] = [str(r[0]) for r in rows]
        out["series"] = [{"name": columns[i], "values": [r[i] for r in rows]} for i in range(1, len(columns))]
        return out
    if spec.get("kind") == "table" and key == "rows":
        out["rows"] = [list(r) for r in rows]
        return out
    out[key] = [dict(zip(columns, r)) for r in rows]
    if spec.get("chart") == "gantt":
        for row in out[key]:
            for field in ("start", "end"):
                if row.get(field) is not None:
                    row[field] = str(row[field])[:10]
    if spec.get("chart") == "heatmap" and key == "cells":
        for field in ("row", "col"):
            if field not in columns:
                raise BindError('a heatmap query returns the columns "row", "col" and "value"')
        out.setdefault("rows", list(dict.fromkeys(str(c["row"]) for c in out[key])))
        out.setdefault("cols", list(dict.fromkeys(str(c["col"]) for c in out[key])))
    return out
