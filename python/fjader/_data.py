"""DataFrame → Arrow IPC snapshot, named by its content.

Uses narwhals for DataFrame-library-agnostic handling. Accepts pandas,
polars, cudf, modin, etc.
"""

from __future__ import annotations

import hashlib
import io
import weakref
from dataclasses import dataclass
from typing import Any


def df_to_arrow_ipc(df: Any) -> bytes:
    """Convert a DataFrame to Arrow IPC stream bytes.

    Library-agnostic via narwhals. Polars uses native IPC writer (no pyarrow
    needed); pandas and others go through narwhals → pyarrow IPC.
    """
    # Polars: native IPC stream writer — zero-copy, no pyarrow needed
    # Must use write_ipc_stream (not write_ipc) because DuckDB-WASM's
    # insertArrowFromIPCStream expects Arrow IPC stream format, not file format.
    if hasattr(df, "write_ipc_stream"):
        buf = io.BytesIO()
        df.write_ipc_stream(buf)
        return buf.getvalue()

    # Pandas/others: convert to Arrow via narwhals → pyarrow IPC
    import narwhals as nw

    try:
        import pyarrow as pa
        import pyarrow.ipc as ipc
    except ImportError as e:
        raise ImportError(
            "fjader needs pyarrow for pandas and other non-polars DataFrames. "
            "Install with: pip install 'fjader[pyarrow]'"
        ) from e

    nf = nw.from_native(df, eager_only=True)
    table = nf.to_arrow()
    sink = pa.BufferOutputStream()
    writer = ipc.new_stream(sink, table.schema)
    writer.write_table(table)
    writer.close()
    return sink.getvalue().to_pybytes()


def content_hash(data: bytes) -> str:
    """SHA-256 hex prefix for deduplication."""
    return hashlib.sha256(data).hexdigest()[:16]


@dataclass(frozen=True, eq=False)
class TableSnapshot:
    """A DataFrame's rows as Arrow IPC, taken once, with the hash that names them.

    The table a chart reads is named by this hash (``_df_<hash>``), so a name always
    means these bytes. Everything that ships the table (the widget's blob, a reply
    to the browser asking for it, Streamlit) ships these bytes, never the DataFrame
    again: a DataFrame changed in place after the snapshot cannot put new rows under
    the old name, or old rows under a new one.
    """

    hash: str
    ipc: bytes

    @property
    def name(self) -> str:
        return f"_df_{self.hash}"


# Live snapshots by hash: marks over the same rows share one copy of the bytes,
# released with the last mark (or widget) holding it.
_snapshots: weakref.WeakValueDictionary[str, TableSnapshot] = weakref.WeakValueDictionary()


def snapshot(df: Any) -> TableSnapshot:
    """Serialize a DataFrame now, and share the snapshot of the same content.

    Serialized on every call, never cached by the DataFrame: one can change in
    place (pandas ``df.loc[...] = ...``, polars ``df[0, "y"] = ...``) and keep its
    identity. What is shared is keyed by the content's hash, so it is always the
    same rows.
    """
    ipc = df_to_arrow_ipc(df)
    h = content_hash(ipc)
    existing = _snapshots.get(h)
    if existing is not None:
        return existing
    taken = TableSnapshot(h, ipc)
    _snapshots[h] = taken
    return taken
