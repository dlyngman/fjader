"""Time Series Explorer — Streamlit test app for DivePlot.

Demonstrates overview+detail, hourly/weekly distributions, and
crossfilter via day-of-week toggle — all in a single render call
so selections work across charts.
"""

from datetime import datetime, timedelta

import numpy as np
import polars as pl
import streamlit as st

import diveplot as dp

st.set_page_config(layout="wide", page_title="Time Series Explorer")
st.title("Time Series Explorer")

# ---------------------------------------------------------------------------
# Sidebar controls
# ---------------------------------------------------------------------------
USE_SERVER = st.sidebar.toggle("Use server-side DuckDB", value=False)

show_comparison = st.sidebar.toggle("Show comparison period", value=False)
comparison_offset = st.sidebar.selectbox(
    "Compare with",
    options=["-1yw", "-52w", "-1y", "-1mo", "-7d"],
    format_func={
        "-1yw": "Last year (week-aligned)",
        "-52w": "52 weeks ago",
        "-1y": "1 year ago",
        "-1mo": "1 month ago",
        "-7d": "1 week ago",
    }.get,
    index=0,
    disabled=not show_comparison,
)

# ---------------------------------------------------------------------------
# Generate synthetic hourly energy-usage data (2 years, 3 groups)
# ---------------------------------------------------------------------------
np.random.seed(42)

GROUPS = ["Residential", "Commercial", "Industrial"]
GROUP_MULTS = np.array([1.0, 1.4, 0.7])
N_GROUPS = len(GROUPS)

# Timestamps (one per hour, repeated per group)
base_ts = pl.datetime_range(
    datetime(2023, 1, 1), datetime(2024, 12, 31, 23), interval="1h", eager=True
)
N_HOURS = len(base_ts)
TOTAL = N_HOURS * N_GROUPS

# Extract time features via polars (no Python loop)
hours_np = base_ts.dt.hour().to_numpy()
dows_np = base_ts.dt.weekday().to_numpy() - 1  # polars: 1=Mon → 0=Mon
doys_np = base_ts.dt.ordinal_day().to_numpy()

# Tile for each group
ts_col = pl.concat([base_ts] * N_GROUPS)
hours = np.tile(hours_np, N_GROUPS)
dows = np.tile(dows_np, N_GROUPS)
doys = np.tile(doys_np, N_GROUPS)
idx = np.tile(np.arange(N_HOURS), N_GROUPS)
group_mult = np.repeat(GROUP_MULTS, N_HOURS)

group_col: list[str] = []
for g in GROUPS:
    group_col.extend([g] * N_HOURS)

# --- Realistic seasonal patterns ---
# Daily: trough at 4am, peak at 1pm
daily = 0.05 + 0.95 * np.maximum(0, np.cos((hours - 13) * np.pi / 12)) ** 2

# Weekly: weekdays higher, weekends lower
WEEKLY_MAP = np.array([1.0, 1.1, 1.15, 1.2, 1.05, 0.5, 0.4])
weekly = WEEKLY_MAP[dows]

# Annual: summer peak
seasonal = 1.0 + 0.3 * np.sin((doys - 80) * 2 * np.pi / 365)

# Growth trend: +40% over 2 years
trend = 1.0 + 0.4 * (idx / N_HOURS)

base = 200.0 * daily * weekly * seasonal * trend * group_mult
noise = base * (0.85 + 0.3 * np.random.random(TOTAL))

# Occasional spikes (2 % of hours)
spike = np.random.random(TOTAL) < 0.02
noise[spike] *= 1.5 + np.random.random(int(spike.sum()))

values = np.maximum(1.0, noise)

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

df = pl.DataFrame({
    "ts": ts_col,
    "hour": hours.astype(np.int32),
    "day_of_week": [DAY_NAMES[d] for d in dows],
    "dow_num": dows.astype(np.int32),
    "value": values,
    "group": group_col,
})

# ---------------------------------------------------------------------------
# Holidays — add is_holiday / holiday_name columns
# ---------------------------------------------------------------------------
HOLIDAYS = [
    # 2023
    ("New Year's Day", datetime(2023, 1, 1)),
    ("MLK Day", datetime(2023, 1, 16)),
    ("Presidents' Day", datetime(2023, 2, 20)),
    ("Easter", datetime(2023, 4, 9)),
    ("Memorial Day", datetime(2023, 5, 29)),
    ("Independence Day", datetime(2023, 7, 4)),
    ("Labor Day", datetime(2023, 9, 4)),
    ("Columbus Day", datetime(2023, 10, 9)),
    ("Veterans Day", datetime(2023, 11, 11)),
    ("Thanksgiving", datetime(2023, 11, 23)),
    ("Christmas", datetime(2023, 12, 25)),
    # 2024
    ("New Year's Day", datetime(2024, 1, 1)),
    ("MLK Day", datetime(2024, 1, 15)),
    ("Presidents' Day", datetime(2024, 2, 19)),
    ("Easter", datetime(2024, 3, 31)),
    ("Memorial Day", datetime(2024, 5, 27)),
    ("Independence Day", datetime(2024, 7, 4)),
    ("Labor Day", datetime(2024, 9, 2)),
    ("Columbus Day", datetime(2024, 10, 14)),
    ("Veterans Day", datetime(2024, 11, 11)),
    ("Thanksgiving", datetime(2024, 11, 28)),
    ("Christmas", datetime(2024, 12, 25)),
]
holiday_dates = {d.date() for _, d in HOLIDAYS}

# Add holiday columns to main df
df = df.with_columns(
    pl.col("ts").dt.date().is_in(list(holiday_dates)).alias("is_holiday"),
    pl.col("ts").dt.date().replace_strict(
        {d.date(): name for name, d in HOLIDAYS}, default=""
    ).alias("holiday_name"),
)

st.caption(f"{len(df):,} rows · {N_HOURS:,} hours × {N_GROUPS} groups · {len(HOLIDAYS)} holidays")

# ---------------------------------------------------------------------------
# Build all charts — single render call so crossfilter works across them
# ---------------------------------------------------------------------------

# Detail: hourly lines per group, zoomed by overview brush, filtered by day toggle
detail = dp.plot(
    dp.line(
        data=df,
        x="ts",
        y="value",
        stroke="group",
        selection="daysel",
        preferred_x_scale_type="time",
        lod={"decimate": True},
        fit_domain="y",
        tooltip_proximity="x",
    ),
    dp.line(
        data=df,
        x="ts",
        y=dp.window("avg", "value", order_by="ts", partition_by="group", frame=[-168, 0]),
        stroke="group",
        stroke_width=2,
        selection="daysel",
        preferred_x_scale_type="time",
        lod={"decimate": True},
        fit_domain="y",
        tooltip_proximity="x",
    ),
    height=380,
    x_label="Date",
    y_label="Energy (kWh)",
    use_selection="x",
    legend=True,
)

# Holiday strip: colored bars at holiday dates
holiday_strip = dp.plot(
    dp.rect_y(
        data=df,
        x=dp.bin("ts", steps=730),
        y=dp.count(),
        fill="holiday_name",
        selection="daysel",
        preferred_x_scale_type="time",
        tip=["holiday_name"],
        transforms=[dp.filter("is_holiday = true")],
    ),
    height=200,
    x_label="Date",
    use_selection="x",
)

# Overview: provides brush for detail zoom
overview_interactors = [dp.interval_x(selection="daysel")]
if show_comparison:
    overview_interactors.append(
        dp.derived_interval(source="daysel", selection="cmpsel", offset=comparison_offset)
    )

overview = dp.plot(
    dp.line(
        data=df,
        x="ts",
        y="value",
        stroke="group",
        selection="daysel",
        preferred_x_scale_type="time",
        lod={"decimate": True},
        tooltip_proximity="x",
        fit_domain="y",
    ),
    height=90,
    x_label="Date",
    interactors=overview_interactors,
    disable_zoom="y",
)

# Hourly profile: min/max range (area) + avg (line), per group
hourly = dp.plot(
    dp.area_y(
        data=df,
        x="hour",
        y1=dp.min_("value"),
        y2=dp.max_("value"),
        fill="group",
        fill_opacity=0.2,
        selection="daysel",
        curve="monotone",
        tooltip_proximity="x",
    ),
    dp.line(
        data=df,
        x="hour",
        y=dp.avg("value"),
        stroke="group",
        stroke_width=2,
        selection="daysel",
        curve="monotone",
        tooltip_proximity="x",
    ),
    height=340,
    x_label="Hour of Day",
    y_label="kWh",
    legend=True,
)

# Comparison hourly profile (only when comparison is enabled)
if show_comparison:
    hourly_cmp = dp.plot(
        dp.area_y(
            data=df,
            x="hour",
            y1=dp.min_("value"),
            y2=dp.max_("value"),
            fill="group",
            fill_opacity=0.2,
            selection="cmpsel",
            curve="monotone",
            tooltip_proximity="x",
        ),
        dp.line(
            data=df,
            x="hour",
            y=dp.avg("value"),
            stroke="group",
            stroke_width=2,
            selection="cmpsel",
            curve="monotone",
            tooltip_proximity="x",
        ),
        height=340,
        x_label="Hour of Day",
        y_label="kWh",
        legend=True,
    )

# Day-of-week selector: toggle bars to filter all other charts
day_selector = dp.plot(
    dp.bar_y(
        data=df,
        x="day_of_week",
        y=dp.sum("value"),
        fill="group",
        selection="daysel",
        transforms=[dp.stack_y()],
        sort={"x": "dow_num", "order": "asc"},
        fit_domain="y",
    ),
    height=340,
    x_label="Day of Week",
    y_label="Total kWh",
    interactors=[dp.toggle(field="day_of_week")],
    legend=True,
)

# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------
if show_comparison:
    bottom_row = dp.hconcat(hourly, hourly_cmp, day_selector)
else:
    bottom_row = dp.hconcat(hourly, day_selector)

dp.streamlit.render(
    dp.vconcat(detail, holiday_strip, overview, bottom_row),
    server_duckdb=USE_SERVER,
)
