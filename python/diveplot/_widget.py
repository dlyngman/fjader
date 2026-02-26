"""anywidget-based Jupyter widget for DivePlot."""

from __future__ import annotations

from pathlib import Path

try:
    import anywidget
    import traitlets
except ImportError as e:
    raise ImportError(
        "DivePlot Jupyter support requires anywidget. "
        "Install with: pip install 'diveplot[jupyter]'"
    ) from e


class DivePlotWidget(anywidget.AnyWidget):
    """Renders a DivePlot chart in a Jupyter cell via anywidget protocol."""

    _esm = Path(__file__).parent / "static" / "widget.js"
    _css = Path(__file__).parent / "static" / "widget.css"

    spec = traitlets.Unicode("{}").tag(sync=True)
    data_manifest = traitlets.Unicode("[]").tag(sync=True)
    data_blob = traitlets.Bytes(b"").tag(sync=True)
