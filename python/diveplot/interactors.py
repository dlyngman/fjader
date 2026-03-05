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
