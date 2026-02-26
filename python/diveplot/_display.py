"""Display wiring: Mark/Plot/Layout → DivePlotWidget."""

from __future__ import annotations

import json
from typing import Any

from ._data import df_to_ipc_cached


def _serialize_dataframes(
    dataframes: dict[str, Any],
) -> tuple[list[dict[str, Any]], bytes]:
    """Serialize DataFrames to a manifest + concatenated Arrow IPC blob.

    Returns (manifest, blob) where manifest is a list of
    {name, hash, offset, length} dicts and blob is the concatenated IPC bytes.
    """
    manifest: list[dict[str, Any]] = []
    chunks: list[bytes] = []
    offset = 0

    for table_name, df in dataframes.items():
        h, ipc_bytes = df_to_ipc_cached(df)
        length = len(ipc_bytes)
        manifest.append({
            "name": table_name,
            "hash": h,
            "offset": offset,
            "length": length,
        })
        chunks.append(ipc_bytes)
        offset += length

    return manifest, b"".join(chunks)


def make_widget(obj: Any) -> Any:
    """Convert Mark/Plot/Overlay/Layout to a renderable DivePlotWidget."""
    from ._widget import DivePlotWidget

    spec_dict, dataframes = obj._to_full_spec()
    manifest, blob = _serialize_dataframes(dataframes)

    return DivePlotWidget(
        spec=json.dumps(spec_dict),
        data_manifest=json.dumps(manifest),
        data_blob=blob,
    )


def show(obj: Any) -> Any:
    """Display a DivePlot object in a Jupyter notebook.

    Convenience function — equivalent to calling ``make_widget(obj)``
    and displaying it. In most cases you can just let the ``_repr_mimebundle_``
    protocol handle display automatically.
    """
    return make_widget(obj)
