from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from ._base import Mark

if TYPE_CHECKING:
    from ..fields import FieldSpec


@dataclass
class BarXMark(Mark):
    _mark_type: ClassVar[str] = "barX"

    x: FieldSpec | None = None
    x1: FieldSpec | None = None
    x2: FieldSpec | None = None
    y: FieldSpec | None = None
    fill: FieldSpec | None = None
    opacity: float | None = None
    padding: float | None = None
    padding_inner: float | None = None
    padding_outer: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None


@dataclass
class BarYMark(Mark):
    _mark_type: ClassVar[str] = "barY"

    x: FieldSpec | None = None
    y: FieldSpec | None = None
    y1: FieldSpec | None = None
    y2: FieldSpec | None = None
    fill: FieldSpec | None = None
    opacity: float | None = None
    padding: float | None = None
    padding_inner: float | None = None
    padding_outer: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None
