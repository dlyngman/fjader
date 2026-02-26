"""DivePlot — GPU-accelerated data visualization for Python.

Phase 1: Spec generation. Produces JSON specs consumed by the DivePlot
JavaScript renderer.

Usage:
    import diveplot as dp

    chart = dp.dot(table='penguins', x='bill_length', y='bill_depth', fill='species')
    chart.to_dict()

    # Overlay (two marks, one chart)
    overlay = dp.dot(table='t', x='a', y='b') * dp.line(table='t', x='a', y='b')

    # Layout (two charts side by side)
    layout = dp.dot(table='t', x='a', y='b') + dp.bar_y(table='t', x='species', y='count()')

    # Chart-level config
    dp.plot(dp.dot(table='t', x='a', y='b'), width=600, x_label='X')
"""

from ._version import __version__

# Mark factory functions
from .marks import dot, bar_x, bar_y, line, area_y, area_x, rect, rect_x, rect_y, text

# Chart container
from .plot import plot

# Layout helpers
from .layout import hconcat, vconcat

# Transforms
from .transforms import (
    filter,
    having,
    limit,
    orderby,
    topN,
    stack_y,
    stack_x,
    normalize,
    dodge,
)

# Field spec helpers
from .fields import count, sum, avg, min_, max_, median, bin

# Data helpers
from .data import sql

# Display helpers
from ._display import show

# Types (for type annotations in user code)
from ._types import ColorScheme, CurveType, ScaleType, SortConfig, TextAnchor, LineAnchor
from .fields import FieldSpec

__all__ = [
    "__version__",
    # Marks
    "dot", "bar_x", "bar_y", "line", "area_y", "area_x",
    "rect", "rect_x", "rect_y", "text",
    # Chart
    "plot",
    # Layout
    "hconcat", "vconcat",
    # Transforms
    "filter", "having", "limit", "orderby",
    "topN", "stack_y", "stack_x", "normalize", "dodge",
    # Fields
    "count", "sum", "avg", "min_", "max_", "median", "bin",
    # Data
    "sql",
    # Display
    "show",
    # Types
    "FieldSpec", "ColorScheme", "CurveType", "ScaleType",
    "SortConfig", "TextAnchor", "LineAnchor",
]
