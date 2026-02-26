from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from ._base import Mark


@dataclass
class TextMark(Mark):
    _mark_type: ClassVar[str] = "text"

    x: Any = None
    y: Any = None
    text: Any = None
    fill: Any = None
    font_size: float | None = None
    font_weight: str | None = None
    font_family: str | None = None
    dx: float | None = None
    dy: float | None = None
    text_anchor: str | None = None
    line_anchor: str | None = None
    rotate: float | None = None
    preferred_x_scale_type: str | None = None
    preferred_y_scale_type: str | None = None
