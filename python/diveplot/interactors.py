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
    field: str | None = None


@dataclass(frozen=True)
class IntervalYSpec(InteractorSpec):
    """1D interval brush on the y-axis."""

    _interactor_type: ClassVar[str] = "intervalY"
    field: str | None = None


def interval_x(field: str | None = None) -> IntervalXSpec:
    """Create an x-axis interval brush interactor.

    Args:
        field: Optional field name override for the brush column.
    """
    return IntervalXSpec(field=field)


def interval_y(field: str | None = None) -> IntervalYSpec:
    """Create a y-axis interval brush interactor.

    Args:
        field: Optional field name override for the brush column.
    """
    return IntervalYSpec(field=field)
