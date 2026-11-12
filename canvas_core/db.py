"""The MySQL side: one read-only query tool for the agent, and the schema catalog for its brief.

Three guards keep the tool read-only, each enough by itself: the text of the query is checked (one statement, a
reading verb), the session is set READ ONLY, and the database user should have SELECT only (README). A query has a
time limit and a row limit, so a careless question cannot hold the server or flood the model.
"""
from __future__ import annotations

import datetime as dt
import decimal
import re

MAX_ROWS = 500
MAX_SECONDS = 20
READ_VERBS = ("select", "with", "show", "describe", "desc", "explain")
FORBIDDEN = re.compile(r"\b(insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|rename|call|load|handler|lock|unlock|set|use|"
                       r"into\s+outfile|into\s+dumpfile)\b", re.I)


class QueryRefused(Exception):
    """The query is not allowed; the text says why, for the agent."""


def strip_sql(query: str) -> str:
    """The query without comments and string contents, lower case: what the guard reads."""
    text = re.sub(r"/\*.*?\*/", " ", query, flags=re.S)
    text = re.sub(r"(--|#)[^\n]*", " ", text)
    text = re.sub(r"'(?:[^'\\]|\\.|'')*'", "''", text)
    text = re.sub(r'"(?:[^"\\]|\\.|"")*"', '""', text)
    text = re.sub(r"`[^`]*`", "``", text)          # a column named `update` is a name, not a command
    return text.strip().lower()


def check_read_only(query: str) -> str:
    """The query, trimmed, or QueryRefused."""
    if not isinstance(query, str) or not query.strip():
        raise QueryRefused("the query is empty")
    bare = strip_sql(query).rstrip(";").strip()
    if ";" in bare:
        raise QueryRefused("send one statement per call")
    if not bare.startswith(READ_VERBS):
        raise QueryRefused("only reading statements are allowed: SELECT, WITH, SHOW, DESCRIBE, EXPLAIN")
    found = FORBIDDEN.search(bare)
    if found:
        raise QueryRefused(f"the statement contains \"{found.group(1)}\", which can change data or settings; this tool only reads")
    return query.strip().rstrip(";")


def plain(value):
    """A database value as JSON can carry it."""
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return value.total_seconds()
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return value


class MySQL:
    def __init__(self, settings):
        self.params = dict(
            host=settings.database.get("host", "127.0.0.1"), port=int(settings.database.get("port", 3306)),
            user=settings.database.get("user"), password=settings.secret(settings.database, "password_env"),
            database=settings.database.get("name"), charset="utf8mb4", connect_timeout=10,
            read_timeout=MAX_SECONDS + 5, autocommit=True)
        self.schema = settings.database.get("name")

    def _connect(self):
        import pymysql
        conn = pymysql.connect(**self.params)
        with conn.cursor() as cur:
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            cur.execute(f"SET SESSION max_execution_time = {MAX_SECONDS * 1000}")
        return conn

    def run(self, query: str, max_rows: int = MAX_ROWS) -> dict:
        """{"columns": [...], "rows": [[...]], "truncated": bool}. Raises QueryRefused for a query the guard or MySQL refuses."""
        import pymysql
        query = check_read_only(query)
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                try:
                    cur.execute(query)
                except pymysql.MySQLError as exc:
                    raise QueryRefused(f"MySQL refused the query: {exc.args[-1] if exc.args else exc}") from exc
                columns = [d[0] for d in cur.description or []]
                rows = cur.fetchmany(max_rows + 1)
        finally:
            conn.close()
        return {"columns": columns, "rows": [[plain(v) for v in row] for row in rows[:max_rows]], "truncated": len(rows) > max_rows}

    def catalog(self) -> str:
        """The schema in words for the agent's brief: each table with its row estimate, comment and columns."""
        tables = self.run(
            "SELECT table_name, table_rows, table_comment FROM information_schema.tables "
            f"WHERE table_schema = '{self.schema}' AND table_type = 'BASE TABLE' ORDER BY table_name", 400)["rows"]
        columns = self.run(
            "SELECT table_name, column_name, column_type, column_key, column_comment FROM information_schema.columns "
            f"WHERE table_schema = '{self.schema}' ORDER BY table_name, ordinal_position", 5000)["rows"]
        links = self.run(
            "SELECT table_name, column_name, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage "
            f"WHERE table_schema = '{self.schema}' AND referenced_table_name IS NOT NULL", 2000)["rows"]
        target = {(t, c): f"{rt}.{rc}" for t, c, rt, rc in links}
        lines = []
        for name, rows, comment in tables:
            lines.append(f"- `{name}` (about {int(rows or 0):,} rows){': ' + comment if comment else ''}")
            for table, column, kind, key, note in columns:
                if table != name:
                    continue
                marks = [kind] + (["primary key"] if key == "PRI" else []) + ([f"-> {target[(table, column)]}"] if (table, column) in target else [])
                lines.append(f"  - `{column}` {', '.join(marks)}{': ' + note if note else ''}")
        return "\n".join(lines)
