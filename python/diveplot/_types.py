"""Type aliases matching the TypeScript spec contract in src/lib/spec/types.ts."""

from __future__ import annotations

from typing import Literal, TypedDict

AggregateType = Literal["count", "sum", "avg", "min", "max", "median"]

ScaleType = Literal["linear", "log", "symlog", "pow", "identity", "band", "point", "time"]

ColorScheme = Literal[
    # Category
    "category10", "accent", "dark2", "paired", "pastel1", "pastel2",
    "set1", "set2", "set3", "tableau10",
    # Sequential
    "blues", "greens", "greys", "oranges", "purples", "reds",
    "viridis", "inferno", "magma", "plasma", "cividis", "turbo",
    "warm", "cool", "cubehelixdefault",
    "bugn", "bupu", "gnbu", "orrd", "pubugn", "pubu", "purd", "rdpu",
    "ylgnbu", "ylgn", "ylorbr", "ylorrd",
    # Diverging
    "brbg", "prgn", "piyg", "puor", "rdbu", "rdgy", "rdylbu", "rdylgn", "spectral",
    # Cyclical
    "rainbow", "sinebow",
]

CurveType = Literal[
    "linear", "step", "step-before", "step-after",
    "catmull-rom", "monotone", "monotone-x", "monotone-y",
    "bump", "bump-x", "bump-y",
]

SortOrder = Literal["asc", "desc"]

StackOffset = Literal["expand", "center"]

TextAnchor = Literal["start", "middle", "end"]

LineAnchor = Literal["top", "middle", "bottom"]


class SortConfig(TypedDict, total=False):
    """Sort configuration for a mark's axis.

    Specify either ``x`` or ``y`` (not both) with the column name to sort by,
    and optionally ``order`` for direction (defaults to ``'asc'``).

    Examples::

        sort={'y': 'count', 'order': 'desc'}   # sort y-axis by count, descending
        sort={'x': 'date'}                      # sort x-axis by date, ascending
        sort={'x': 'name', 'order': 'asc'}      # sort x-axis alphabetically
    """

    x: str
    """Column name to sort the x-axis by."""

    y: str
    """Column name to sort the y-axis by."""

    order: SortOrder
    """Sort direction: ``'asc'`` (default) or ``'desc'``."""


class DomainConfig(TypedDict, total=False):
    """Explicit category domain for band/point scales.

    Specifies the exact categories and their order for the axis.
    Values not in the domain are excluded; domain values with no data
    get an empty slot.

    Examples::

        domain={'x': ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']}
        domain={'y': ['low', 'medium', 'high']}
    """

    x: list[str]
    """Explicit category order for the x-axis."""

    y: list[str]
    """Explicit category order for the y-axis."""
