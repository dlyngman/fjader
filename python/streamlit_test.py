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
USE_SERVER = st.toggle("Use server-side DuckDB (no WASM)", value=False)

dp.streamlit.render(overlay, height=400, server_duckdb=USE_SERVER)

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
dp.streamlit.render(dots, height=450, server_duckdb=USE_SERVER)

# --- Weather: legend toggle + bar chart (replicates Svelte weather demo) ---
st.header("Seattle Weather — Legend Toggle + Bars")

weather_dots = dp.plot(
    dp.dot(
        data=weather, x="date", y="temp_max", fill="weather",
        r="precipitation", opacity=0.7, preferred_x_scale_type="time",
        selection="sel",
    ),
    width=800, height=350,
    legend=True,
    interactors=[dp.interval_x()],
)
weather_bars = dp.plot(
    dp.bar_x(
        data=weather, x=dp.count(), y="weather", fill="weather",
        selection="sel",
    ),
    width=800, height=200,
    interactors=[dp.toggle(field="weather")],
)
dp.streamlit.render(
    dp.vconcat(weather_dots, weather_bars, params={"sel": {"select": "crossfilter"}}),
    server_duckdb=USE_SERVER,
)

# --- Simple bar from inline data ---
st.header("Simple Bar (inline data)")

simple = pl.DataFrame({
    "weather": ["sun", "rain", "fog", "snow", "drizzle"],
    "count": [640, 641, 101, 26, 53],
})
dp.streamlit.render(
    dp.bar_x(data=simple, x="count", y="weather", fill="weather"),
    height=300,
    server_duckdb=USE_SERVER,
)

# --- Crossfilter: brush dots to filter bars ---
st.header("Crossfilter (brush dots → filters bars)")

# Dots with brush interactor driving the crossfilter
filtered_dots = dp.plot(
    dp.dot(
        data=weather, x="date", y="temp_max", fill="weather",
        r="precipitation",
        opacity=0.7, preferred_x_scale_type="time",
        selection="brush",
    ),
    width=800, height=350,
    # x_label="Date", y_label="Max Temp (°F)",
    interactors=[dp.interval_x()],
)

# Bar chart filtered by the crossfilter selection
bar_brush = dp.plot(
    dp.bar_x(
        data=weather, x=dp.count(), y="weather", fill="weather",
        selection="brush",
    ),
    width=800, height=200,
    # x_label="Count", y_label="Weather",
)

dp.streamlit.render(
    dp.vconcat(filtered_dots, bar_brush, params={"brush": {"select": "crossfilter"}}),
    server_duckdb=USE_SERVER,
)

# --- 2D Brush: rectangle brush on scatter, cross-filters bar chart ---
st.header("2D Brush (rectangle brush → filters bars)")

penguins = pl.read_parquet(Path(__file__).parent / "../static/data/penguins.parquet")

brush_scatter = dp.plot(
    dp.dot(
        data=penguins, x="bill_length", y="bill_depth", fill="species",
        opacity=0.6, selection="brush2d",
    ),
    width=600, height=400,
    interactors=[dp.interval_2d()],
)
brush_bars = dp.plot(
    dp.bar_y(
        data=penguins, x="species", y=dp.count(), fill="species",
        selection="brush2d",
    ),
    width=600, height=300,
)
dp.streamlit.render(
    dp.hconcat(brush_scatter, brush_bars, params={"brush2d": {"select": "crossfilter"}}),
    server_duckdb=USE_SERVER,
)

# --- Overview + Detail (domain zoom, not crossfilter) ---
st.header("Overview + Detail (domain zoom)")
detail = dp.plot(
    dp.line(data=weather, x="date", y="temp_max"),
    height=400, x_label="Date",
    use_selection='x',
)
overview = dp.plot(
    dp.line(data=weather, x="date", y="temp_max"),
    x_label="Date", height=100,
    interactors=[dp.interval_x()],
)
dp.streamlit.render(dp.vconcat(detail, overview), server_duckdb=USE_SERVER)
