"""Register the ``.fj`` accessor on polars DataFrames.

Usage::

    import fjader.polars as fj

    df.fj.dot(x='a', y='b', fill='species')
    df.fj.bar_y(x='species', y=fj.count(), fill='species')
"""

from __future__ import annotations

import polars as pl

from ._accessor import FjaderAccessor

pl.api.register_dataframe_namespace("fj")(FjaderAccessor)

# Re-export the full fjader API so users only need one import
from . import *  # noqa: E402, F401, F403
