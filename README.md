# Canvas core

Ask a question about a MySQL database in plain words and get a page of charts. It runs on your own machine for one
user: no login, and the app listens on `127.0.0.1` only.

Three kinds of request:

| Kind | Use | Result |
|---|---|---|
| Answer | One question: "What were travel expenses this year?" | The answer first, then up to 2 charts |
| Report | Several questions at once: "The CEO wants to know A, B and C" | A summary, one section per question, a next step |
| Dashboard | A standing view of one subject | A grid of numbers and charts that you refresh without the AI |

## Cluster analysis and dashboard layouts

- **Segments:** ask "which kinds of vendors do we have?" or "find the groups of similar employees". The app groups
  the items by 2 to 6 measures with k-means, picks the number of groups from the data, and draws a scatter coloured
  by group, a table that describes each group, and the size of each group. The grouping is done by code, so the same
  data always gives the same groups. It scores how well the groups separate and says so when they are weak.
- **Dashboard layouts:** when you ask for a dashboard you can pick a layout: Executive overview, Trend and breakdown,
  Plan against actual, Ranking and concentration, or Segments. "Auto" lets the app choose by the subject.

## Charts

30 chart forms, chosen by the shape of the data: line, area, stacked area, bars (vertical, horizontal, grouped, stacked),
bars with a line on a second scale, small multiples, rank over time (bump), pareto, waterfall, diverging, dumbbell,
slope, donut, treemap, packed bubbles, heatmap, calendar, histogram, box plot, strip plot (every item as a dot),
bullet, gauge, funnel, sankey, scatter, Gantt and word cloud. A street map and a day timeline are separate blocks.

## Working with a page

- **Other chart:** on any chart, see the same query in another form (bar, donut, treemap, line, area, ...). Only
  forms that fit the data are offered. No model is called.
- **Click a bar, a slice or a point:** go deeper into that value, or add a chart about it.
- **Add to this page:** ask for one more chart on a dashboard or a report that exists.
- **Remove**, **Pin**, **Refresh data**.

## How it keeps numbers right

- **The model never types a number into a chart.** Each data block carries its query (`sql`) and where the rows go
  (`bind`). The app runs the query and fills the block. A block with typed numbers is refused.
- **Read only, three times over:** the query text is checked (one statement, a reading verb), the session is set
  READ ONLY, and the database user should have SELECT only.
- **Limits:** 20 seconds and 500 rows per query.
- **Refresh** runs each block's own query again. No model is called, so it costs nothing and gives the same shape
  every time. A block whose query fails keeps its last drawing and the page says so.
- **The sentence above a chart is written by the model** from the rows it saw. It can be wrong or go stale after a
  refresh. The numbers in the chart are always the query's.

## Install

You need Python 3.11 or newer and Node.js 18 or newer (Node draws the charts).

1. Get the code and install the packages.
   ```
   python -m venv .venv
   .venv/bin/pip install -r requirements.txt          (Windows: .venv\Scripts\pip install -r requirements.txt)
   ```
2. Copy `canvas.example.toml` to `canvas.toml`. Fill in the database, and keep one `[model]` block (next section).
3. Create a database user that can only read, and use it in `canvas.toml`.
   ```sql
   CREATE USER 'canvas_ro'@'%' IDENTIFIED BY '<a password>';
   GRANT SELECT ON your_database.* TO 'canvas_ro'@'%';
   ```
4. Set the two environment variables that `canvas.toml` names: the database password and the model key. The secrets
   themselves never go into a file of this repo.
   ```
   export CANVAS_DB_PASSWORD=...        (Windows PowerShell: $env:CANVAS_DB_PASSWORD = "...")
   export CANVAS_MODEL_KEY=...
   ```
5. Copy `glossary.example.md` to `glossary.md` and write what your business terms mean (see "The glossary").
6. Check the installation. Each line says PASS or FAIL, and a FAIL says what to change.
   ```
   .venv/bin/python -m canvas_core.check
   ```
7. Start the app and open `http://127.0.0.1:8570`.
   ```
   .venv/bin/python -m canvas_core.app
   ```

`canvas.toml`, `glossary.md`, `.env` and `canvas.db` are ignored by git, so your settings, your terms and your reports
stay on your machine.

## The model

The question, the schema, the glossary and the query results are sent to the model endpoint you set, and nowhere
else. Pick the block that matches where your model runs.

### Claude on Microsoft Foundry (Azure)

Your organisation has a Foundry resource in Azure with a Claude model deployed in it.

```toml
[model]
kind = "claude"
platform = "foundry"
resource = "your-azure-resource-name"
model = "claude-opus-5-5"
api_key_env = "CANVAS_MODEL_KEY"
```

- `resource` is the **name** of the Foundry resource, not a URL. In the Azure portal it is the name of the resource
  that holds your deployment. If your organisation gave you a full endpoint address, set `base_url` to it and leave
  `resource` out.
- `model` is the **name of your deployment**. It is often the model name, but your administrator can have named it
  differently.
- The key is the API key of that resource. Sign-in with Microsoft Entra ID in place of a key is not built in.
- Some Claude features are not offered on every Foundry deployment. This app uses only messages with tools, which is
  offered.

### Claude API (Anthropic)

```toml
[model]
kind = "claude"
platform = "anthropic"
model = "claude-opus-5-5"
api_key_env = "CANVAS_MODEL_KEY"
```

### Azure OpenAI, OpenAI, a company gateway, a local model server

Any endpoint that speaks chat completions with tools.

```toml
[model]
kind = "openai"
base_url = "https://your-resource.openai.azure.com/openai/v1"
model = "your-deployment-name"
api_key_env = "CANVAS_MODEL_KEY"
key_header = "api-key"      # Azure OpenAI; leave out for OpenAI and most gateways
key_prefix = ""
```

A local server with no key: leave `api_key_env` out.

### Which model

A stronger model writes better queries and more accurate sentences. Small local models work for a first try, but
they make more mistakes in the sentence above a chart. Optional settings for `kind = "claude"`: `effort` (`low`,
`medium`, `high`) and `max_tokens`.

## The glossary

The glossary says what the words of your business mean in your database: which accounts are "Travel and Events",
which rows count as "revenue", when the fiscal year starts. The model reads it with every question. Without it the
model guesses, and a wrong guess gives a confident wrong number. `glossary.example.md` shows what to write. Ten good
entries change the answers more than any other setting.

## Sample data

`sample/load_sample.py` builds a made-up `finance` database (two years of company expenses) with a read-only user,
and `sample/glossary.md` is its glossary. Use it to try the app before you point it at real data.

## Limits

- MySQL only (8.0 or newer is tested).
- One user on one machine. Do not expose the port to a network: the app has no login.
- A page shows what the queries returned. It does not check that the data in your database is right.

## Layout

| Path | What |
|---|---|
| `canvas_core/app.py` | The web app and its API |
| `canvas_core/agent.py` | One run: model step, tool calls, until `finish` |
| `canvas_core/tools.py` | The four tools and the rules (numbers from queries, chart variety, limits, chart forms) |
| `canvas_core/db.py` | The read-only MySQL tool and the schema catalog |
| `canvas_core/bind.py` | Query rows to block data |
| `canvas_core/cluster.py` | Cluster analysis in plain code |
| `canvas_core/layouts.py` | The dashboard layouts |
| `canvas_core/models.py` | The model adapters: Claude (official SDK) and chat completions |
| `canvas_core/check.py` | The installation check |
| `canvas_core/store.py` | Reports and blocks in one SQLite file |
| `canvas_core/prompt.md` | The brief of the agent |
| `render/` | The chart renderer |
| `web/index.html` | The screen |

Tests: `.venv/bin/python -m pytest -q tests`.
