"""DataFrame → Arrow IPC serialization + content-hash deduplication.

Uses narwhals for DataFrame-library-agnostic handling. Accepts pandas,
polars, cudf, modin, etc.
"""

from __future__ import annotations

import hashlib
import io
from typing import Any

# Module-level cache: id(df) → (hash, ipc_bytes)
# Avoids re-serializing the same DataFrame object.
_hash_cache: dict[int, tuple[str, bytes]] = {}


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
    import pyarrow as pa
    import pyarrow.ipc as ipc

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


def df_to_ipc_cached(df: Any) -> tuple[str, bytes]:
    """Serialize DataFrame to Arrow IPC with caching by object identity.

    Returns (content_hash, ipc_bytes).
    """
    obj_id = id(df)
    cached = _hash_cache.get(obj_id)
    if cached is not None:
        return cached

    ipc_bytes = df_to_arrow_ipc(df)
    h = content_hash(ipc_bytes)
    _hash_cache[obj_id] = (h, ipc_bytes)
    return h, ipc_bytes
