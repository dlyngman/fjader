from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from ._base import Mark

if TYPE_CHECKING:
    from ..fields import ColorChannel, FieldSpec
    from .._types import ScaleType


@dataclass
class DotMark(Mark):
    _mark_type: ClassVar[str] = "dot"

    x: FieldSpec | None = None
    y: FieldSpec | None = None
    fill: ColorChannel | None = None
    opacity: float | None = None
    r: float | FieldSpec | None = None
    radius_range: list[float] | tuple[float, float] | None = None
    preferred_x_scale_type: ScaleType | None = None
    preferred_y_scale_type: ScaleType | None = None
