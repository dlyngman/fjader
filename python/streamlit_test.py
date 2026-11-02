"""Streamlit test app for Fjader — mirrors marimo_widget_test.py."""

from pathlib import Path

import polars as pl
import streamlit as st

import fjader as fj

st.set_page_config(layout="wide")
st.title("Fjader Streamlit Test")

# --- Simple scatter + line overlay ---
st.header("Dot + Line overlay")

df = pl.DataFrame({
    "x": range(50),
    "y": [i ** 0.5 for i in range(50)],
    "category": ["A", "B"] * 25,
})

overlay = fj.dot(data=df, x="x", y="y") * fj.line(data=df, x="x", y="y")

fj.streamlit.render(overlay, height=400)

# --- Seattle weather scatter ---
st.header("Seattle Weather — Dots")

weather = pl.read_parquet(Path(__file__).parent / "../static/data/seattle-weather.parquet")

dots = fj.plot(
    fj.dot(
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
fj.streamlit.render(dots, height=450)

# --- Weather: legend toggle + bar chart (replicates Svelte weather demo) ---
st.header("Seattle Weather — Legend Toggle + Bars")

weather_dots = fj.plot(
    fj.dot(
        data=weather, x="date", y="temp_max", fill="weather",
        r="precipitation", opacity=0.7, preferred_x_scale_type="time",
        selection="sel",
    ),
    width=800, height=350,
    legend=True,
    interactors=[fj.interval_x()],
)
weather_bars = fj.plot(
    fj.bar_x(
        data=weather, x=fj.count(), y="weather", fill="weather",
        selection="sel",
    ),
    width=800, height=200,
    interactors=[fj.toggle(field="weather")],
)
fj.streamlit.render(
    fj.vconcat(weather_dots, weather_bars),
)

# --- Explicit domain comparison ---
# Each chart in its own render context (st.columns) so they get independent
# BandScaleStates — hconcat would share one scale and the explicit domain
# would override the default order on both charts.
st.header("Explicit Domain — BarX (horizontal)")
st.markdown("Left: default order (data order). Right: explicit domain controls category order.")

simple = pl.DataFrame({
    "weather": ["sun", "rain", "fog", "snow", "drizzle"],
    "count": [640, 641, 101, 26, 53],
})

col1, col2 = st.columns(2)
with col1:
    fj.streamlit.render(
        fj.plot(
            fj.bar_x(data=simple, x="count", y="weather", selection="togX1"),
            width=450, height=250, y_label="default order",
            interactors=[fj.toggle(field="weather", selection="togX1")],
        ),
    )
with col2:
    fj.streamlit.render(
        fj.plot(
            fj.bar_x(
                data=simple, x="count", y="weather", selection="togX2",
                domain={"y": ["snow", "drizzle", "fog", "rain", "sun"]},
            ),
            width=450, height=250, y_label="explicit domain",
            interactors=[fj.toggle(field="weather", selection="togX2")],
        ),
    )

st.header("Explicit Domain — BarY (vertical)")
st.markdown("Left: default order. Right: explicit domain controls category order.")

col3, col4 = st.columns(2)
with col3:
    fj.streamlit.render(
        fj.plot(
            fj.bar_y(data=simple, x="weather", y="count", selection="togY1"),
            width=450, height=250, x_label="default order",
            interactors=[fj.toggle(field="weather", selection="togY1")],
        ),
    )
with col4:
    fj.streamlit.render(
        fj.plot(
            fj.bar_y(
                data=simple, x="weather", y="count", selection="togY2",
                domain={"x": ["snow", "drizzle", "fog", "rain", "sun"]},
            ),
            width=450, height=250, x_label="explicit domain",
            interactors=[fj.toggle(field="weather", selection="togY2")],
        ),
    )

# --- Crossfilter: brush dots to filter bars ---
st.header("Crossfilter (brush dots → filters bars)")

# Dots with brush interactor driving the crossfilter
filtered_dots = fj.plot(
    fj.dot(
        data=weather, x="date", y="temp_max", fill="weather",
        r="precipitation",
        opacity=0.7, preferred_x_scale_type="time",
        selection="brush",
    ),
    width=800, height=350,
    # x_label="Date", y_label="Max Temp (°F)",
    interactors=[fj.interval_x()],
)

# Bar chart filtered by the crossfilter selection
bar_brush = fj.plot(
    fj.bar_x(
        data=weather, x=fj.count(), y="weather", fill="weather",
        selection="brush",
    ),
    width=800, height=200,
    # x_label="Count", y_label="Weather",
)

fj.streamlit.render(
    fj.vconcat(filtered_dots, bar_brush),
)

# --- 2D Brush: rectangle brush on scatter, cross-filters bar chart ---
st.header("2D Brush (rectangle brush → filters bars)")

penguins = pl.read_parquet(Path(__file__).parent / "../static/data/penguins.parquet")

brush_scatter = fj.plot(
    fj.dot(
        data=penguins, x="bill_length", y="bill_depth", fill="species",
        opacity=0.6, selection="brush2d",
    ),
    width=600, height=400,
    interactors=[fj.interval_2d()],
)
brush_bars = fj.plot(
    fj.bar_y(
        data=penguins, x="species", y=fj.count(), fill="species",
        selection="brush2d",
        domain={"x": ["Chinstrap", "Gentoo", "Adelie"]},
    ),
    width=600, height=300,
)
fj.streamlit.render(
    fj.hconcat(brush_scatter, brush_bars),
)

# --- Overview + Detail (domain zoom, not crossfilter) ---
st.header("Overview + Detail (domain zoom)")
detail = fj.plot(
    fj.line(data=weather, x="date", y="temp_max"),
    height=400, x_label="Date",
    use_selection='x',
)
overview = fj.plot(
    fj.line(data=weather, x="date", y="temp_max"),
    x_label="Date", height=100,
    interactors=[fj.interval_x()],
)
fj.streamlit.render(fj.vconcat(detail, overview))

# --- fitDomain: auto-fit y-axis to visible range ---
st.header("fitDomain (y-axis auto-fits to visible data)")

import math

ts = pl.DataFrame({
    "t": list(range(500)),
    "value": [math.sin(i / 20) * 10 + i * 0.05 for i in range(500)],
})

fit_detail = fj.plot(
    fj.line(data=ts, x="t", y="value", fit_domain="y"),
    height=300,
    x_label="Time",
    y_label="Value (auto-fit)",
    use_selection="x",
)
fit_overview = fj.plot(
    fj.line(data=ts, x="t", y="value"),
    height=100,
    x_label="Time",
    interactors=[fj.interval_x()],
)
fj.streamlit.render(fj.vconcat(fit_detail, fit_overview))

# --- autoDots: density-based dot fading on area marks ---
st.header("autoDots on AreaY (dots appear when data is sparse)")

area_df = pl.DataFrame({
    "x": list(range(30)),
    "y": [abs((i - 15) ** 2) + 5 for i in range(30)],
    "group": ["A"] * 15 + ["B"] * 15,
})

fj.streamlit.render(
    fj.area_y(
        data=area_df,
        x="x",
        y="y",
        fill="group",
        auto_dots=True,
        curve="monotone",
        transforms=[fj.stack_y()],
    ),
    height=400,
)

# --- LOD config on line marks (replaces old optimize) ---
st.header("LOD config on LineMark (decimate + smooth)")

big_line = pl.DataFrame({
    "x": list(range(5000)),
    "y": [math.sin(i / 50) * 100 + (i % 7) for i in range(5000)],
})

fj.streamlit.render(
    fj.plot(
        fj.line(
            data=big_line,
            x="x",
            y="y",
            lod={"decimate": True, "smooth": {"window": 50}},
        ),
        height=350,
        x_label="X",
        y_label="Y (LOD: decimate + smooth)",
    ),
)

# --- Window function: rolling average as a channel value ---
st.header("Window function (rolling average)")

window_df = pl.DataFrame({
    "date": list(range(200)),
    "price": [math.sin(i / 10) * 20 + 50 + (i % 3) * 2 for i in range(200)],
})

fj.streamlit.render(
    fj.plot(
        fj.dot(data=window_df, x="date", y="price", opacity=0.3, r=2)
        * fj.line(
            data=window_df,
            x="date",
            y=fj.window("avg", "price", order_by="date", frame=[-10, 0]),
            stroke_width=2,
        ),
        height=350,
        x_label="Date",
        y_label="Price (dots = raw, line = trailing avg 10)",
    ),
)

# --- from_spec: render from a raw JSON spec (e.g. exported from the palette) ---
st.header("from_spec — render from exported palette spec")

st.subheader("Inline data via `data=` kwarg")

spec_df = pl.DataFrame({
    "species": ["Adelie", "Chinstrap", "Gentoo"],
    "count": [152, 68, 124],
})

fj.streamlit.render(
    fj.from_spec(
        {
            "marks": [{
                "mark": "barY",
                "table": "penguins_summary",
                "x": "species",
                "y": "count",
                "fill": "species",
            }],
            "height": 350,
        },
        data={"penguins_summary": spec_df},
    ),
)

st.subheader("Editable spec textarea")

default_spec = """{
  "marks": [
    {
      "mark": "dot",
      "table": "weather",
      "x": "date",
      "y": "temp_max",
      "fill": "weather",
      "opacity": 0.6
    }
  ],
  "height": 400
}"""

spec_text = st.text_area("Paste a spec (JSON)", value=default_spec, height=250)

try:
    fj.streamlit.render(
        fj.from_spec(spec_text, data={"weather": weather}),
    )
except Exception as e:
    st.error(f"Invalid spec: {e}")

st.subheader("Multi-mark overlay from spec")

fj.streamlit.render(
    fj.from_spec(
        {
            "marks": [
                {
                    "mark": "dot",
                    "table": "weather",
                    "x": "date",
                    "y": "temp_max",
                    "fill": "weather",
                    "opacity": 0.3,
                    "r": 2,
                },
                {
                    "mark": "line",
                    "table": "weather",
                    "x": "date",
                    "y": "temp_max",
                    "strokeWidth": 1,
                },
            ],
            "height": 350,
        },
        data={"weather": weather},
    ),
)
