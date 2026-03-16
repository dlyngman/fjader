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
    dp.vconcat(weather_dots, weather_bars),
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
    dp.vconcat(filtered_dots, bar_brush),
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
    dp.hconcat(brush_scatter, brush_bars),
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

# --- fitDomain: auto-fit y-axis to visible range ---
st.header("fitDomain (y-axis auto-fits to visible data)")

import math

ts = pl.DataFrame({
    "t": list(range(500)),
    "value": [math.sin(i / 20) * 10 + i * 0.05 for i in range(500)],
})

fit_detail = dp.plot(
    dp.line(data=ts, x="t", y="value", fit_domain="y"),
    height=300,
    x_label="Time",
    y_label="Value (auto-fit)",
    use_selection="x",
)
fit_overview = dp.plot(
    dp.line(data=ts, x="t", y="value"),
    height=100,
    x_label="Time",
    interactors=[dp.interval_x()],
)
dp.streamlit.render(dp.vconcat(fit_detail, fit_overview), server_duckdb=USE_SERVER)

# --- autoDots: density-based dot fading on area marks ---
st.header("autoDots on AreaY (dots appear when data is sparse)")

area_df = pl.DataFrame({
    "x": list(range(30)),
    "y": [abs((i - 15) ** 2) + 5 for i in range(30)],
    "group": ["A"] * 15 + ["B"] * 15,
})

dp.streamlit.render(
    dp.area_y(
        data=area_df,
        x="x",
        y="y",
        fill="group",
        auto_dots=True,
        curve="monotone",
        transforms=[dp.stack_y()],
    ),
    height=400,
    server_duckdb=USE_SERVER,
)

# --- LOD config on line marks (replaces old optimize) ---
st.header("LOD config on LineMark (decimate + smooth)")

big_line = pl.DataFrame({
    "x": list(range(5000)),
    "y": [math.sin(i / 50) * 100 + (i % 7) for i in range(5000)],
})

dp.streamlit.render(
    dp.plot(
        dp.line(
            data=big_line,
            x="x",
            y="y",
            lod={"decimate": True, "smooth": {"window": 50}},
        ),
        height=350,
        x_label="X",
        y_label="Y (LOD: decimate + smooth)",
    ),
    server_duckdb=USE_SERVER,
)

# --- Window function: rolling average as a channel value ---
st.header("Window function (rolling average)")

window_df = pl.DataFrame({
    "date": list(range(200)),
    "price": [math.sin(i / 10) * 20 + 50 + (i % 3) * 2 for i in range(200)],
})

dp.streamlit.render(
    dp.plot(
        dp.dot(data=window_df, x="date", y="price", opacity=0.3, r=2)
        * dp.line(
            data=window_df,
            x="date",
            y=dp.window("avg", "price", order_by="date", frame=[-10, 0]),
            stroke_width=2,
        ),
        height=350,
        x_label="Date",
        y_label="Price (dots = raw, line = trailing avg 10)",
    ),
    server_duckdb=USE_SERVER,
)
