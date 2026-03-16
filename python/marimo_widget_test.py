# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "anywidget>=0.9.21",
#     "diveplot",
#     "marimo>=0.19.10",
#     "polars>=1.38.1",
#     "pyzmq>=27.1.0",
# ]
#
# [tool.uv.sources]
# diveplot = { path = "." }
# ///

import marimo

__generated_with = "0.20.4"
app = marimo.App(width="full")


@app.cell
def _():
    import marimo as mo
    from pathlib import Path
    import polars as pl
    # import diveplot as dp
    import diveplot.polars as dp
    # mo.md("# DivePlot anywidget Test")
    return Path, dp, pl


@app.cell
def _(pl):
    # import pandas as pd


    df = pl.DataFrame({
        "x": range(50),
        "y": [i ** 0.5 for i in range(50)],
        "category": ["A", "B"] * 25,
    })

    df.dp.dot(x="x", y="y") * df.dp.line(x="x", y="y")
    # dp.show(dp.dot(data=df, x="x", y="y", fill="category", opacity=1))
    return


@app.cell
def _():
    # df.dp.dot(x='x', y='y')                                    # auto-displays
    # df.dp.dot(x='a', y='b') * df.dp.line(x='a', y='b')        # overlay
    # df.dp.dot(x='a', y='b') + df.dp.bar_y(x='c', y=dp.count()) # layout
    # df.dp.dot(x='a', y='b').opts(width=800)                     # config
    return


@app.cell
def _(Path, dp, pl):
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
        # width=800,
        height=400,
        x_label="Date",
        y_label="Max Temperature (°F)",
    )

    bars = dp.plot(
        dp.bar_x(
            data=weather,
            x=dp.count(),
            y="weather",
            fill="weather",
        ),
        # width=800,
        height=300,
        x_label="Count",
        y_label="weather",
    )
    dp.show(dp.vconcat(dots, bars))
    return (bars,)


@app.cell
def _(bars, dp):
    dp.show(bars)
    return


@app.cell
def _(dp, pl):
    simple = pl.DataFrame({
        "weather": ["sun", "rain", "fog", "snow", "drizzle"],
        "count": [640, 641, 101, 26, 53],
    })
    dp.show(dp.bar_x(data=simple, x="count", y="weather", fill="weather"))
    return


@app.cell
def _(dp, pl):
    # --- fitDomain: auto-fit y-axis to visible data in overview+detail ---
    import math

    ts = pl.DataFrame({
        "t": list(range(500)),
        "value": [math.sin(i / 20) * 10 + i * 0.05 for i in range(500)],
    })

    detail = dp.plot(
        dp.line(data=ts, x="t", y="value", fit_domain="y"),
        height=300,
        x_label="Time",
        y_label="Value (auto-fit)",
        use_selection="x",
    )
    overview = dp.plot(
        dp.line(data=ts, x="t", y="value"),
        height=100,
        x_label="Time",
        interactors=[dp.interval_x()],
    )
    dp.show(dp.vconcat(detail, overview))
    return


@app.cell
def _(dp, pl):
    # --- autoDots: density-based dot fading on area marks ---
    area_df = pl.DataFrame({
        "x": list(range(30)),
        "y": [abs((i - 15) ** 2) + 5 for i in range(30)],
        "group": ["A"] * 15 + ["B"] * 15,
    })

    dp.show(dp.area_y(
        data=area_df,
        x="x",
        y="y",
        fill="group",
        auto_dots=True,
        curve="monotone",
        transforms=[dp.stack_y()],
    ))
    return


@app.cell
def _(dp, pl):
    # --- LOD config on line marks (replaces old optimize) ---
    import math as _math

    big_line = pl.DataFrame({
        "x": list(range(5000)),
        "y": [_math.sin(i / 50) * 100 + (i % 7) for i in range(5000)],
    })

    dp.show(dp.plot(
        dp.line(
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
def _(dp, pl):
    # --- Window function: rolling average as a channel value ---
    import math as _m

    window_df = pl.DataFrame({
        "date": list(range(200)),
        "price": [50 + _m.sin(i / 10) * 20 + (i % 3) * 2 for i in range(200)],
    })

    dp.show(dp.plot(
        dp.dot(data=window_df, x="date", y="price", opacity=0.3, r=2)
        * dp.line(
            data=window_df,
            x="date",
            y=dp.window("avg", "price", order_by="date", frame=[-50, 0]),
            stroke_width=2,
        ),
        height=350,
        x_label="Date",
        y_label="Price (dots = raw, line = trailing avg 10)",
    ))
    return


@app.cell
def _():
    return


if __name__ == "__main__":
    app.run()
