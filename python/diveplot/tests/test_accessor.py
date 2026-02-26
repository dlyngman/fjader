"""Tests for the .dp DataFrame accessor."""

import pytest

import diveplot as dp


class TestAccessorPolars:
    @pytest.fixture()
    def df(self):
        pl = pytest.importorskip("polars")
        import diveplot.polars  # noqa: F401 — registers accessor

        return pl.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6], "c": ["x", "y", "z"]})

    def test_returns_widget(self, df):
        pytest.importorskip("anywidget")
        w = df.dp.dot(x="a", y="b", fill="c")
        from diveplot._widget import DivePlotWidget

        assert isinstance(w, DivePlotWidget)

    def test_widget_has_source(self, df):
        pytest.importorskip("anywidget")
        w = df.dp.dot(x="a", y="b")
        assert w._source is not None

    def test_all_mark_types(self, df):
        pytest.importorskip("anywidget")
        from diveplot._widget import DivePlotWidget

        for method in ("dot", "bar_x", "bar_y", "line", "area_y", "area_x",
                        "rect", "rect_x", "rect_y", "text"):
            kwargs = {"x": "a", "y": "b"}
            if method == "text":
                kwargs["text"] = "c"
            w = getattr(df.dp, method)(**kwargs)
            assert isinstance(w, DivePlotWidget), f"{method} didn't return widget"

    def test_rejects_data_kwarg(self, df):
        pytest.importorskip("anywidget")
        with pytest.raises(TypeError, match="Cannot pass 'data'"):
            df.dp.dot(data=df, x="a", y="b")

    def test_rejects_table_kwarg(self, df):
        pytest.importorskip("anywidget")
        with pytest.raises(TypeError, match="Cannot pass 'table'"):
            df.dp.dot(table="foo", x="a", y="b")

    def test_composition_overlay(self, df):
        pytest.importorskip("anywidget")
        from diveplot._widget import DivePlotWidget

        w = df.dp.dot(x="a", y="b") * df.dp.line(x="a", y="b")
        assert isinstance(w, DivePlotWidget)

    def test_composition_layout(self, df):
        pytest.importorskip("anywidget")
        from diveplot._widget import DivePlotWidget

        w = df.dp.dot(x="a", y="b") + df.dp.bar_y(x="c", y=dp.count())
        assert isinstance(w, DivePlotWidget)

    def test_opts(self, df):
        pytest.importorskip("anywidget")
        from diveplot._widget import DivePlotWidget

        w = df.dp.dot(x="a", y="b").opts(width=800)
        assert isinstance(w, DivePlotWidget)

    def test_same_df_deduplicates(self, df):
        """Two accessor calls on the same df share the same table name."""
        pytest.importorskip("anywidget")
        w1 = df.dp.dot(x="a", y="b")
        w2 = df.dp.line(x="a", y="b")
        assert w1._source.table == w2._source.table


class TestAccessorPandas:
    @pytest.fixture()
    def df(self):
        pd = pytest.importorskip("pandas")
        pytest.importorskip("pyarrow")
        import diveplot.pandas  # noqa: F401 — registers accessor

        return pd.DataFrame({"a": [1, 2, 3], "b": [4, 5, 6], "c": ["x", "y", "z"]})

    def test_returns_widget(self, df):
        pytest.importorskip("anywidget")
        from diveplot._widget import DivePlotWidget

        w = df.dp.dot(x="a", y="b", fill="c")
        assert isinstance(w, DivePlotWidget)

    def test_rejects_data_kwarg(self, df):
        pytest.importorskip("anywidget")
        with pytest.raises(TypeError, match="Cannot pass 'data'"):
            df.dp.dot(data=df, x="a", y="b")

    def test_composition(self, df):
        pytest.importorskip("anywidget")
        from diveplot._widget import DivePlotWidget

        w = df.dp.dot(x="a", y="b") * df.dp.line(x="a", y="b")
        assert isinstance(w, DivePlotWidget)
