"""Plot class — a single chart with marks and chart-level configuration."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ._convert import serialize_value, to_camel_case
from .marks._base import Mark

if TYPE_CHECKING:
    from ._types import SortConfig

_PLOT_FIELDS = ("width", "height", "margin", "x_label", "y_label", "fx", "columns")


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

    def __init__(self, *marks: Mark, **kwargs: Any) -> None:
        unexpected = set(kwargs) - set(_PLOT_FIELDS)
        if unexpected:
            raise TypeError(
                f"plot() got unexpected keyword argument(s): {', '.join(sorted(unexpected))}"
            )
        self._marks = list(marks)
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

    def _to_plot_spec(self) -> dict[str, Any]:
        """Produce the PlotSpec portion (without outer data wrapper)."""
        spec: dict[str, Any] = {"marks": [m.to_mark_dict() for m in self._marks]}
        for key in _PLOT_FIELDS:
            val = getattr(self, key)
            if val is not None:
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
    """
    return Plot(
        *marks,
        width=width, height=height, margin=margin,
        x_label=x_label, y_label=y_label, fx=fx, columns=columns,
    )
