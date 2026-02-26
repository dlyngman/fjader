"""Register the ``.dp`` accessor on pandas DataFrames.

Usage::

    import diveplot.pandas as dp

    df.dp.dot(x='a', y='b', fill='species')
    df.dp.bar_y(x='species', y=dp.count(), fill='species')
"""

from __future__ import annotations

import pandas as pd

from ._accessor import DivePlotAccessor

pd.api.extensions.register_dataframe_accessor("dp")(DivePlotAccessor)

# Re-export the full diveplot API so users only need one import
from . import *  # noqa: E402, F401, F403
