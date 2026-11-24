"""anywidget-based widget for fjader, for marimo and Jupyter."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import anywidget
import traitlets

from ._data import TableSnapshot

_STATIC = Path(__file__).parent / "static"

if not (_STATIC / "widget.js").is_file():
    raise ImportError(
        "fjader's widget bundle is missing. In a source checkout, build it with "
        "`npm run build:all` from the repository root."
    )


class FjaderWidget(anywidget.AnyWidget):
    """Renders a Fjader chart in a Jupyter cell via anywidget protocol.

    Also supports composition operators so accessor results can be combined::

        df.fj.dot(x='a', y='b') * df.fj.line(x='a', y='b')
        df.fj.dot(x='a', y='b').opts(width=800)
    """

    _esm = _STATIC / "widget.js"
    _css = _STATIC / "widget.css"

    spec = traitlets.Unicode("{}").tag(sync=True)
    # Every table the chart reads, as {name, hash}; one whose bytes are in
    # data_blob also has {offset, length}. A table a browser has confirmed it
    # loaded is listed without bytes (_display._serialize_tables): the browser
    # uses its copy, or asks for the bytes ("fjader:need") if it has none.
    data_manifest = traitlets.Unicode("[]").tag(sync=True)
    data_blob = traitlets.Bytes(b"").tag(sync=True)

    def __init__(
        self,
        *args: Any,
        _source: Any = None,
        _tables: dict[str, TableSnapshot] | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._source = _source
        # The snapshots the manifest names: what a request is answered from.
        self._tables: dict[str, TableSnapshot] = _tables or {}
        self.on_msg(self._on_frontend_msg)

    def _on_frontend_msg(self, _widget: Any, content: Any, _buffers: Any) -> None:
        """Messages from the widget in the browser.

        - ``{"type": "fjader:need", "id", "tables": [{name, hash}]}``: the browser
          lacks these tables (a reloaded page, another tab). Answered with
          ``{"type": "fjader:tables", "id", "tables": [{name, hash}], "missing": [...]}``
          and one buffer per table, from this widget's own snapshots: only a table
          whose name and hash both match is sent, so the bytes always are what the
          name means.
        - ``{"type": "fjader:loaded", "hashes": [...]}``: the browser loaded these
          tables. Later widgets in this kernel leave them out of their blob.
        """
        if not isinstance(content, dict):
            return
        kind = content.get("type")
        if kind == "fjader:need":
            sent: list[dict[str, str]] = []
            buffers: list[bytes] = []
            missing: list[str] = []
            for wanted in content.get("tables", []):
                name, h = wanted.get("name"), wanted.get("hash")
                table = self._tables.get(name)
                if table is not None and table.hash == h:
                    sent.append({"name": name, "hash": h})
                    buffers.append(table.ipc)
                else:
                    missing.append(str(name))
            self.send(
                {"type": "fjader:tables", "id": content.get("id"), "tables": sent, "missing": missing},
                buffers,
            )
        elif kind == "fjader:loaded":
            from ._display import _confirmed

            own = {t.hash for t in self._tables.values()}
            _confirmed.update(h for h in content.get("hashes", []) if h in own)

    def opts(self, **kwargs: Any) -> FjaderWidget:
        """Apply chart-level options. Returns a new widget."""
        if self._source is None:
            raise TypeError("opts() requires a source mark/plot (created via accessor or fj.show)")
        from ._display import make_widget
        return make_widget(self._source.opts(**kwargs))

    def __mul__(self, other: Any) -> FjaderWidget:
        """Overlay: combine marks in one chart."""
        self_src = self._source if self._source is not None else self
        other_src = other._source if isinstance(other, FjaderWidget) and other._source is not None else other
        from ._display import make_widget
        return make_widget(self_src * other_src)

    def __add__(self, other: Any) -> FjaderWidget:
        """Layout: side-by-side charts."""
        self_src = self._source if self._source is not None else self
        other_src = other._source if isinstance(other, FjaderWidget) and other._source is not None else other
        from ._display import make_widget
        return make_widget(self_src + other_src)
