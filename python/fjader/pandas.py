"""Register the ``.fj`` accessor on pandas DataFrames.

Usage::

    import fjader.pandas as fj

    df.fj.dot(x='a', y='b', fill='species')
    df.fj.bar_y(x='species', y=fj.count(), fill='species')
"""

from __future__ import annotations

import pandas as pd

from ._accessor import FjaderAccessor

pd.api.extensions.register_dataframe_accessor("fj")(FjaderAccessor)

# Re-export the full fjader API so users only need one import
from . import *  # noqa: E402, F401, F403
