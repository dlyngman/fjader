from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from ._base import Mark

if TYPE_CHECKING:
    from ..fields import ColorChannel, FieldSpec
    from .._types import CurveType, ScaleType


@dataclass
class LineMark(Mark):
    _mark_type: ClassVar[str] = "line"

    x: FieldSpec | None = None
    y: FieldSpec | None = None
    stroke: ColorChannel | None = None
    """Data-driven stroke color — column name for color scale, or None."""
    z: FieldSpec | None = None
    """Explicit series grouping (overrides implicit grouping from stroke)."""
    stroke_width: float | None = None
    dot_radius: float | None = None
    opacity: float | None = None
    curve: CurveType | None = None
    lod: bool | dict | None = None
    preferred_x_scale_type: ScaleType | None = None
    preferred_y_scale_type: ScaleType | None = None
