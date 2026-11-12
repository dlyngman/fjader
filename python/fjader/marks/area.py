from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, ClassVar

from ._base import Mark

if TYPE_CHECKING:
    from ..fields import ColorChannel, FieldSpec
    from .._types import CurveType, ScaleType


@dataclass
class AreaYMark(Mark):
    _mark_type: ClassVar[str] = "areaY"

    x: FieldSpec | None = None
    y: FieldSpec | None = None
    y1: FieldSpec | None = None
    y2: FieldSpec | None = None
    fill: ColorChannel | None = None
    z: FieldSpec | None = None
    """Explicit series grouping (overrides implicit grouping from fill)."""
    fill_opacity: float | None = None
    stroke: str | None = None
    """CSS color for area outline (e.g. ``'#333'``, ``'steelblue'``). Not data-driven."""
    stroke_width: float | None = None
    dot_radius: float | None = None
    auto_dots: bool | None = None
    curve: CurveType | None = None
    preferred_x_scale_type: ScaleType | None = None
    preferred_y_scale_type: ScaleType | None = None


@dataclass
class AreaXMark(Mark):
    _mark_type: ClassVar[str] = "areaX"

    y: FieldSpec | None = None
    x: FieldSpec | None = None
    x1: FieldSpec | None = None
    x2: FieldSpec | None = None
    fill: ColorChannel | None = None
    z: FieldSpec | None = None
    """Explicit series grouping (overrides implicit grouping from fill)."""
    fill_opacity: float | None = None
    stroke: str | None = None
    """CSS color for area outline (e.g. ``'#333'``, ``'steelblue'``). Not data-driven."""
    stroke_width: float | None = None
    dot_radius: float | None = None
    auto_dots: bool | None = None
    curve: CurveType | None = None
    preferred_x_scale_type: ScaleType | None = None
    preferred_y_scale_type: ScaleType | None = None
