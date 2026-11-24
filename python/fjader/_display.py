"""Display wiring: Mark/Plot/Layout → FjaderWidget."""

from __future__ import annotations

import json
from typing import Any, Protocol, runtime_checkable

from ._data import TableSnapshot


@runtime_checkable
class Displayable(Protocol):
    """Protocol for objects that can be rendered as Fjader widgets."""

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """(spec dict, {table name: TableSnapshot})."""
        ...


# Hashes of the tables a browser has confirmed it loaded, in this kernel (see
# FjaderWidget). A table is left out of a widget's blob only once confirmed: a
# widget made but never shown, a headless export (no browser) or a new kernel
# send everything, and a page that lost its tables asks for them back.
_confirmed: set[str] = set()


def _serialize_tables(
    tables: dict[str, TableSnapshot],
) -> tuple[list[dict[str, Any]], bytes]:
    """The manifest for a widget's tables and the blob carrying their bytes.

    Every table is in the manifest as {name, hash}; one a browser has not
    confirmed also has {offset, length} into the blob, which holds its bytes.
    """
    manifest: list[dict[str, Any]] = []
    chunks: list[bytes] = []
    offset = 0

    for table_name, table in tables.items():
        entry: dict[str, Any] = {"name": table_name, "hash": table.hash}
        if table.hash not in _confirmed:
            entry["offset"] = offset
            entry["length"] = len(table.ipc)
            chunks.append(table.ipc)
            offset += len(table.ipc)
        manifest.append(entry)

    return manifest, b"".join(chunks)


_DEFAULT_WIDGET_HEIGHT = 400
_LAYOUT_GAP = 8  # matches .fjader-vconcat/.fjader-hconcat { gap: 8px }


def _inject_default_height(spec: dict[str, Any], height: int) -> None:
    """Set height on all plot specs and compute total container height.

    Without an explicit pixel height, PlotFromSpec falls back to
    ``aspect-ratio: 4/3`` which doesn't size correctly inside
    anywidget containers in marimo / Jupyter.

    Also computes ``_containerHeight`` — the exact pixel height the
    anywidget ``el`` needs so that vconcat layouts aren't clipped.
    """
    if "plot" in spec:
        spec["plot"].setdefault("height", height)
        spec["_containerHeight"] = spec["plot"]["height"]
    elif "vconcat" in spec:
        for item in spec["vconcat"]:
            item.setdefault("height", height)
        heights = [item["height"] for item in spec["vconcat"]]
        spec["_containerHeight"] = sum(heights) + (len(heights) - 1) * _LAYOUT_GAP
    elif "hconcat" in spec:
        for item in spec["hconcat"]:
            item.setdefault("height", height)
        heights = [item["height"] for item in spec["hconcat"]]
        spec["_containerHeight"] = max(heights) if heights else height


def make_widget(obj: Displayable) -> Any:
    """Convert Mark/Plot/Overlay/Layout to a renderable FjaderWidget."""
    from ._widget import FjaderWidget

    spec_dict, tables = obj._to_full_spec()
    _inject_default_height(spec_dict, _DEFAULT_WIDGET_HEIGHT)
    manifest, blob = _serialize_tables(tables)

    return FjaderWidget(
        spec=json.dumps(spec_dict),
        data_manifest=json.dumps(manifest),
        data_blob=blob,
        _source=obj,
        _tables=tables,
    )


def show(obj: Displayable) -> Any:
    """Display a Fjader object in a Jupyter notebook.

    Convenience function — equivalent to calling ``make_widget(obj)``
    and displaying it. In most cases you can just let the ``_repr_mimebundle_``
    protocol handle display automatically.
    """
    return make_widget(obj)
