"""Streamlit test app for DivePlot — mirrors marimo_widget_test.py."""

from pathlib import Path

import polars as pl
import streamlit as st

import diveplot as dp

st.set_page_config(layout="wide")
st.title("DivePlot Streamlit Test")

# --- Simple scatter + line overlay ---
st.header("Dot + Line overlay")

df = pl.DataFrame({
    "x": range(50),
    "y": [i ** 0.5 for i in range(50)],
    "category": ["A", "B"] * 25,
})

overlay = dp.dot(data=df, x="x", y="y") * dp.line(data=df, x="x", y="y")
dp.streamlit.render(overlay, height=400)

# --- Seattle weather scatter ---
st.header("Seattle Weather — Dots")

weather = pl.read_parquet(Path(__file__).parent / "../static/data/seattle-weather.parquet")

dots = dp.plot(
    dp.dot(
        data=weather,
        x="date",
        y="temp_max",
        fill="weather",
        r="precipitation",
        radius_range=[2, 12],
        opacity=0.7,
        preferred_x_scale_type="time",
    ),
    width=800,
    height=400,
    x_label="Date",
    y_label="Max Temperature (°F)",
)
dp.streamlit.render(dots, height=450)

# --- Bar chart ---
st.header("Seattle Weather — Bars")

bars = dp.plot(
    dp.bar_x(
        data=weather,
        x=dp.count(),
        y="weather",
        fill="weather",
    ),
    width=800,
    height=300,
    x_label="Count",
    y_label="Weather",
)
dp.streamlit.render(bars, height=350)

# --- Simple bar from inline data ---
st.header("Simple Bar (inline data)")

simple = pl.DataFrame({
    "weather": ["sun", "rain", "fog", "snow", "drizzle"],
    "count": [640, 641, 101, 26, 53],
})
dp.streamlit.render(
    dp.bar_x(data=simple, x="count", y="weather", fill="weather"),
    height=300,
)

# --- Overview + Detail (vconcat with linked selection) ---
st.header("Overview + Detail")
# Detail: follows the brush selection from the overview
detail = dp.plot(
    dp.line(data=weather, x="date", y="temp_max"),
    height=300,
    x_label="Date",
    # y_label="Max Temp (°F)",
    use_x_selection=True,
)

# Overview: smaller chart with an interval brush
overview = dp.plot(
    dp.line(data=weather, x="date", y="temp_max"),
    x_label="Date",
    height=100,
    # margin={"top": 10, "bottom": 30, "right": 50, "left": 75},
    interactors=[dp.interval_x()]
)

dp.streamlit.render(dp.vconcat(detail, overview))