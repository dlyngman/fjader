from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar, Literal

from ._base import Mark

if TYPE_CHECKING:
    from ..fields import FieldSpec
    from .._types import CurveType, ScaleType


@dataclass
class LineMark(Mark):
    _mark_type: ClassVar[str] = "line"

    x: FieldSpec | None = None
    y: FieldSpec | None = None
    stroke: FieldSpec | None = None
    """Data-driven stroke color — column name for color scale, or None."""
    z: FieldSpec | None = None
    """Explicit series grouping (overrides implicit grouping from stroke)."""
    stroke_width: float | None = None
    dot_radius: float | None = None
    curve: CurveType | None = None
    optimize: bool | Literal["auto"] | None = None
    preferred_x_scale_type: ScaleType | None = None
    preferred_y_scale_type: ScaleType | None = None
