"""Dashboard layouts: proven arrangements for a standing view, by purpose. The person picks one, or "auto" lets the
agent pick by the subject. A layout says which blocks to build and in which order; the agent still writes the queries."""

LAYOUTS = {
    "overview": ("Executive overview", "the state of one subject on one screen",
                 "1) one kpi block: the 4 numbers that matter, each with its change against the period before. "
                 "2) the main measure over time (line or area, 12 or more periods). 3) its composition (donut or treemap). "
                 "4) a ranking of the top 8 to 10 units (hbar). 5) one table with the 10 largest single items."),
    "trend": ("Trend and breakdown", "how a measure moves and what moves it",
              "1) one kpi block: this period, the period before, the change, the average per period. "
              "2) the measure over time (line). 3) the same over time split by its main category (stacked_area). "
              "4) a heatmap of category by month. 5) a slope chart: each category in the first and the last period. "
              "6) a table of the periods with the largest change."),
    "plan": ("Plan against actual", "spend or results against a budget, a target or a forecast",
             "1) one kpi block: actual, plan, the difference, percent of plan used. 2) a bullet chart: actual against plan per unit. "
             "3) a diverging chart of the difference per unit, sorted from the largest overrun. 4) actual and plan over time (line with two series). "
             "5) a table of the 10 lines that explain most of the overrun."),
    "ranking": ("Ranking and concentration", "who or what carries most of a total",
                "1) one kpi block: the total, the number of units, the share of the top 5, the largest unit. 2) a pareto chart of the units. "
                "3) an hbar of the top 10. 4) a treemap of all units. 5) a slope chart of the top units: the period before against now. "
                "6) a table of the units that moved most."),
    "segments": ("Segments", "groups of similar items, found by cluster analysis",
                 "1) call find_groups first, with one row per item and 2 to 4 measures that describe behaviour. 2) one kpi block: items, groups, and the size of the largest group. "
                 "3) the cluster scatter (bind \"cluster\"). 4) the profile table (bind \"cluster_profile\") with the same sql and cluster field. "
                 "5) an hbar of the main measure summed per item for the largest items. 6) a boxplot of one measure across a natural grouping of the data."),
}


def names() -> list[dict]:
    return [{"key": key, "name": name, "use": use} for key, (name, use, _) in LAYOUTS.items()]


def instruction(key: str | None) -> str:
    if key in LAYOUTS:
        name, use, steps = LAYOUTS[key]
        return f"Use the dashboard layout \"{name}\" ({use}). Build these blocks in this order, and leave one out only when the data cannot fill it: {steps}\n\n"
    listing = "\n".join(f"- {name}: {use}. {steps}" for name, use, steps in LAYOUTS.values())
    return f"Choose the dashboard layout that fits the subject, and follow it:\n{listing}\n\n"
