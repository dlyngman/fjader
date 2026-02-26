"""Shared DataFrame accessor for DivePlot.

Provides ``df.dp.dot(x='a', y='b')`` syntax for quick exploration.
Returns anywidget instances that auto-display in Jupyter and Marimo,
and support composition via ``*`` (overlay), ``+`` (layout), and ``.opts()``.

Registration is done by importing the appropriate module::

    import diveplot.pandas as dp   # registers .dp on pandas DataFrames
    import diveplot.polars as dp   # registers .dp on polars DataFrames
"""

from __future__ import annotations

from typing import Any

from . import marks as _marks
from ._display import show


class DivePlotAccessor:
    """DataFrame accessor — ``df.dp.dot(x='a', y='b', fill='species')``."""

    def __init__(self, df: Any) -> None:
        self._df = df

    def _call(self, factory: Any, **kwargs: Any) -> Any:
        for key in ("data", "table"):
            if key in kwargs:
                raise TypeError(
                    f"Cannot pass '{key}' through the .dp accessor — "
                    f"data is implicitly the DataFrame itself."
                )
        return show(factory(data=self._df, **kwargs))

    def dot(self, **kwargs: Any) -> Any:
        """Scatter/dot mark. See ``dp.dot()`` for parameters."""
        return self._call(_marks.dot, **kwargs)

    def bar_x(self, **kwargs: Any) -> Any:
        """Horizontal bar mark. See ``dp.bar_x()`` for parameters."""
        return self._call(_marks.bar_x, **kwargs)

    def bar_y(self, **kwargs: Any) -> Any:
        """Vertical bar mark. See ``dp.bar_y()`` for parameters."""
        return self._call(_marks.bar_y, **kwargs)

    def line(self, **kwargs: Any) -> Any:
        """Line mark. See ``dp.line()`` for parameters."""
        return self._call(_marks.line, **kwargs)

    def area_y(self, **kwargs: Any) -> Any:
        """Vertical area mark. See ``dp.area_y()`` for parameters."""
        return self._call(_marks.area_y, **kwargs)

    def area_x(self, **kwargs: Any) -> Any:
        """Horizontal area mark. See ``dp.area_x()`` for parameters."""
        return self._call(_marks.area_x, **kwargs)

    def rect(self, **kwargs: Any) -> Any:
        """Rectangle mark. See ``dp.rect()`` for parameters."""
        return self._call(_marks.rect, **kwargs)

    def rect_x(self, **kwargs: Any) -> Any:
        """Horizontal rect mark. See ``dp.rect_x()`` for parameters."""
        return self._call(_marks.rect_x, **kwargs)

    def rect_y(self, **kwargs: Any) -> Any:
        """Vertical rect mark. See ``dp.rect_y()`` for parameters."""
        return self._call(_marks.rect_y, **kwargs)

    def text(self, **kwargs: Any) -> Any:
        """Text mark. See ``dp.text()`` for parameters."""
        return self._call(_marks.text, **kwargs)
