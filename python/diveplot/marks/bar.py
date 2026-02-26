from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

from ._base import Mark


@dataclass
class BarXMark(Mark):
    _mark_type: ClassVar[str] = "barX"

    x: Any = None
    x1: Any = None
    x2: Any = None
    y: Any = None
    fill: Any = None
    opacity: float | None = None
    padding: float | None = None
    padding_inner: float | None = None
    padding_outer: float | None = None
    align: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None


@dataclass
class BarYMark(Mark):
    _mark_type: ClassVar[str] = "barY"

    x: Any = None
    y: Any = None
    y1: Any = None
    y2: Any = None
    fill: Any = None
    opacity: float | None = None
    padding: float | None = None
    padding_inner: float | None = None
    padding_outer: float | None = None
    align: float | None = None
    inset: float | None = None
    dx: float | None = None
    dy: float | None = None
