"""JS transform specs: topN, stackY, stackX, normalize, dodge."""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from .._types import StackOffset
from ._base import TransformSpec


@dataclass(frozen=True)
class TopNTransform(TransformSpec):
    _transform_type: ClassVar[str] = "topN"
    n: int = 0
    by: str | None = None
    include_others: bool | None = None


@dataclass(frozen=True)
class StackYTransform(TransformSpec):
    _transform_type: ClassVar[str] = "stackY"
    offset: StackOffset | None = None


@dataclass(frozen=True)
class StackXTransform(TransformSpec):
    _transform_type: ClassVar[str] = "stackX"
    offset: StackOffset | None = None


@dataclass(frozen=True)
class NormalizeTransform(TransformSpec):
    _transform_type: ClassVar[str] = "normalize"


@dataclass(frozen=True)
class DodgeTransform(TransformSpec):
    _transform_type: ClassVar[str] = "dodge"
    bandwidth: float | None = None
