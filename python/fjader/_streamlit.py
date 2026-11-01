"""Native Streamlit custom component for Fjader.

Usage::

    import streamlit as st
    import fjader as fj
    import polars as pl

    df = pl.DataFrame({"x": range(50), "y": [i**0.5 for i in range(50)]})
    fj.streamlit.render(fj.dot(data=df, x="x", y="y"))
"""

from __future__ import annotations

import json
import os
from typing import Any

import narwhals as nw

from ._data import df_to_ipc_cached
from ._display import Displayable

try:
    import streamlit.components.v1 as components
except ImportError as e:
    raise ImportError(
        "Fjader Streamlit support requires streamlit. "
        "Install with: pip install 'fjader[streamlit]'"
    ) from e

_FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "streamlit_frontend")
if not os.path.isfile(os.path.join(_FRONTEND_DIR, "index.html")):
    raise ImportError(
        "fjader's Streamlit bundle is missing. In a source checkout, build it with "
        "`npm run build:all` from the repository root."
    )
_component = components.declare_component("fjader", path=_FRONTEND_DIR)


def _to_pandas(df: Any) -> Any:
    """Convert any DataFrame to pandas for Streamlit's native Arrow serialization."""
    return nw.from_native(df, eager_only=True).to_pandas()


def render(
    obj: Displayable,
    height: int = 500,
    key: str | None = None,
    server_duckdb: bool = False,
) -> Any:
    """Render a Fjader chart in a Streamlit app.

    Args:
        obj: A Fjader mark, plot, or layout object.
        height: Component height in pixels.
        key: Streamlit component key for state management.
        server_duckdb: If True, use Python-side DuckDB instead of browser WASM.
            Useful for environments where WebAssembly is blocked by CSP.

    Returns:
        The component value (None unless selections are implemented).
    """
    spec_dict, dataframes = obj._to_full_spec()

    # Inject heights into the spec and compute the actual iframe height.
    iframe_height = _inject_height(spec_dict, height)

    # Set up server-side DuckDB when requested (for environments where WASM
    # is blocked by CSP). Fast and idempotent — tables are skipped if already loaded.
    if server_duckdb:
        _setup_server_fallback(dataframes)

    manifest: list[dict[str, str]] = []
    table_args: dict[str, Any] = {}

    if not server_duckdb:
        # Only send data to the frontend when using WASM DuckDB.
        # With server-side DuckDB the data is already loaded — no need to
        # serialize and transfer it over the Streamlit component bridge.
        for i, (table_name, df) in enumerate(dataframes.items()):
            h, _ = df_to_ipc_cached(df)
            arg_key = f"_df_{i}"
            table_args[arg_key] = _to_pandas(df)
            manifest.append({"name": table_name, "hash": h, "arg": arg_key})

    return _component(
        spec=json.dumps(spec_dict),
        data_manifest=json.dumps(manifest),
        server_duckdb=server_duckdb,
        height=iframe_height,
        key=key,
        default=None,
        **table_args,
    )


def _setup_server_fallback(dataframes: dict[str, Any]) -> None:
    """Register the DuckDB query endpoint and load DataFrames server-side.

    This runs on every render() call but is idempotent — the endpoint is
    registered once, and tables are only reloaded when their content changes.
    """
    try:
        from ._query_server import ensure_query_endpoint, load_dataframe

        ensure_query_endpoint()
        for table_name, df in dataframes.items():
            h, _ = df_to_ipc_cached(df)
            load_dataframe(table_name, df, content_hash=h)
    except Exception:
        # Non-fatal: if the server fallback can't be set up, the frontend
        # will still try WASM. Only log at debug level.
        import logging

        logging.getLogger("fjader").debug(
            "Server-side DuckDB fallback setup failed", exc_info=True
        )


_VCONCAT_GAP = 8  # matches CSS gap in LayoutFromSpec.svelte


def _is_layout(item: dict[str, Any]) -> bool:
    """True if the item is a nested layout (has hconcat or vconcat key)."""
    return "hconcat" in item or "vconcat" in item


def _inject_height(spec: dict[str, Any], height: int) -> int:
    """Set height on plot specs and return the iframe height to use.

    For a single plot, uses ``height`` as the default.
    For vconcat: if all items have explicit heights the iframe expands to fit;
    otherwise the remaining space from ``height`` is split among unset items.
    For hconcat: each item gets the full ``height`` (CSS flex splits width).
    Nested layouts are handled recursively.
    """
    if "plot" in spec:
        spec["plot"].setdefault("height", height)
        return height

    items = spec.get("vconcat", [])
    if items:
        unset = [item for item in items if not _is_layout(item) and "height" not in item]
        explicit_total = 0
        for item in items:
            if _is_layout(item):
                # Recurse: nested layout gets remaining height budget, returns its own.
                explicit_total += _inject_height(item, height)
            elif "height" in item:
                explicit_total += item["height"]
        total_gap = _VCONCAT_GAP * (len(items) - 1)

        if not unset:
            return explicit_total + total_gap
        remaining = height - explicit_total - total_gap
        per_item = max(remaining // len(unset), 50)
        for item in unset:
            item["height"] = per_item
        return height

    items = spec.get("hconcat", [])
    if items:
        max_h = 0
        for item in items:
            if _is_layout(item):
                max_h = max(max_h, _inject_height(item, height))
            else:
                item.setdefault("height", height)
                max_h = max(max_h, item.get("height", height))
        return max_h

    return height
