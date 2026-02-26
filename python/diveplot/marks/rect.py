from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from ._base import Mark


@dataclass
class RectMark(Mark):
    _mark_type: ClassVar[str] = "rect"

    x: Any = None
    x1: Any = None
    x2: Any = None
    y: Any = None
    y1: Any = None
    y2: Any = None
    fill: Any = None
    opacity: float | None = None
    preferred_x_scale_type: str | None = None
    preferred_y_scale_type: str | None = None
    padding: float | None = None
    padding_inner: float | None = None
    padding_outer: float | None = None
    align: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None


@dataclass
class RectXMark(Mark):
    _mark_type: ClassVar[str] = "rectX"

    x: Any = None
    x1: Any = None
    x2: Any = None
    y: Any = None
    y1: Any = None
    y2: Any = None
    fill: Any = None
    opacity: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None
    preferred_y_scale_type: str | None = None
    viewport_local_domain: bool | None = None


@dataclass
class RectYMark(Mark):
    _mark_type: ClassVar[str] = "rectY"

    x: Any = None
    x1: Any = None
    x2: Any = None
    y: Any = None
    y1: Any = None
    y2: Any = None
    fill: Any = None
    opacity: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None
    preferred_x_scale_type: str | None = None
    viewport_local_domain: bool | None = None
