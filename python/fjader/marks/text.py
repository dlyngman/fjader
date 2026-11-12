from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from ._base import Mark

if TYPE_CHECKING:
    from ..fields import ColorChannel, FieldSpec
    from .._types import LineAnchor, ScaleType, TextAnchor


@dataclass
class TextMark(Mark):
    _mark_type: ClassVar[str] = "text"

    x: FieldSpec | None = None
    y: FieldSpec | None = None
    text: FieldSpec | None = None
    fill: ColorChannel | None = None
    font_size: float | None = None
    font_weight: str | None = None
    font_family: str | None = None
    dx: float | None = None
    dy: float | None = None
    text_anchor: TextAnchor | None = None
    line_anchor: LineAnchor | None = None
    rotate: float | None = None
    preferred_x_scale_type: ScaleType | None = None
    preferred_y_scale_type: ScaleType | None = None
