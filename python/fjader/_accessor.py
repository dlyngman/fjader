"""Shared DataFrame accessor for Fjader.

Provides ``df.fj.dot(x='a', y='b')`` syntax for quick exploration.
Returns anywidget instances that auto-display in Jupyter and Marimo,
and support composition via ``*`` (overlay), ``+`` (layout), and ``.opts()``.

Registration is done by importing the appropriate module::

    import fjader.pandas as fj   # registers .fj on pandas DataFrames
    import fjader.polars as fj   # registers .fj on polars DataFrames
"""

from __future__ import annotations

from typing import Any

from . import marks as _marks
from ._display import show


class FjaderAccessor:
    """DataFrame accessor — ``df.fj.dot(x='a', y='b', fill='species')``."""

    def __init__(self, df: Any) -> None:
        self._df = df

    def _call(self, factory: Any, **kwargs: Any) -> Any:
        for key in ("data", "table"):
            if key in kwargs:
                raise TypeError(
                    f"Cannot pass '{key}' through the .fj accessor — "
                    f"data is implicitly the DataFrame itself."
                )
        return show(factory(data=self._df, **kwargs))

    def dot(self, **kwargs: Any) -> Any:
        """Scatter/dot mark. See ``fj.dot()`` for parameters."""
        return self._call(_marks.dot, **kwargs)

    def bar_x(self, **kwargs: Any) -> Any:
        """Horizontal bar mark. See ``fj.bar_x()`` for parameters."""
        return self._call(_marks.bar_x, **kwargs)

    def bar_y(self, **kwargs: Any) -> Any:
        """Vertical bar mark. See ``fj.bar_y()`` for parameters."""
        return self._call(_marks.bar_y, **kwargs)

    def line(self, **kwargs: Any) -> Any:
        """Line mark. See ``fj.line()`` for parameters."""
        return self._call(_marks.line, **kwargs)

    def area_y(self, **kwargs: Any) -> Any:
        """Vertical area mark. See ``fj.area_y()`` for parameters."""
        return self._call(_marks.area_y, **kwargs)

    def area_x(self, **kwargs: Any) -> Any:
        """Horizontal area mark. See ``fj.area_x()`` for parameters."""
        return self._call(_marks.area_x, **kwargs)

    def rect(self, **kwargs: Any) -> Any:
        """Rectangle mark. See ``fj.rect()`` for parameters."""
        return self._call(_marks.rect, **kwargs)

    def rect_x(self, **kwargs: Any) -> Any:
        """Horizontal rect mark. See ``fj.rect_x()`` for parameters."""
        return self._call(_marks.rect_x, **kwargs)

    def rect_y(self, **kwargs: Any) -> Any:
        """Vertical rect mark. See ``fj.rect_y()`` for parameters."""
        return self._call(_marks.rect_y, **kwargs)

    def text(self, **kwargs: Any) -> Any:
        """Text mark. See ``fj.text()`` for parameters."""
        return self._call(_marks.text, **kwargs)
