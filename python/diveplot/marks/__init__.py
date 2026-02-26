"""Mark factory functions — the public API for creating marks."""

from __future__ import annotations

from typing import Any

from .area import AreaXMark, AreaYMark
from .bar import BarXMark, BarYMark
from .dot import DotMark
from .line import LineMark
from .rect import RectMark, RectXMark, RectYMark
from .text import TextMark


def dot(**kwargs: Any) -> DotMark:
    return DotMark(**kwargs)


def bar_x(**kwargs: Any) -> BarXMark:
    return BarXMark(**kwargs)


def bar_y(**kwargs: Any) -> BarYMark:
    return BarYMark(**kwargs)


def line(**kwargs: Any) -> LineMark:
    return LineMark(**kwargs)


def area_y(**kwargs: Any) -> AreaYMark:
    return AreaYMark(**kwargs)


def area_x(**kwargs: Any) -> AreaXMark:
    return AreaXMark(**kwargs)


def rect(**kwargs: Any) -> RectMark:
    return RectMark(**kwargs)


def rect_x(**kwargs: Any) -> RectXMark:
    return RectXMark(**kwargs)


def rect_y(**kwargs: Any) -> RectYMark:
    return RectYMark(**kwargs)


def text(**kwargs: Any) -> TextMark:
    return TextMark(**kwargs)
