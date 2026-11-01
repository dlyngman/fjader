# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "anywidget>=0.9.21",
#     "fjader",
#     "marimo>=0.20.2",
#     "polars>=1.38.1",
#     "pyzmq>=27.1.0",
# ]
#
# [tool.uv.sources]
# fjader = { path = "." }
# ///

import marimo

__generated_with = "0.20.4"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    from pathlib import Path
    import polars as pl
    # import fjader as fj
    import fjader.polars as fj
    # mo.md("# Fjader anywidget Test")
    return Path, fj, pl


@app.cell
def _(pl):
    # import pandas as pd


    df = pl.DataFrame({
        "x": range(50),
        "y": [i ** 0.5 for i in range(50)],
        "category": ["A", "B"] * 25,
    })

    df.fj.dot(x="x", y="y") * df.fj.line(x="x", y="y")
    # fj.show(fj.dot(data=df, x="x", y="y", fill="category", opacity=1))
    return


@app.cell
def _():
    # df.fj.dot(x='x', y='y')                                    # auto-displays
    # df.fj.dot(x='a', y='b') * df.fj.line(x='a', y='b')        # overlay
    # df.fj.dot(x='a', y='b') + df.fj.bar_y(x='c', y=fj.count()) # layout
    # df.fj.dot(x='a', y='b').opts(width=800)                     # config
    return


@app.cell
def _(Path, fj, pl):
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
        # width=800,
        height=400,
        x_label="Date",
        y_label="Max Temperature (°F)",
    )

    bars = fj.plot(
        fj.bar_x(
            data=weather,
            x=fj.count(),
            y="weather",
            fill="weather",
        ),
        # width=800,
        height=300,
        x_label="Count",
        y_label="weather",
    )
    fj.show(fj.vconcat(dots, bars))
    return bars, weather


@app.cell
def _(bars, fj):
    fj.show(bars)
    return


@app.cell
def _(fj, pl):
    simple = pl.DataFrame({
        "weather": ["sun", "rain", "fog", "snow", "drizzle"],
        "count": [640, 641, 101, 26, 53],
    })
    fj.show(fj.bar_x(data=simple, x="count", y="weather", fill="weather"))
    return


@app.cell
def _(fj, pl):
    # --- fitDomain: auto-fit y-axis to visible data in overview+detail ---
    import math

    ts = pl.DataFrame({
        "t": list(range(500)),
        "value": [math.sin(i / 20) * 10 + i * 0.05 for i in range(500)],
    })

    detail = fj.plot(
        fj.line(data=ts, x="t", y="value", fit_domain="y"),
        height=300,
        x_label="Time",
        y_label="Value (auto-fit)",
        use_selection="x",
    )
    overview = fj.plot(
        fj.line(data=ts, x="t", y="value"),
        height=100,
        x_label="Time",
        interactors=[fj.interval_x()],
    )
    fj.show(fj.vconcat(detail, overview))
    return


@app.cell
def _(fj, pl):
    # --- autoDots: density-based dot fading on area marks ---
    area_df = pl.DataFrame({
        "x": list(range(30)),
        "y": [abs((i - 15) ** 2) + 5 for i in range(30)],
        "group": ["A"] * 15 + ["B"] * 15,
    })

    fj.show(fj.area_y(
        data=area_df,
        x="x",
        y="y",
        fill="group",
        auto_dots=True,
        curve="monotone",
        transforms=[fj.stack_y()],
    ))
    return


@app.cell
def _(fj, pl):
    # --- LOD config on line marks (replaces old optimize) ---
    import math as _math

    big_line = pl.DataFrame({
        "x": list(range(5000)),
        "y": [_math.sin(i / 50) * 100 + (i % 7) for i in range(5000)],
    })

    fj.show(fj.plot(
        fj.line(
            data=big_line,
            x="x",
            y="y",
            lod={"decimate": True, "smooth": {"window": 50}},
        ),
        height=350,
        x_label="X",
        y_label="Y (LOD: decimate + smooth)",
    ))
    return


@app.cell
def _(fj, pl):
    # --- Window function: rolling average as a channel value ---
    import math as _m

    window_df = pl.DataFrame({
        "date": list(range(200)),
        "price": [50 + _m.sin(i / 10) * 20 + (i % 3) * 2 for i in range(200)],
    })

    fj.show(fj.plot(
        fj.dot(data=window_df, x="date", y="price", opacity=0.3, r=2)
        * fj.line(
            data=window_df,
            x="date",
            y=fj.window("avg", "price", order_by="date", frame=[-50, 0]),
            stroke_width=2,
        ),
        height=350,
        x_label="Date",
        y_label="Price (dots = raw, line = trailing avg 10)",
    ))
    return


@app.cell
def _(fj, pl):
    # --- from_spec: render a chart from a raw JSON spec ---
    # This is how you'd render a spec exported from the palette (Cmd+E)

    spec_df = pl.DataFrame({
        "species": ["Adelie", "Chinstrap", "Gentoo"],
        "count": [152, 68, 124],
    })

    fj.show(fj.from_spec(
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
    ))
    return


@app.cell
def _(fj, weather):
    # --- from_spec: render from exported palette spec ---
    fj.show(fj.from_spec(
        {
            "marks": [
                {
                    "mark": "dot",
                    "table": "weather",
                    "x": "date",
                    "y": "temp_max",
                    "fill": "weather",
                    "opacity": 0.7,
                    "r": "precipitation",
                    "preferredXScaleType": "time",
                },
            ],
            "height": 350,
        },
        data={"weather": weather},
    ))
    return


@app.cell
def _(fj, pl):
    # --- from_spec: JSON string input (works on first load) ---
    import json

    spec_json = json.dumps({
        "marks": [{
            "mark": "dot",
            "table": "t",
            "x": "x",
            "y": "y",
            "fill": "cat",
            "opacity": 0.8,
        }],
        "height": 300,
    })

    tiny = pl.DataFrame({
        "x": list(range(100)),
        "y": [i ** 0.5 * 3 for i in range(100)],
        "cat": ["A", "B", "C", "D"] * 25,
    })

    fj.show(fj.from_spec(spec_json, data={"t": tiny}))
    return


@app.cell
def _():
    return


@app.cell
def _():
    return


@app.cell
def _():
    return


if __name__ == "__main__":
    app.run()
