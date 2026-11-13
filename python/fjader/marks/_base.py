"""Base Mark class with composition operators and serialization."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, fields as dc_fields
from typing import TYPE_CHECKING, Any, ClassVar, Literal

from .._convert import clean_dict, serialize_value, to_camel_case

if TYPE_CHECKING:
    from .._types import ColorScheme, DomainConfig, SortConfig
    from ..fields import AggregateField
    from ..transforms._base import TransformSpec


def _serialize_tip_entry(entry: Any) -> Any:
    """Serialize a single tip array entry.

    Handles: strings, AggregateField, and labeled entries via either:
    - tuple: ``("Min", fj.min_("value"))``
    - dict:  ``{"Min": fj.min_("value")}``
    Both serialize to ``{"value": {...}, "label": "Min"}``.
    """
    if isinstance(entry, str):
        return entry
    if isinstance(entry, tuple) and len(entry) == 2:
        label, expr = entry
        return {"value": serialize_value(expr), "label": label}
    if isinstance(entry, dict) and len(entry) == 1:
        label, expr = next(iter(entry.items()))
        return {"value": serialize_value(expr), "label": label}
    return serialize_value(entry)


@dataclass
class Mark:
    """Base class for all mark specs.

    Subclasses set _mark_type and declare their channel/prop fields.
    """

    _mark_type: ClassVar[str]

    # Common props from BaseMarkSpec in types.ts
    table: str | None = None
    selection: str | None = None
    # How the mark responds to selections in its group. "auto" (default): a
    # categorical selection on a field the mark draws by dims it, others filter
    # it. "filter": every selection filters it, so aggregates are recomputed
    # for the subset (top N within the selected region). A "filter" mark never
    # dims; a legend, Toggle or band label filters it in its own chart too,
    # while a brush still skips its own chart. "ignore": no selection filters
    # or dims it; context, such as the whole drawn behind a filtered part:
    # fj.bar_y(..., selection_response="ignore", opacity=0.2) * fj.bar_y(...).
    selection_response: Literal["auto", "filter", "ignore"] | None = None
    # NULL in the mark's categorical channels (band axis, ordinal colour,
    # series, facet). "keep" (default): a category like any other, drawn and
    # labelled "(null)". "drop": those rows are left out before any transform,
    # so a top N ranks, and Other sums, without them.
    nulls: Literal["keep", "drop"] | None = None
    # Whether the chart's entrance waits for this mark's first data. True
    # (default): the chart enters once its marks have landed, so later marks
    # cannot widen the axes mid-entrance. False for a mark known to be slow:
    # the chart enters without it, and it joins or appears after.
    holds_entrance: bool | None = None
    scheme: ColorScheme | None = None
    limit: int | None = None
    transforms: list[TransformSpec] | None = None
    sort: SortConfig | None = None
    domain: DomainConfig | None = None
    # Hover tooltips, or options: {"sort_table": True} writes the tooltip table
    # sorted by x (zone-map skipping in hover lookups); off by default.
    tooltip: bool | dict[str, bool] | None = None
    tooltip_proximity: Literal["x", "y", "xy"] | None = None
    tip: list[str | AggregateField | dict[str, AggregateField]] | Literal[False] | None = None
    fit_domain: Literal["x", "y"] | bool | None = None

    # DataFrame attachment (not serialized — data travels via binary traitlets)
    data: Any = field(default=None, repr=False, compare=False)

    # Internal state (not serialized)
    _opts: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    def __post_init__(self) -> None:
        if self.data is not None and self.table is not None:
            raise ValueError(
                "Cannot specify both 'data' and 'table'. "
                "Use 'data' for inline DataFrames or 'table' for pre-loaded DuckDB tables."
            )
        if self.data is not None:
            from .._data import df_to_ipc_cached

            h, _ = df_to_ipc_cached(self.data)
            self.table = f"_df_{h}"

    def to_mark_dict(self) -> dict[str, Any]:
        """Serialize to a MarkSpec dict (without FjaderSpec wrapper)."""
        result: dict[str, Any] = {"mark": self._mark_type}
        for f in dc_fields(self):
            if f.name.startswith("_") or f.name == "data":
                continue
            val = getattr(self, f.name)
            if val is None:
                continue
            key = to_camel_case(f.name)
            if f.name == "transforms":
                result[key] = [serialize_value(t) for t in val]
            elif f.name == "tip" and isinstance(val, list):
                result[key] = [_serialize_tip_entry(v) for v in val]
            else:
                result[key] = serialize_value(val)
        return clean_dict(result)

    def opts(self, **kwargs: Any) -> Any:
        """Apply chart-level options. Returns a Plot wrapping this mark."""
        from ..plot import Plot

        return Plot(self, **kwargs)

    def to_dict(self) -> dict[str, Any]:
        """Full FjaderSpec with this mark in a single-chart plot."""
        from ..plot import Plot

        return Plot(self, **self._opts).to_dict()

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    def _collect_data(self) -> dict[str, Any]:
        """Return {table_name: df} for marks with data attached."""
        if self.data is not None and self.table is not None:
            return {self.table: self.data}
        return {}

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """Return (spec_dict, dataframes_dict) for widget rendering."""
        from ..plot import Plot

        p = Plot(self, **self._opts)
        return p._to_full_spec()

    def _repr_mimebundle_(self, **kwargs: Any) -> Any:
        from .._display import make_widget

        return make_widget(self)._repr_mimebundle_(**kwargs)

    def __mul__(self, other: Any) -> Any:
        from ..layout import Overlay

        return Overlay(marks=_get_marks(self) + _get_marks(other))

    def __rmul__(self, other: Any) -> Any:
        if isinstance(other, Mark):
            return other.__mul__(self)
        return NotImplemented

    def __add__(self, other: Any) -> Any:
        from ..layout import HConcat

        return HConcat(items=_to_plots(self) + _to_plots(other))

    def __radd__(self, other: Any) -> Any:
        if isinstance(other, Mark):
            return other.__add__(self)
        return NotImplemented


def _get_marks(obj: Any) -> list[Mark]:
    """Extract list of marks from a Mark, Overlay, or Plot."""
    from ..layout import Overlay
    from ..plot import Plot

    if isinstance(obj, Mark):
        return [obj]
    if isinstance(obj, Overlay):
        return list(obj.marks)
    if isinstance(obj, Plot):
        return list(obj._marks)
    raise TypeError(f"Cannot get marks from {type(obj).__name__}")


def _to_plots(obj: Any) -> list[Any]:
    """Convert to list of Plot instances for layout composition."""
    from ..layout import HConcat, Overlay
    from ..plot import Plot

    if isinstance(obj, Mark):
        return [Plot(obj)]
    if isinstance(obj, Overlay):
        return [Plot(*obj.marks, **obj._opts)]
    if isinstance(obj, Plot):
        return [obj]
    if isinstance(obj, HConcat):
        return list(obj.items)
    raise TypeError(f"Cannot convert {type(obj).__name__} to plots")
