"""Native Streamlit custom component for DivePlot.

Usage::

    import streamlit as st
    import diveplot as dp
    import polars as pl

    df = pl.DataFrame({"x": range(50), "y": [i**0.5 for i in range(50)]})
    dp.streamlit.render(dp.dot(data=df, x="x", y="y"))
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
        "DivePlot Streamlit support requires streamlit. "
        "Install with: pip install 'diveplot[streamlit]'"
    ) from e

_FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "streamlit_frontend")
_component = components.declare_component("diveplot", path=_FRONTEND_DIR)


def _to_pandas(df: Any) -> Any:
    """Convert any DataFrame to pandas for Streamlit's native Arrow serialization."""
    return nw.from_native(df, eager_only=True).to_pandas()


def render(
    obj: Displayable,
    height: int = 500,
    key: str | None = None,
) -> Any:
    """Render a DivePlot chart in a Streamlit app.

    Args:
        obj: A DivePlot mark, plot, or layout object.
        height: Component height in pixels.
        key: Streamlit component key for state management.

    Returns:
        The component value (None unless selections are implemented).
    """
    spec_dict, dataframes = obj._to_full_spec()

    # Inject heights into the spec and compute the actual iframe height.
    iframe_height = _inject_height(spec_dict, height)

    manifest: list[dict[str, str]] = []
    table_args: dict[str, Any] = {}

    for i, (table_name, df) in enumerate(dataframes.items()):
        h, _ = df_to_ipc_cached(df)
        arg_key = f"_df_{i}"
        table_args[arg_key] = _to_pandas(df)
        manifest.append({"name": table_name, "hash": h, "arg": arg_key})

    return _component(
        spec=json.dumps(spec_dict),
        data_manifest=json.dumps(manifest),
        height=iframe_height,
        key=key,
        default=None,
        **table_args,
    )


_VCONCAT_GAP = 8  # matches CSS gap in LayoutFromSpec.svelte


def _inject_height(spec: dict[str, Any], height: int) -> int:
    """Set height on plot specs and return the iframe height to use.

    For a single plot, uses ``height`` as the default.
    For vconcat: if all items have explicit heights the iframe expands to fit;
    otherwise the remaining space from ``height`` is split among unset items.
    For hconcat: each item gets the full ``height`` (CSS flex splits width).
    """
    if "plot" in spec:
        spec["plot"].setdefault("height", height)
        return height

    items = spec.get("vconcat", [])
    if items:
        unset = [item for item in items if "height" not in item]
        explicit_total = sum(item.get("height", 0) for item in items)
        total_gap = _VCONCAT_GAP * (len(items) - 1)

        if not unset:
            # All heights explicit — expand iframe to fit.
            return explicit_total + total_gap
        # Divide remaining space among items without a height.
        remaining = height - explicit_total - total_gap
        per_item = max(remaining // len(unset), 50)
        for item in unset:
            item["height"] = per_item
        return height

    for item in spec.get("hconcat", []):
        item.setdefault("height", height)
    return height
