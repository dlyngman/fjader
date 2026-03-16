"""Plot class — a single chart with marks and chart-level configuration."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ._convert import serialize_value, to_camel_case
from .interactors import InteractorSpec
from .marks._base import Mark

if TYPE_CHECKING:
    from ._types import SortConfig

_PLOT_FIELDS = (
    "width", "height", "margin", "x_label", "y_label", "fx", "columns", "legend",
    "interactors", "use_selection", "zoom_limit", "pan_limit",
)


@dataclass
class Plot:
    """A single chart containing one or more marks with chart-level config."""

    _marks: list[Mark] = field(default_factory=list)
    width: int | None = None
    height: int | None = None
    margin: dict[str, int] | None = None
    x_label: str | None = None
    y_label: str | None = None
    fx: str | None = None
    columns: int | None = None
    legend: dict[str, Any] | bool | None = None
    interactors: list[InteractorSpec] | None = None
    use_selection: str | None = None  # 'x' | 'y' | 'xy'
    zoom_limit: int | float | tuple[int | float, int | float] | None = None
    pan_limit: int | float | tuple[int | float, int | float] | None = None

    def __init__(self, *marks: Mark, **kwargs: Any) -> None:
        unexpected = set(kwargs) - set(_PLOT_FIELDS)
        if unexpected:
            raise TypeError(
                f"plot() got unexpected keyword argument(s): {', '.join(sorted(unexpected))}"
            )
        # Flatten Overlays so _marks is always a flat list of Mark instances
        from .layout import Overlay

        flat: list[Mark] = []
        for m in marks:
            if isinstance(m, Overlay):
                flat.extend(m.marks)
            else:
                flat.append(m)
        self._marks = flat
        for key in _PLOT_FIELDS:
            setattr(self, key, kwargs.get(key))

    def opts(self, **kwargs: Any) -> Plot:
        """Return a new Plot with updated chart-level config."""
        unexpected = set(kwargs) - set(_PLOT_FIELDS)
        if unexpected:
            raise TypeError(
                f"opts() got unexpected keyword argument(s): {', '.join(sorted(unexpected))}"
            )
        new = Plot(*self._marks)
        for key in _PLOT_FIELDS:
            setattr(new, key, getattr(self, key))
        for key, val in kwargs.items():
            if key in _PLOT_FIELDS:
                setattr(new, key, val)
        return new

    @staticmethod
    def _expand_axis_pair(
        value: int | float | tuple[int | float, int | float],
        x_key: str,
        y_key: str,
        spec: dict[str, Any],
    ) -> None:
        if isinstance(value, (int, float)):
            spec[x_key] = value
            spec[y_key] = value
        else:
            spec[x_key] = value[0]
            spec[y_key] = value[1]

    def _to_plot_spec(self) -> dict[str, Any]:
        """Produce the PlotSpec portion (without outer data wrapper)."""
        spec: dict[str, Any] = {"marks": [m.to_mark_dict() for m in self._marks]}
        for key in _PLOT_FIELDS:
            val = getattr(self, key)
            if val is None:
                continue
            if key == "use_selection":
                spec["useXSelection"] = "x" in val
                spec["useYSelection"] = "y" in val
            elif key == "zoom_limit":
                self._expand_axis_pair(val, "xZoomLimit", "yZoomLimit", spec)
            elif key == "pan_limit":
                self._expand_axis_pair(val, "xPanLimit", "yPanLimit", spec)
            else:
                spec[to_camel_case(key)] = serialize_value(val)
        return spec

    def to_dict(self) -> dict[str, Any]:
        """Full DivePlotSpec."""
        result: dict[str, Any] = {}
        result["plot"] = self._to_plot_spec()
        return result

    def _collect_data(self) -> dict[str, Any]:
        """Return {table_name: df} for all marks with data attached."""
        result: dict[str, Any] = {}
        for m in self._marks:
            result.update(m._collect_data())
        return result

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """Return (spec_dict, dataframes_dict) for widget rendering."""
        return self.to_dict(), self._collect_data()

    def _repr_mimebundle_(self, **kwargs: Any) -> Any:
        from ._display import make_widget

        return make_widget(self)._repr_mimebundle_(**kwargs)

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    def __mul__(self, other: Any) -> Plot:
        """Add marks from other into this plot."""
        from .marks._base import _get_marks

        new = Plot(*self._marks, *_get_marks(other))
        for key in _PLOT_FIELDS:
            setattr(new, key, getattr(self, key))
        return new

    def __add__(self, other: Any) -> Any:
        from .layout import HConcat
        from .marks._base import _to_plots

        return HConcat(items=[self] + _to_plots(other))

    def __radd__(self, other: Any) -> Any:
        if isinstance(other, (Mark, Plot)):
            return other.__add__(self)
        return NotImplemented


def plot(
    *marks: Mark,
    width: int | None = None,
    height: int | None = None,
    margin: dict[str, int] | None = None,
    x_label: str | None = None,
    y_label: str | None = None,
    fx: str | None = None,
    columns: int | None = None,
    legend: dict[str, Any] | bool | None = None,
    interactors: list[InteractorSpec] | None = None,
    use_selection: str | None = None,
    zoom_limit: int | float | tuple[int | float, int | float] | None = None,
    pan_limit: int | float | tuple[int | float, int | float] | None = None,
) -> Plot:
    """Create a chart with one or more marks and chart-level configuration.

    Args:
        *marks: Mark instances to include in the chart.
        width: Chart width in CSS pixels.
        height: Chart height in CSS pixels.
        margin: Dict with ``top``/``right``/``bottom``/``left`` pixel values.
        x_label: X-axis label.
        y_label: Y-axis label.
        fx: Facet column name.
        columns: Number of columns for facet grid.
        legend: Legend config — ``True`` for auto-detect, or a dict like
            ``{"color": "species", "position": "right"}``.
        interactors: List of interactor specs (e.g. ``[dp.interval_x()]``).
        use_selection: Follow the shared scale's selection extent —
            ``'x'``, ``'y'``, or ``'xy'`` for both axes.
        zoom_limit: Max zoom depth. A number applies to both axes;
            a ``(x, y)`` tuple sets per-axis limits.
        pan_limit: How far past data edges the user can pan. A number
            applies to both axes; a ``(x, y)`` tuple sets per-axis limits.
    """
    return Plot(
        *marks,
        width=width, height=height, margin=margin,
        x_label=x_label, y_label=y_label, fx=fx, columns=columns,
        legend=legend, interactors=interactors,
        use_selection=use_selection,
        zoom_limit=zoom_limit, pan_limit=pan_limit,
    )
