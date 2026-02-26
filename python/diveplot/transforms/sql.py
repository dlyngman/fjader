"""SQL transform specs: filter, having, limit, orderby."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from ._base import TransformSpec


@dataclass(frozen=True)
class FilterTransform(TransformSpec):
    _transform_type: ClassVar[str] = "filter"
    condition: str = ""


@dataclass(frozen=True)
class HavingTransform(TransformSpec):
    _transform_type: ClassVar[str] = "having"
    condition: str = ""


@dataclass(frozen=True)
class LimitTransform(TransformSpec):
    _transform_type: ClassVar[str] = "limit"
    value: int = 0


@dataclass(frozen=True)
class OrderByTransform(TransformSpec):
    _transform_type: ClassVar[str] = "orderby"
    _fields: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {"transform": "orderby", "fields": list(self._fields)}
