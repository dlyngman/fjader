"""Render a Fjader chart from a raw JSON spec (e.g. exported from the palette)."""

from __future__ import annotations

import json
from typing import Any


class SpecPlot:
    """Wraps a raw FjaderSpec dict for rendering in Jupyter or Streamlit.

    Created by :func:`from_spec`. Implements the ``Displayable`` protocol
    so it can be passed to ``fj.show()``, ``fj.streamlit.render()``, or
    displayed directly in Jupyter/Marimo.
    """

    def __init__(
        self,
        spec: dict[str, Any],
        data: dict[str, Any] | None = None,
    ) -> None:
        self._spec = spec
        self._dataframes = data or {}

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        return self._spec, self._dataframes

    def to_dict(self) -> dict[str, Any]:
        return self._spec

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self._spec, **kwargs)

    def _repr_mimebundle_(self, **kwargs: Any) -> Any:
        from ._display import make_widget

        return make_widget(self)._repr_mimebundle_(**kwargs)


def _normalize_spec(spec: dict[str, Any]) -> dict[str, Any]:
    """Wrap a bare PlotSpec in a FjaderSpec if needed.

    The palette exports bare PlotSpec (``{"marks": [...]}``) without
    the outer ``{"plot": ...}`` wrapper. The renderer expects the full form.
    """
    if "plot" in spec or "hconcat" in spec or "vconcat" in spec:
        return spec
    # Bare PlotSpec — wrap it
    return {"plot": spec}


def from_spec(
    spec: dict[str, Any] | str,
    data: dict[str, Any] | None = None,
) -> SpecPlot:
    """Create a renderable chart from a raw JSON spec.

    Use this to render specs exported from the Fjader command palette
    (Cmd+E), or any hand-written spec dict.

    Args:
        spec: A FjaderSpec dict or JSON string. Accepts both the full form
            (``{"plot": {"marks": [...]}}``) and the bare PlotSpec form
            (``{"marks": [...]}``) exported by the palette.
        data: Optional dict mapping table names to DataFrames. Required when
            the spec references tables backed by in-memory data rather than
            file URLs. Example: ``{"flights": df}``.

    Returns:
        A ``SpecPlot`` object that can be displayed in Jupyter, passed to
        ``fj.show()``, or rendered with ``fj.streamlit.render()``.

    Examples::

        # Paste a spec exported from the palette
        chart = fj.from_spec({
            "marks": [{
                "mark": "dot",
                "table": "penguins",
                "x": "bill_length",
                "y": "bill_depth",
                "fill": "species"
            }]
        }, data={"penguins": df})

        # Full FjaderSpec with file-based data sources
        chart = fj.from_spec({
            "data": {"flights": {"url": "flights.parquet", "type": "parquet"}},
            "plot": {
                "marks": [{"mark": "barY", "table": "flights", "x": "carrier", "y": "count()"}]
            }
        })
    """
    if isinstance(spec, str):
        spec = json.loads(spec)

    spec = _normalize_spec(spec)

    # Wire up DataFrames: assign hash-based table names matching what the
    # marks reference, so the serialization pipeline can ship them as Arrow IPC.
    dataframes: dict[str, Any] = {}
    if data:
        from ._data import df_to_ipc_cached

        for table_name, df in data.items():
            h, _ = df_to_ipc_cached(df)
            hashed_name = f"_df_{h}"
            # Rewrite table references in the spec so marks point to the
            # hashed name that the widget data-loading pipeline expects.
            _rewrite_table_refs(spec, table_name, hashed_name)
            dataframes[hashed_name] = df

    return SpecPlot(spec, dataframes)


def _rewrite_table_refs(spec: dict[str, Any], old: str, new: str) -> None:
    """Replace ``table: old`` with ``table: new`` in all marks."""
    for plot_spec in _iter_plot_specs(spec):
        for mark in plot_spec.get("marks", []):
            if mark.get("table") == old:
                mark["table"] = new


def _iter_plot_specs(spec: dict[str, Any]):
    """Yield all PlotSpec dicts from a FjaderSpec."""
    if "plot" in spec:
        yield spec["plot"]
    for item in spec.get("hconcat", []):
        yield item
    for item in spec.get("vconcat", []):
        yield item
