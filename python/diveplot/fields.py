"""FieldSpec helpers: count(), sum(), avg(), min_(), max_(), median(), bin().

Users can pass these as channel values on marks, or use string shorthand.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ._types import AggregateType


@dataclass(frozen=True)
class AggregateField:
    """Structured aggregate field spec."""

    aggregate: AggregateType
    field: str | None = None

    def to_dict(self) -> dict[str, str]:
        result: dict[str, str] = {"aggregate": self.aggregate}
        if self.field is not None:
            result["field"] = self.field
        return result


@dataclass(frozen=True)
class BinField:
    """Structured bin field spec."""

    bin: str
    steps: int | None = None

    def to_dict(self) -> dict[str, str | int]:
        result: dict[str, str | int] = {"bin": self.bin}
        if self.steps is not None:
            result["steps"] = self.steps
        return result


# Type alias for field specs accepted by mark channels
FieldSpec = str | AggregateField | BinField


def count() -> AggregateField:
    """count() aggregate."""
    return AggregateField(aggregate="count")


def sum(field: str) -> AggregateField:  # noqa: A001
    return AggregateField(aggregate="sum", field=field)


def avg(field: str) -> AggregateField:
    return AggregateField(aggregate="avg", field=field)


def min_(field: str) -> AggregateField:
    """min aggregate. Trailing underscore avoids shadowing builtin."""
    return AggregateField(aggregate="min", field=field)


def max_(field: str) -> AggregateField:
    """max aggregate. Trailing underscore avoids shadowing builtin."""
    return AggregateField(aggregate="max", field=field)


def median(field: str) -> AggregateField:
    return AggregateField(aggregate="median", field=field)


def bin(field: str, *, steps: int | None = None) -> BinField:  # noqa: A001
    return BinField(bin=field, steps=steps)
