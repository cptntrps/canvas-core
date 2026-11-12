"""Cluster analysis: find groups of items that are alike on several measures. Plain code, no model, no extra package.

The method follows what the common BI tools do, so the result is one a reader of those tools expects:
  * each measure is scaled to the range 0 to 1 first, so a measure in thousands does not outweigh one in units;
  * k-means (Lloyd's algorithm, squared Euclidean distance) forms the groups;
  * the number of groups is the one with the best Calinski-Harabasz score, unless the caller fixes it;
  * the same rows always give the same groups (fixed starts, the best of them kept).
The output describes each group in the units of the data, names it by what sets it apart, and scores how well the
groups separate (silhouette), so items that form no real groups are reported as a weak grouping.
"""
from __future__ import annotations

import random

MAX_K = 6
MIN_ROWS = 8
WEAK = 0.4        # silhouette under this: the items do not form clear groups (k-means still splits them)


class ClusterError(Exception):
    """The data cannot be grouped as asked; the text says what to change."""


def _dist(a, b) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b))


def _mean(points):
    n = len(points)
    return [sum(p[i] for p in points) / n for i in range(len(points[0]))]


def _lloyd(points, centers, rounds: int = 60):
    assign = [0] * len(points)
    for _ in range(rounds):
        new = [min(range(len(centers)), key=lambda c: _dist(p, centers[c])) for p in points]
        if new == assign and _ > 0:
            break
        assign = new
        for c in range(len(centers)):
            members = [p for p, a in zip(points, assign) if a == c]
            if members:
                centers[c] = _mean(members)
    sse = sum(_dist(p, centers[a]) for p, a in zip(points, assign))
    return assign, centers, sse


def _starts(points, k):
    """Deterministic starting centres: one spread-out start (farthest points), then seeded k-means++ starts."""
    overall = _mean(points)
    first = max(range(len(points)), key=lambda i: _dist(points[i], overall))
    chosen = [first]
    while len(chosen) < k:
        chosen.append(max(range(len(points)), key=lambda i: min(_dist(points[i], points[c]) for c in chosen)))
    yield [list(points[i]) for i in chosen]
    for seed in range(6):
        rng = random.Random(1000 + seed * 17 + k)
        picks = [rng.randrange(len(points))]
        while len(picks) < k:
            weights = [min(_dist(p, points[c]) for c in picks) for p in points]
            total = sum(weights)
            if total == 0:
                break
            r, acc = rng.random() * total, 0.0
            for i, w in enumerate(weights):
                acc += w
                if acc >= r:
                    picks.append(i)
                    break
        if len(picks) == k:
            yield [list(points[i]) for i in picks]


def kmeans(points, k):
    best = None
    for centers in _starts(points, k):
        assign, centers, sse = _lloyd(points, centers)
        if len(set(assign)) == k and (best is None or sse < best[2] - 1e-12):
            best = (assign, centers, sse)
    return best


def silhouette(points, assign, k) -> float:
    """How well each item sits in its own group against the nearest other group, -1 to 1, averaged. Points spread
    evenly with no groups score about 0.3; clear groups score over 0.6. Variation explained cannot tell these apart:
    k-means explains more than half of the variation of evenly spread points too."""
    members = [[i for i, a in enumerate(assign) if a == c] for c in range(k)]
    total = 0.0
    for i, p in enumerate(points):
        own = members[assign[i]]
        if len(own) == 1:
            continue                                   # a group of one item scores 0
        a = sum(_dist(p, points[j]) ** 0.5 for j in own if j != i) / (len(own) - 1)
        b = min(sum(_dist(p, points[j]) ** 0.5 for j in other) / len(other) for c, other in enumerate(members) if c != assign[i] and other)
        total += (b - a) / max(a, b) if max(a, b) > 0 else 0.0
    return total / len(points)


def analyse(labels: list, rows: list[list[float]], measures: list[str], k: int | None = None) -> dict:
    """labels[i] names row i; rows[i] holds its measures. -> the groups, their profiles and the strength."""
    n = len(rows)
    if len(measures) < 2:
        raise ClusterError("give 2 to 6 measures per item: one measure alone is a ranking, not a grouping")
    if len(measures) > 6:
        raise ClusterError("give 6 measures at most: more than that and the groups stop meaning anything a reader can name")
    if n < MIN_ROWS:
        raise ClusterError(f"only {n} items: groups need {MIN_ROWS} or more (one row per item, for example per vendor or per employee)")
    for i, row in enumerate(rows):
        for j, v in enumerate(row):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise ClusterError(f"measure \"{measures[j]}\" is not a number for \"{labels[i]}\": every measure must be numeric and not NULL (use COALESCE)")
    low = [min(r[j] for r in rows) for j in range(len(measures))]
    high = [max(r[j] for r in rows) for j in range(len(measures))]
    flat = [measures[j] for j in range(len(measures)) if high[j] == low[j]]
    if flat:
        raise ClusterError(f"measure \"{flat[0]}\" has the same value for every item, so it cannot separate groups: leave it out")
    points = [[(r[j] - low[j]) / (high[j] - low[j]) for j in range(len(measures))] for r in rows]
    overall = _mean(points)
    sst = sum(_dist(p, overall) for p in points)
    limit = min(MAX_K, n // 3)
    if k is not None:
        if isinstance(k, bool) or not isinstance(k, int) or not 2 <= k <= MAX_K:
            raise ClusterError(f"k must be a whole number from 2 to {MAX_K}; leave it out to let the data choose")
        if k > limit:
            raise ClusterError(f"{n} items are too few for {k} groups")
    best = None
    for candidate in ([k] if k else range(2, limit + 1)):
        result = kmeans(points, candidate)
        if result is None:
            continue
        assign, centers, sse = result
        ch = ((sst - sse) / (candidate - 1)) / (sse / (n - candidate)) if sse > 0 else float("inf")
        if best is None or ch > best["ch"]:
            best = {"k": candidate, "assign": assign, "sse": sse, "ch": ch}
    if best is None:
        raise ClusterError("the items do not separate into groups on these measures")
    k, assign = best["k"], best["assign"]
    order = sorted(range(k), key=lambda c: -sum(1 for a in assign if a == c))
    rank = {c: i for i, c in enumerate(order)}
    assign = [rank[a] for a in assign]
    explained = 1 - best["sse"] / sst if sst > 0 else 0.0
    groups, used = [], set()
    for g in range(k):
        members = [i for i, a in enumerate(assign) if a == g]
        means = [sum(rows[i][j] for i in members) / len(members) for j in range(len(measures))]
        scaled = [sum(points[i][j] for i in members) / len(members) - overall[j] for j in range(len(measures))]
        traits = sorted(range(len(measures)), key=lambda j: -abs(scaled[j]))
        words = [("high " if scaled[j] > 0 else "low ") + measures[j].replace("_", " ") for j in traits[:2] if abs(scaled[j]) >= 0.12]
        name = ", ".join(words).capitalize() if words else "Typical"
        while name in used:
            name += " (2)"
        used.add(name)
        groups.append({"name": name, "items": len(members), "means": means, "members": members})
    separation = []
    for j, measure in enumerate(measures):
        total = sum((p[j] - overall[j]) ** 2 for p in points)
        within = 0.0
        for g in groups:
            centre = sum(points[i][j] for i in g["members"]) / g["items"]
            within += sum((points[i][j] - centre) ** 2 for i in g["members"])
        separation.append({"measure": measure, "explained": 1 - within / total if total > 0 else 0.0})
    score = silhouette(points, assign, k)
    return {"k": k, "items": n, "measures": measures, "assign": assign, "groups": groups, "explained": explained,
            "silhouette": score, "weak": score < WEAK,
            "separation": sorted(separation, key=lambda s: -s["explained"]), "labels": [str(v) for v in labels]}


def from_result(result: dict, spec: dict) -> dict:
    """Run the analysis on a query result ({"columns", "rows"}) as the block's "cluster" field asks."""
    ask = spec.get("cluster")
    if not isinstance(ask, dict):
        raise ClusterError('a cluster block needs "cluster": {"label": "<column>", "measures": ["<column>", ...]}')
    columns = result["columns"]
    label, measures = ask.get("label"), ask.get("measures")
    if label not in columns:
        raise ClusterError(f'cluster.label "{label}" is not a column of the query ({", ".join(columns)})')
    if not isinstance(measures, list) or any(m not in columns for m in measures):
        raise ClusterError(f'cluster.measures must name columns of the query ({", ".join(columns)})')
    if len(result["rows"]) >= 500:
        raise ClusterError("the query returned the row limit: group at most 499 items (aggregate to one row per item, keep the largest)")
    li, mi = columns.index(label), [columns.index(m) for m in measures]
    return analyse([r[li] for r in result["rows"]], [[r[i] for i in mi] for r in result["rows"]], measures, ask.get("k"))


def describe(found: dict, examples: int = 5) -> str:
    """The analysis in words, for the model to read before it writes about the groups."""
    strength = "clear" if found["silhouette"] >= 0.6 else "fair" if found["silhouette"] >= WEAK else "WEAK"
    lines = [f"{found['k']} groups among {found['items']} items. Separation: {strength} (silhouette {found['silhouette']:.2f}; the groups explain "
             f"{found['explained']:.0%} of the variation)."
             + (" WEAK means the items do not form clear groups: say so, or try other measures." if found["weak"] else "")]
    for g in found["groups"]:
        means = ", ".join(f"{m} {v:,.2f}" for m, v in zip(found["measures"], g["means"]))
        names = ", ".join(found["labels"][i] for i in g["members"][:examples])
        lines.append(f"- {g['name']}: {g['items']} items; average {means}; for example {names}")
    lines.append("What separates the groups most: " + ", ".join(f"{s['measure']} ({s['explained']:.0%})" for s in found["separation"]))
    return "\n".join(lines)


def display_names(found: dict, ask: dict) -> list[str]:
    """The name shown for each group. `group_names` maps the door's own name of a group to the words the reader
    should see ({"High avg ticket, low lines": "Rare big-ticket"}). The key is the door's name and not the position,
    so after a refresh a name can never land on another group: a group whose own name changed shows its own name."""
    given = ask.get("group_names") if isinstance(ask.get("group_names"), dict) else {}
    out = []
    for g in found["groups"]:
        name = given.get(g["name"])
        out.append(" ".join(str(name).split())[:40] if isinstance(name, str) and name.strip() else g["name"])
    return out


def scatter_groups(found: dict, result: dict, x: str, y: str, names: list[str] | None = None) -> list[dict]:
    columns = result["columns"]
    if x not in found["measures"] or y not in found["measures"] or x == y:
        raise ClusterError(f'cluster.x and cluster.y must be two different measures of {found["measures"]}')
    xi, yi = columns.index(x), columns.index(y)
    names = names or [g["name"] for g in found["groups"]]
    out = []
    for g, name in zip(found["groups"], names):
        points = [{"x": result["rows"][i][xi], "y": result["rows"][i][yi], "label": found["labels"][i]} for i in g["members"]]
        if any(p["x"] < 0 or p["y"] < 0 for p in points):
            raise ClusterError("the scatter axes start at zero: choose x and y measures that are never negative")
        out.append({"name": name[:40], "points": points})
    return out


def profile_rows(found: dict, names: list[str] | None = None) -> list[list]:
    names = names or [g["name"] for g in found["groups"]]
    return [[name, g["items"]] + [round(v, 2) for v in g["means"]] for g, name in zip(found["groups"], names)]


def size_rows(found: dict, names: list[str] | None = None) -> list[dict]:
    names = names or [g["name"] for g in found["groups"]]
    return [{"label": name, "value": g["items"]} for g, name in zip(found["groups"], names)]
