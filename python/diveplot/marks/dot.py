from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from ._base import Mark


@dataclass
class DotMark(Mark):
    _mark_type: ClassVar[str] = "dot"

    x: Any = None
    y: Any = None
    fill: Any = None
    opacity: float | None = None
    r: float | Any | None = None
    radius_range: list[float] | tuple[float, float] | None = None
    preferred_x_scale_type: str | None = None
    preferred_y_scale_type: str | None = None
