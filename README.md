# Canvas core

Ask a question about a MySQL database in plain words and get a page of charts. One user, on one machine: no login,
and the app listens on `127.0.0.1` only.

Three kinds of request:

| Kind | Use | Result |
|---|---|---|
| Answer | One question: "What were Travel and Events expenses this year?" | The answer first, then up to 2 charts |
| Report | Several questions at once: "The CEO wants to know A, B and C" | A summary, one section per question, a next step |
| Dashboard | A standing view of one subject | A grid of numbers and charts that you refresh without the AI |

## Working with a page

- **Other chart:** on any chart, see the same query in another form (bar, donut, treemap, ...). Only forms that fit
  the data are offered. No model is called.
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
- **The glossary** (`glossary.md`) says what the business terms mean ("Travel and Events" = which categories). The
  quality of the answers depends on it more than on anything else.

## Install

Needs Python 3.11 or newer and Node.js 18 or newer (Node draws the charts).

```
python -m venv .venv
.venv/bin/pip install -r requirements.txt        (Windows: .venv\Scripts\pip)
copy canvas.example.toml to canvas.toml and fill it in
set the two environment variables that canvas.toml names (database password, model key)
.venv/bin/python -m canvas_core.app
open http://127.0.0.1:8570
```

`canvas.toml`, `.env` and `canvas.db` are never committed.

## The model

`[model] kind = "openai"` speaks the chat-completions format with tools (OpenAI, Azure OpenAI and most company
gateways). `kind = "anthropic"` speaks the messages format. Set `base_url`, `model` and `api_key_env`; `path`,
`key_header` and `key_prefix` cover gateways that differ. The question, the schema, the glossary and the query
results are sent to that endpoint, and nowhere else.

## Sample data

`sample/load_sample.py` builds a made-up `finance` database (two years of company expenses) with a read-only user,
and `sample/glossary.md` is its glossary. Use it to try the app before you point it at real data.

## Layout

| Path | What |
|---|---|
| `canvas_core/app.py` | The web app and its API |
| `canvas_core/agent.py` | One run: model step, tool calls, until `finish` |
| `canvas_core/tools.py` | The four tools and the rules (numbers from queries, chart variety, limits) |
| `canvas_core/db.py` | The read-only MySQL tool and the schema catalog |
| `canvas_core/bind.py` | Query rows to block data |
| `canvas_core/models.py` | The two model wire formats |
| `canvas_core/store.py` | Reports and blocks in one SQLite file |
| `canvas_core/prompt.md` | The brief of the agent |
| `render/` | The chart renderer (shared with Aurora Canvas) |
| `web/index.html` | The screen |

Tests: `.venv/bin/python -m pytest -q tests`.
