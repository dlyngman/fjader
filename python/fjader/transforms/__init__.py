"""Transform factory functions matching the JS transform API."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .js import (
    DodgeTransform,
    NormalizeTransform,
    StackXTransform,
    StackYTransform,
    TopNTransform,
)
from .sql import FilterTransform, HavingTransform, LimitTransform, OrderByTransform

if TYPE_CHECKING:
    from .._types import StackOffset
    from ._base import TransformSpec  # noqa: F401


def filter(condition: str) -> FilterTransform:
    """SQL WHERE filter. Condition is raw SQL."""
    return FilterTransform(condition=condition)


def having(condition: str) -> HavingTransform:
    """SQL HAVING filter. Condition is raw SQL."""
    return HavingTransform(condition=condition)


def limit(n: int) -> LimitTransform:
    return LimitTransform(value=n)


def orderby(*fields: str) -> OrderByTransform:
    return OrderByTransform(_fields=fields)


def topN(n: int, *, by: str | None = None, include_others: bool | None = None) -> TopNTransform:
    return TopNTransform(n=n, by=by, include_others=include_others)


def stack_y(*, offset: StackOffset | None = None) -> StackYTransform:
    return StackYTransform(offset=offset)


def stack_x(*, offset: StackOffset | None = None) -> StackXTransform:
    return StackXTransform(offset=offset)


def normalize() -> NormalizeTransform:
    return NormalizeTransform()


def dodge(*, bandwidth: float | None = None) -> DodgeTransform:
    return DodgeTransform(bandwidth=bandwidth)
