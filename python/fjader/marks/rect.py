from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from ._base import Mark

if TYPE_CHECKING:
    from ..fields import FieldSpec
    from .._types import ScaleType


@dataclass
class RectMark(Mark):
    _mark_type: ClassVar[str] = "rect"

    x: FieldSpec | None = None
    x1: FieldSpec | None = None
    x2: FieldSpec | None = None
    y: FieldSpec | None = None
    y1: FieldSpec | None = None
    y2: FieldSpec | None = None
    fill: FieldSpec | None = None
    opacity: float | None = None
    preferred_x_scale_type: ScaleType | None = None
    preferred_y_scale_type: ScaleType | None = None
    padding: float | None = None
    padding_inner: float | None = None
    padding_outer: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None


@dataclass
class RectXMark(Mark):
    _mark_type: ClassVar[str] = "rectX"

    x: FieldSpec | None = None
    x1: FieldSpec | None = None
    x2: FieldSpec | None = None
    y: FieldSpec | None = None
    y1: FieldSpec | None = None
    y2: FieldSpec | None = None
    fill: FieldSpec | None = None
    opacity: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None
    preferred_y_scale_type: ScaleType | None = None


@dataclass
class RectYMark(Mark):
    _mark_type: ClassVar[str] = "rectY"

    x: FieldSpec | None = None
    x1: FieldSpec | None = None
    x2: FieldSpec | None = None
    y: FieldSpec | None = None
    y1: FieldSpec | None = None
    y2: FieldSpec | None = None
    fill: FieldSpec | None = None
    opacity: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None
    preferred_x_scale_type: ScaleType | None = None
