"""Tests for fj.from_spec() — rendering from raw JSON specs."""

import json

import pytest

import fjader as fj


def _frame(data):
    """A polars DataFrame if polars is installed, else pandas; skip without either."""
    try:
        import polars as pl

        return pl.DataFrame(data)
    except ImportError:
        pass
    try:
        import pandas as pd

        return pd.DataFrame(data)
    except ImportError:
        pytest.skip("needs polars or pandas")


class TestFromSpecBasic:
    def test_bare_plot_spec_wrapped(self):
        """A bare PlotSpec (no 'plot' key) gets wrapped automatically."""
        chart = fj.from_spec({
            "marks": [{"mark": "dot", "table": "t", "x": "a", "y": "b"}]
        })
        spec = chart.to_dict()
        assert "plot" in spec
        assert spec["plot"]["marks"][0]["mark"] == "dot"

    def test_full_spec_passthrough(self):
        """A full FjaderSpec passes through unchanged."""
        original = {
            "plot": {
                "marks": [{"mark": "barY", "table": "t", "x": "x", "y": "count()"}],
                "width": 600,
            }
        }
        chart = fj.from_spec(original)
        spec = chart.to_dict()
        assert spec["plot"]["width"] == 600
        assert spec["plot"]["marks"][0]["mark"] == "barY"

    def test_hconcat_passthrough(self):
        """hconcat specs pass through without wrapping."""
        original = {
            "hconcat": [
                {"marks": [{"mark": "dot", "table": "t", "x": "a", "y": "b"}]},
                {"marks": [{"mark": "line", "table": "t", "x": "a", "y": "b"}]},
            ]
        }
        chart = fj.from_spec(original)
        spec = chart.to_dict()
        assert "hconcat" in spec
        assert len(spec["hconcat"]) == 2

    def test_vconcat_passthrough(self):
        """vconcat specs pass through without wrapping."""
        original = {
            "vconcat": [
                {"marks": [{"mark": "dot", "table": "t", "x": "a", "y": "b"}]},
            ]
        }
        chart = fj.from_spec(original)
        assert "vconcat" in chart.to_dict()

    def test_json_string_input(self):
        """Accepts a JSON string instead of a dict."""
        raw = json.dumps({
            "marks": [{"mark": "dot", "table": "t", "x": "a", "y": "b"}]
        })
        chart = fj.from_spec(raw)
        spec = chart.to_dict()
        assert "plot" in spec
        assert spec["plot"]["marks"][0]["x"] == "a"

    def test_to_json(self):
        """to_json produces valid JSON."""
        chart = fj.from_spec({
            "marks": [{"mark": "dot", "table": "t", "x": "a", "y": "b"}]
        })
        result = json.loads(chart.to_json())
        assert "plot" in result


class TestFromSpecWithData:
    def test_dataframe_table_rewriting(self):
        """DataFrames get hashed names and mark table refs are rewritten."""
        pytest.importorskip("pyarrow")

        df = _frame({"x": [1, 2, 3], "y": [4, 5, 6]})

        chart = fj.from_spec(
            {"marks": [{"mark": "dot", "table": "mydata", "x": "x", "y": "y"}]},
            data={"mydata": df},
        )
        spec = chart.to_dict()
        # Table ref should be rewritten to hashed name
        table_name = spec["plot"]["marks"][0]["table"]
        assert table_name.startswith("_df_")
        assert table_name != "mydata"

    def test_to_full_spec_returns_dataframes(self):
        """_to_full_spec returns the dataframes dict for widget serialization."""
        pytest.importorskip("pyarrow")

        df = _frame({"a": [1]})

        chart = fj.from_spec(
            {"marks": [{"mark": "dot", "table": "t", "x": "a", "y": "a"}]},
            data={"t": df},
        )
        spec_dict, dataframes = chart._to_full_spec()
        assert len(dataframes) == 1
        # The key should be the hashed name
        key = next(iter(dataframes))
        assert key.startswith("_df_")

    def test_no_data_empty_dataframes(self):
        """Without data kwarg, dataframes dict is empty."""
        chart = fj.from_spec({
            "marks": [{"mark": "dot", "table": "t", "x": "a", "y": "b"}]
        })
        _, dataframes = chart._to_full_spec()
        assert dataframes == {}

    def test_file_data_in_spec_preserved(self):
        """File-based data sources in spec.data are preserved as-is."""
        chart = fj.from_spec({
            "data": {"flights": {"url": "flights.parquet", "type": "parquet"}},
            "plot": {
                "marks": [{"mark": "barY", "table": "flights", "x": "carrier", "y": "count()"}]
            }
        })
        spec = chart.to_dict()
        assert spec["data"]["flights"]["url"] == "flights.parquet"
        # Table ref unchanged since no DataFrame was provided for "flights"
        assert spec["plot"]["marks"][0]["table"] == "flights"


class TestFromSpecDisplayProtocol:
    def test_implements_displayable(self):
        """SpecPlot satisfies the Displayable protocol."""
        from fjader._display import Displayable

        chart = fj.from_spec({"marks": [{"mark": "dot", "table": "t", "x": "a", "y": "b"}]})
        assert isinstance(chart, Displayable)
