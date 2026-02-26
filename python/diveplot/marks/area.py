from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from ._base import Mark


@dataclass
class AreaYMark(Mark):
    _mark_type: ClassVar[str] = "areaY"

    x: Any = None
    y: Any = None
    y1: Any = None
    y2: Any = None
    fill: Any = None
    z: Any = None
    fill_opacity: float | None = None
    stroke: str | None = None
    stroke_width: float | None = None
    dot_radius: float | None = None
    curve: str | None = None
    preferred_x_scale_type: str | None = None
    preferred_y_scale_type: str | None = None


@dataclass
class AreaXMark(Mark):
    _mark_type: ClassVar[str] = "areaX"

    y: Any = None
    x: Any = None
    x1: Any = None
    x2: Any = None
    fill: Any = None
    z: Any = None
    fill_opacity: float | None = None
    stroke: str | None = None
    stroke_width: float | None = None
    dot_radius: float | None = None
    curve: str | None = None
    preferred_x_scale_type: str | None = None
    preferred_y_scale_type: str | None = None
