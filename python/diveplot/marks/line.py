from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from ._base import Mark


@dataclass
class LineMark(Mark):
    _mark_type: ClassVar[str] = "line"

    x: Any = None
    y: Any = None
    stroke: Any = None
    z: Any = None
    stroke_width: float | None = None
    dot_radius: float | None = None
    curve: str | None = None
    optimize: bool | str | None = None
    preferred_x_scale_type: str | None = None
    preferred_y_scale_type: str | None = None
