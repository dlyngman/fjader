"""Type aliases matching the TypeScript spec contract in src/lib/spec/types.ts."""

from __future__ import annotations

from typing import Literal

AggregateType = Literal["count", "sum", "avg", "min", "max", "median"]

ScaleType = Literal["linear", "log", "pow", "identity", "band", "point", "time"]

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
