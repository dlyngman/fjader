"""Server-side DuckDB query endpoint for DivePlot Streamlit components.

Injects a Tornado HTTP handler into Streamlit's own server at /_diveplot/query.
Same-origin, same-port -- no CSP issues in managed hosting environments.

Protocol matches Mosaic's restConnector:
  POST {type: 'arrow'|'exec'|'json', sql: string} -> Arrow IPC / JSON / empty
"""

from __future__ import annotations

import gc
import json
import logging
from typing import Any

import duckdb
import narwhals as nw
import pyarrow as pa
import pyarrow.ipc as ipc
import tornado.web

_logger = logging.getLogger("diveplot.query_server")

# ---------------------------------------------------------------------------
# Shared DuckDB connection
# ---------------------------------------------------------------------------

_conn: duckdb.DuckDBPyConnection | None = None


def _get_connection() -> duckdb.DuckDBPyConnection:
    global _conn
    if _conn is None:
        _conn = duckdb.connect(":memory:")
    return _conn


# ---------------------------------------------------------------------------
# Tornado handler
# ---------------------------------------------------------------------------


class DuckDBQueryHandler(tornado.web.RequestHandler):
    """Handle SQL query requests from the DivePlot frontend."""

    def check_xsrf_cookie(self) -> None:
        # Bypass Streamlit's XSRF protection for our API endpoint.
        # The component iframe is same-origin so this is safe.
        pass

    def set_default_headers(self) -> None:
        self.set_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.set_header("Access-Control-Allow-Headers", "Content-Type")

    def options(self) -> None:
        self.set_status(204)
        self.finish()

    def post(self) -> None:
        body: dict[str, Any] = json.loads(self.request.body)
        query_type: str = body.get("type", "arrow")
        sql: str = body.get("sql", "")

        conn = _get_connection()
        print(f"[diveplot-query] [{query_type}] {sql[:500]}")
        try:
            if query_type == "exec":
                conn.execute(sql)
                self.set_status(200)
                self.finish()
            elif query_type == "json":
                rel = conn.execute(sql)
                columns = [desc[0] for desc in rel.description]
                rows = [dict(zip(columns, row)) for row in rel.fetchall()]
                self.set_header("Content-Type", "application/json")
                self.write(json.dumps(rows))
            else:  # arrow
                table: pa.Table = conn.execute(sql).fetch_arrow_table()
                sink = pa.BufferOutputStream()
                writer = ipc.new_stream(sink, table.schema)
                writer.write_table(table)
                writer.close()
                self.set_header("Content-Type", "application/vnd.apache.arrow.stream")
                self.write(sink.getvalue().to_pybytes())
        except Exception as e:
            _logger.exception("Query failed: %s", sql[:200])
            self.set_status(400)
            self.set_header("Content-Type", "application/json")
            self.write(json.dumps({"error": str(e)}))


# ---------------------------------------------------------------------------
# Endpoint registration
# ---------------------------------------------------------------------------

_registered = False


def _find_tornado_app() -> tornado.web.Application | None:
    """Find the running Tornado Application instance via gc."""
    for obj in gc.get_objects():
        if isinstance(obj, tornado.web.Application):
            return obj
    return None


def ensure_query_endpoint() -> None:
    """Register the /_diveplot/query handler with Streamlit's Tornado server.

    Idempotent -- safe to call on every render().
    """
    global _registered
    if _registered:
        return

    app = _find_tornado_app()
    if app is None:
        _logger.warning("Could not find Tornado Application -- query endpoint not registered")
        return

    # Insert our rule at the front of the wildcard router so it's matched
    # before Streamlit's catch-all handlers.
    from tornado.routing import Rule, PathMatches

    rule = Rule(PathMatches(r"/_diveplot/query"), DuckDBQueryHandler)
    app.wildcard_router.rules.insert(0, rule)
    _registered = True
    _logger.info("DivePlot query endpoint registered at /_diveplot/query")
    logging.getLogger("diveplot.query_server").setLevel(logging.DEBUG)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

_loaded_tables: dict[str, str] = {}  # table_name -> content_hash


def load_dataframe(table_name: str, df: Any, content_hash: str = "") -> None:
    """Load a DataFrame into the server-side DuckDB instance.

    Idempotent: skips reload if the same table+hash is already loaded.
    """
    if content_hash and _loaded_tables.get(table_name) == content_hash:
        return

    conn = _get_connection()
    nf = nw.from_native(df, eager_only=True)
    arrow_table = nf.to_arrow()

    conn.execute(f'DROP TABLE IF EXISTS "{table_name}"')
    conn.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM arrow_table')

    if content_hash:
        _loaded_tables[table_name] = content_hash
