"""Interactor specs — brushes and selection interactors for linked charts."""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any, ClassVar

from ._convert import clean_dict, serialize_value, to_camel_case


@dataclass(frozen=True)
class InteractorSpec:
    """Base for all interactor specs. Subclasses set _interactor_type."""

    _interactor_type: ClassVar[str]

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"interactor": self._interactor_type}
        for f in fields(self):
            if f.name.startswith("_"):
                continue
            val = getattr(self, f.name)
            if val is not None:
                result[to_camel_case(f.name)] = serialize_value(val)
        return clean_dict(result)


@dataclass(frozen=True)
class IntervalXSpec(InteractorSpec):
    """1D interval brush on the x-axis."""

    _interactor_type: ClassVar[str] = "intervalX"
    selection: str | None = None
    field: str | None = None


@dataclass(frozen=True)
class IntervalYSpec(InteractorSpec):
    """1D interval brush on the y-axis."""

    _interactor_type: ClassVar[str] = "intervalY"
    selection: str | None = None
    field: str | None = None


def interval_x(
    field: str | None = None, *, selection: str | None = None
) -> IntervalXSpec:
    """Create an x-axis interval brush interactor.

    Args:
        field: Optional field name override for the brush column.
        selection: Selection group name. Defaults to the first mark's selection.
    """
    return IntervalXSpec(field=field, selection=selection)


def interval_y(
    field: str | None = None, *, selection: str | None = None
) -> IntervalYSpec:
    """Create a y-axis interval brush interactor.

    Args:
        field: Optional field name override for the brush column.
        selection: Selection group name. Defaults to the first mark's selection.
    """
    return IntervalYSpec(field=field, selection=selection)


@dataclass(frozen=True)
class Interval2DSpec(InteractorSpec):
    """2D rectangle brush interactor."""

    _interactor_type: ClassVar[str] = "interval2D"
    selection: str | None = None
    x_field: str | None = None
    y_field: str | None = None


def interval_2d(
    x_field: str | None = None,
    y_field: str | None = None,
    *,
    selection: str | None = None,
) -> Interval2DSpec:
    """Create a 2D rectangle brush interactor.

    Args:
        x_field: Optional x-axis field override (auto-detected from chart).
        y_field: Optional y-axis field override (auto-detected from chart).
        selection: Selection group name. Defaults to the first mark's selection.
    """
    return Interval2DSpec(x_field=x_field, y_field=y_field, selection=selection)


@dataclass(frozen=True)
class ToggleSpec(InteractorSpec):
    """Click-to-toggle categorical filter."""

    _interactor_type: ClassVar[str] = "toggle"
    selection: str | None = None
    field: str | None = None


def toggle(
    field: str | None = None, *, selection: str | None = None
) -> ToggleSpec:
    """Create a click-to-toggle interactor for categorical filtering.

    Args:
        field: Column name to toggle on (e.g. ``"weather"``).
        selection: Selection group name. Defaults to the first mark's selection.
    """
    return ToggleSpec(field=field, selection=selection)


@dataclass(frozen=True)
class DerivedIntervalSpec(InteractorSpec):
    """Derived interval that follows a source brush at a calendar offset."""

    _interactor_type: ClassVar[str] = "derivedInterval"
    source: str | None = None
    selection: str | None = None
    offset: str | None = None
    axis: str | None = None
    relay_clauses: bool | None = None


def derived_interval(
    source: str,
    offset: str,
    *,
    selection: str | None = None,
    axis: str | None = None,
    relay_clauses: bool | None = None,
) -> DerivedIntervalSpec:
    """Create a derived interval that follows another brush at a calendar offset.

    The derived interval renders a non-interactive visual overlay showing the
    comparison time range. It emits its own Mosaic selection so comparison marks
    can filter by the derived range.

    Args:
        source: Name of the source selection group to follow.
        offset: Calendar offset string, e.g. ``"-1y"``, ``"-7d"``, ``"-1mo"``.
        selection: Selection group name for the derived filter.
        axis: Axis to follow (``"x"`` or ``"y"``). Defaults to ``"x"``.
        relay_clauses: Forward non-axis clauses (toggles, other filters) from
            the source selection to the derived selection. Defaults to ``True``.
    """
    return DerivedIntervalSpec(
        source=source, offset=offset, selection=selection, axis=axis,
        relay_clauses=relay_clauses,
    )
