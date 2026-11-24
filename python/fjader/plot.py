"""Plot class — a single chart with marks and chart-level configuration."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from ._convert import serialize_value, to_camel_case
from .interactors import InteractorSpec
from .marks._base import Mark

if TYPE_CHECKING:
    from ._types import SortConfig

_PLOT_FIELDS = (
    "width", "height", "margin", "x_label", "y_label",
    "y_title_placement", "y_title_offset", "x_title_anchor", "frame",
    "x_scale", "y_scale", "fx",
    "columns", "legend",
    "interactors", "use_selection", "zoom_limit", "pan_limit", "disable_zoom",
    "entrance",
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
    y_title_placement: Literal["side", "top"] | None = None
    y_title_offset: int | float | Literal["auto"] | None = None
    x_title_anchor: Literal["start", "center", "end"] | None = None
    frame: bool | None = None
    x_scale: str | Literal[False] | None = None
    y_scale: str | Literal[False] | None = None
    fx: str | None = None
    columns: int | None = None
    legend: dict[str, Any] | bool | None = None
    interactors: list[InteractorSpec] | None = None
    use_selection: str | None = None  # 'x' | 'y' | 'xy'
    zoom_limit: int | float | tuple[int | float, int | float] | None = None
    pan_limit: int | float | tuple[int | float, int | float] | None = None
    disable_zoom: str | bool | None = None  # 'x', 'y', 'xy', or True (both)
    entrance: Literal["auto", "fade", "none"] | None = None

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
            elif key == "disable_zoom":
                if val is True or val == "xy":
                    spec["xDisableZoom"] = True
                    spec["yDisableZoom"] = True
                elif isinstance(val, str):
                    if "x" in val:
                        spec["xDisableZoom"] = True
                    if "y" in val:
                        spec["yDisableZoom"] = True
            else:
                spec[to_camel_case(key)] = serialize_value(val)
        return spec

    def to_dict(self) -> dict[str, Any]:
        """Full FjaderSpec."""
        result: dict[str, Any] = {}
        result["plot"] = self._to_plot_spec()
        return result

    def _collect_data(self) -> dict[str, Any]:
        """Return {table_name: snapshot} for all marks with data attached."""
        result: dict[str, Any] = {}
        for m in self._marks:
            result.update(m._collect_data())
        return result

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """Return (spec_dict, {table name: TableSnapshot}) for widget rendering."""
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
    y_title_placement: Literal["side", "top"] | None = None,
    y_title_offset: int | float | Literal["auto"] | None = None,
    x_title_anchor: Literal["start", "center", "end"] | None = None,
    frame: bool | None = None,
    x_scale: str | Literal[False] | None = None,
    y_scale: str | Literal[False] | None = None,
    fx: str | None = None,
    columns: int | None = None,
    legend: dict[str, Any] | bool | None = None,
    interactors: list[InteractorSpec] | None = None,
    use_selection: str | None = None,
    zoom_limit: int | float | tuple[int | float, int | float] | None = None,
    pan_limit: int | float | tuple[int | float, int | float] | None = None,
    disable_zoom: str | bool | None = None,
    entrance: Literal["auto", "fade", "none"] | None = None,
) -> Plot:
    """Create a chart with one or more marks and chart-level configuration.

    Args:
        *marks: Mark instances to include in the chart.
        width: Chart width in CSS pixels.
        height: Chart height in CSS pixels.
        margin: Dict with ``top``/``right``/``bottom``/``left`` pixel values.
        x_label: X-axis title. Defaults to the column the axis shows; ``""``
            draws no title.
        y_label: Y-axis title, as ``x_label``.
        y_title_placement: Where the y-axis title goes: ``"side"`` (default),
            rotated beside the tick labels, or ``"top"``, horizontal above the
            plot, clear of long tick labels.
        y_title_offset: How far left of the y axis a ``"side"`` title sits, in
            pixels (default 32), or ``"auto"`` to clear the widest tick label
            as far as the left margin allows.
        x_title_anchor: Where along the x axis its title sits: ``"start"``,
            ``"center"`` (default) or ``"end"``.
        frame: Draw the border around the plot area (default ``True``).
        x_scale: Which charts share the x axis (domain, zoom and pan). By
            default axes with the same label share, else the same column,
            across tables; an aggregate without a label is this chart's own.
            A name shares with the charts naming it, on numeric and time axes
            (band and point axes ignore it with a warning); ``False`` keeps the
            axis to this chart.
        y_scale: As ``x_scale``, for the y axis.
        fx: Facet column name.
        columns: Number of columns for facet grid.
        legend: Legend config — ``True`` for auto-detect, or a dict like
            ``{"color": "species", "position": "right"}``.
        interactors: List of interactor specs (e.g. ``[fj.interval_x()]``).
        use_selection: Follow a brush as a linked detail chart — ``'x'``,
            ``'y'``, or ``'xy'`` for both axes. Follows an ``interval_x()``
            (``interval_y()`` for y) on an axis with the same label, else the
            same column, of the same scale type. ``interval_2d()`` only filters:
            it can't be followed.
        zoom_limit: Max zoom depth. A number applies to both axes;
            a ``(x, y)`` tuple sets per-axis limits.
        pan_limit: How far past data edges the user can pan. A number
            applies to both axes; a ``(x, y)`` tuple sets per-axis limits.
        disable_zoom: Disable user zoom/pan on axes — ``'x'``, ``'y'``,
            ``'xy'``, or ``True`` (both). Useful for auto-scaled axes
            driven by ``fit_domain``.
        entrance: How the marks enter when their data first draws. ``"auto"``
            (default) grows bars, histograms and areas from 0 and fades the
            rest; ``"fade"`` fades everything; ``"none"`` shows them at once.
            The axes never move on load. Reduced motion turns ``"auto"`` into
            ``"fade"``.
    """
    return Plot(
        *marks,
        width=width, height=height, margin=margin,
        x_label=x_label, y_label=y_label,
        y_title_placement=y_title_placement, y_title_offset=y_title_offset,
        x_title_anchor=x_title_anchor, frame=frame,
        x_scale=x_scale, y_scale=y_scale,
        fx=fx, columns=columns,
        legend=legend, interactors=interactors,
        use_selection=use_selection,
        zoom_limit=zoom_limit, pan_limit=pan_limit,
        disable_zoom=disable_zoom,
        entrance=entrance,
    )
