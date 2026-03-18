"""FieldSpec helpers: count(), sum(), avg(), min_(), max_(), median(), bin(), window().

Users can pass these as channel values on marks, or use string shorthand.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

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


@dataclass(frozen=True)
class WindowField:
    """Structured window function field spec.

    Produces a SQL window expression like::

        AVG(value) OVER (PARTITION BY category ORDER BY date ROWS BETWEEN 10 PRECEDING AND CURRENT ROW)

    The ``frame`` argument is a ``[start, end]`` pair of integers:
    - negative → preceding rows
    - 0 → current row
    - positive → following rows

    Examples::

        dp.window("avg", "value", order_by="date", frame=[-10, 0])   # trailing 10
        dp.window("sum", "value", order_by="ts", partition_by="grp", frame=[-5, 5])  # centered ±5
    """

    window: AggregateType
    """Aggregate function to apply over the window (``'avg'``, ``'sum'``, etc.)."""
    field: str | None = None
    order_by: str | None = None
    partition_by: str | None = None
    frame: tuple[int, int] | list[int] | None = None
    """Row frame as ``[start, end]``. Negative = preceding, 0 = current row, positive = following."""

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"window": self.window}
        if self.field is not None:
            result["field"] = self.field
        if self.order_by is not None:
            result["orderBy"] = self.order_by
        if self.partition_by is not None:
            result["partitionBy"] = self.partition_by
        if self.frame is not None:
            result["frame"] = list(self.frame)
        return result


@dataclass(frozen=True)
class RawSqlField:
    """Raw SQL expression used as a channel value.

    Allows arbitrary SQL like ``EXTRACT(HOUR FROM "ts")`` or
    ``CASE WHEN x > 0 THEN 'pos' ELSE 'neg' END`` to be used
    directly as a mark channel without pre-computing in Python.

    Example::

        dp.dot(x=dp.sql_expr('EXTRACT(HOUR FROM "ts")'), y="value")
    """

    sql: str

    def to_dict(self) -> dict[str, str]:
        return {"sql": self.sql}


# Type alias for field specs accepted by mark channels
FieldSpec = str | AggregateField | BinField | WindowField | RawSqlField


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


def sql_expr(expression: str) -> RawSqlField:
    """Raw SQL expression as a field spec.

    Use this when you need a computed column that isn't a simple column name,
    aggregate, or bin — e.g. date extraction, conditional logic, casts.

    Args:
        expression: SQL expression string, e.g. ``'EXTRACT(HOUR FROM "ts")'``.

    Example::

        dp.dot(x=dp.sql_expr('EXTRACT(HOUR FROM "ts")'), y="temp")
    """
    return RawSqlField(sql=expression)


def window(
    aggregate: AggregateType,
    field: str | None = None,
    *,
    order_by: str | None = None,
    partition_by: str | None = None,
    frame: tuple[int, int] | list[int] | None = None,
) -> WindowField:
    """Window function field spec.

    Args:
        aggregate: Aggregate function (``'avg'``, ``'sum'``, ``'count'``, etc.).
        field: Column to aggregate (omit for ``'count'``).
        order_by: Column to order rows by within the window.
        partition_by: Column to partition (group) the window by.
        frame: Row frame as ``[start, end]``. Negative = preceding,
            0 = current row, positive = following.
            E.g. ``[-10, 0]`` = trailing 10 rows.
    """
    return WindowField(
        window=aggregate, field=field,
        order_by=order_by, partition_by=partition_by, frame=frame,
    )
