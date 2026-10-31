"""anywidget-based Jupyter widget for Fjader."""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:
    import anywidget
    import traitlets
except ImportError as e:
    raise ImportError(
        "Fjader Jupyter support requires anywidget. "
        "Install with: pip install 'fjader[jupyter]'"
    ) from e


class FjaderWidget(anywidget.AnyWidget):
    """Renders a Fjader chart in a Jupyter cell via anywidget protocol.

    Also supports composition operators so accessor results can be combined::

        df.fj.dot(x='a', y='b') * df.fj.line(x='a', y='b')
        df.fj.dot(x='a', y='b').opts(width=800)
    """

    _esm = Path(__file__).parent / "static" / "widget.js"
    _css = Path(__file__).parent / "static" / "widget.css"

    spec = traitlets.Unicode("{}").tag(sync=True)
    data_manifest = traitlets.Unicode("[]").tag(sync=True)
    data_blob = traitlets.Bytes(b"").tag(sync=True)

    def __init__(self, *args: Any, _source: Any = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._source = _source

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
