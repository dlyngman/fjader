"""Register the ``.dp`` accessor on polars DataFrames.

Usage::

    import diveplot.polars as dp

    df.dp.dot(x='a', y='b', fill='species')
    df.dp.bar_y(x='species', y=dp.count(), fill='species')
"""

from __future__ import annotations

import polars as pl

from ._accessor import DivePlotAccessor

pl.api.register_dataframe_namespace("dp")(DivePlotAccessor)

# Re-export the full diveplot API so users only need one import
from . import *  # noqa: E402, F401, F403
