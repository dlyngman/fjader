"""DataFrame → Arrow IPC serialization + content-hash deduplication.

Uses narwhals for DataFrame-library-agnostic handling. Accepts pandas,
polars, cudf, modin, etc.
"""

from __future__ import annotations

import hashlib
import io
import weakref
from typing import Any


# Module-level cache: weakref to df object → (hash, ipc_bytes).
# Uses weak references so cache entries are evicted when the DataFrame
# is garbage-collected, preventing unbounded memory growth in long sessions.
_hash_cache: dict[int, tuple[weakref.ref, str, bytes]] = {}


def _cleanup_ref(obj_id: int) -> None:
    """Remove cache entry when the DataFrame is garbage-collected."""
    _hash_cache.pop(obj_id, None)


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


def df_to_ipc_cached(df: Any) -> tuple[str, bytes]:
    """Serialize DataFrame to Arrow IPC with caching by object identity.

    The same DataFrame object serialized multiple times reuses cached bytes.
    Cache entries are automatically evicted when the DataFrame is garbage-collected.

    Returns (content_hash, ipc_bytes).
    """
    obj_id = id(df)
    cached = _hash_cache.get(obj_id)
    if cached is not None:
        ref, h, ipc_bytes = cached
        # Verify the weakref is still alive (same object, not reused id)
        if ref() is df:
            return h, ipc_bytes

    ipc_bytes = df_to_arrow_ipc(df)
    h = content_hash(ipc_bytes)
    ref = weakref.ref(df, lambda _: _cleanup_ref(obj_id))
    _hash_cache[obj_id] = (ref, h, ipc_bytes)
    return h, ipc_bytes
