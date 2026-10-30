"""Tests for * (overlay) and + (layout) composition operators."""

import fjader as fj


class TestOverlay:
    def test_two_marks(self):
        overlay = fj.dot(table="t", x="a", y="b") * fj.line(table="t", x="a", y="b")
        spec = overlay.to_dict()
        assert len(spec["plot"]["marks"]) == 2
        assert spec["plot"]["marks"][0]["mark"] == "dot"
        assert spec["plot"]["marks"][1]["mark"] == "line"

    def test_three_marks(self):
        overlay = (
            fj.dot(table="t", x="a", y="b")
            * fj.line(table="t", x="a", y="b")
            * fj.text(table="t", x="a", y="b", text="label")
        )
        spec = overlay.to_dict()
        assert len(spec["plot"]["marks"]) == 3

    def test_overlay_with_opts(self):
        chart = (
            fj.dot(table="t", x="a", y="b") * fj.line(table="t", x="a", y="b")
        ).opts(width=800, x_label="X")
        spec = chart.to_dict()
        assert spec["plot"]["width"] == 800
        assert spec["plot"]["xLabel"] == "X"
        assert len(spec["plot"]["marks"]) == 2


class TestHConcat:
    def test_two_marks(self):
        layout = fj.dot(table="t", x="a", y="b") + fj.bar_y(table="t", x="s", y="count()")
        spec = layout.to_dict()
        assert "hconcat" in spec
        assert len(spec["hconcat"]) == 2
        assert spec["hconcat"][0]["marks"][0]["mark"] == "dot"
        assert spec["hconcat"][1]["marks"][0]["mark"] == "barY"

    def test_three_way(self):
        layout = (
            fj.dot(table="t", x="a", y="b")
            + fj.line(table="t", x="a", y="b")
            + fj.bar_y(table="t", x="s", y="c")
        )
        spec = layout.to_dict()
        assert len(spec["hconcat"]) == 3

    def test_hconcat_function(self):
        layout = fj.hconcat(
            fj.dot(table="t", x="a", y="b"),
            fj.bar_y(table="t", x="s", y="c"),
        )
        spec = layout.to_dict()
        assert len(spec["hconcat"]) == 2


class TestVConcat:
    def test_vconcat_function(self):
        layout = fj.vconcat(
            fj.dot(table="t", x="a", y="b"),
            fj.bar_y(table="t", x="s", y="c"),
        )
        spec = layout.to_dict()
        assert "vconcat" in spec
        assert len(spec["vconcat"]) == 2


class TestMixedComposition:
    def test_overlay_plus_mark(self):
        """Overlay on left + single mark on right = hconcat."""
        layout = (
            fj.dot(table="t", x="a", y="b") * fj.line(table="t", x="a", y="b")
        ) + fj.bar_y(table="t", x="s", y="c")
        spec = layout.to_dict()
        assert "hconcat" in spec
        assert len(spec["hconcat"]) == 2
        # Left chart has 2 marks (overlay)
        assert len(spec["hconcat"][0]["marks"]) == 2
        # Right chart has 1 mark
        assert len(spec["hconcat"][1]["marks"]) == 1


class TestPlotComposition:
    def test_plot_mul_mark(self):
        """Plot * mark merges the mark into the plot."""
        p = fj.plot(fj.dot(table="t", x="a", y="b"), width=600)
        merged = p * fj.line(table="t", x="a", y="b")
        spec = merged.to_dict()
        assert len(spec["plot"]["marks"]) == 2
        assert spec["plot"]["width"] == 600

    def test_plot_add_plot(self):
        p1 = fj.plot(fj.dot(table="t", x="a", y="b"), width=400)
        p2 = fj.plot(fj.bar_y(table="t", x="s", y="c"), width=400)
        layout = p1 + p2
        spec = layout.to_dict()
        assert "hconcat" in spec
        assert len(spec["hconcat"]) == 2
