"""Tests for all 10 mark types — verifies exact dict output matching TS spec."""

import diveplot as dp


class TestDotMark:
    def test_basic(self):
        m = dp.dot(table="penguins", x="bill_length", y="bill_depth", fill="species")
        d = m.to_mark_dict()
        assert d == {
            "mark": "dot",
            "table": "penguins",
            "x": "bill_length",
            "y": "bill_depth",
            "fill": "species",
        }

    def test_all_props(self):
        m = dp.dot(
            table="t", x="a", y="b", fill="c",
            opacity=0.5, r=4, radius_range=[2, 12],
            preferred_x_scale_type="log",
            tooltip=True,
        )
        d = m.to_mark_dict()
        assert d["mark"] == "dot"
        assert d["radiusRange"] == [2, 12]
        assert d["preferredXScaleType"] == "log"
        assert d["opacity"] == 0.5
        assert d["r"] == 4
        assert d["tooltip"] is True

    def test_with_aggregate_field(self):
        m = dp.dot(table="t", x="species", y=dp.count())
        d = m.to_mark_dict()
        assert d["y"] == {"aggregate": "count"}

    def test_with_bin_field(self):
        m = dp.dot(table="t", x=dp.bin("bill_length", steps=30), y=dp.count())
        d = m.to_mark_dict()
        assert d["x"] == {"bin": "bill_length", "steps": 30}


class TestBarMarks:
    def test_bar_y(self):
        m = dp.bar_y(table="t", x="species", y="count()", fill="species", padding=0.1)
        d = m.to_mark_dict()
        assert d == {
            "mark": "barY",
            "table": "t",
            "x": "species",
            "y": "count()",
            "fill": "species",
            "padding": 0.1,
        }

    def test_bar_x(self):
        m = dp.bar_x(table="t", x="count()", y="species", inset=1)
        d = m.to_mark_dict()
        assert d["mark"] == "barX"
        assert d["inset"] == 1

    def test_bar_y_with_transforms(self):
        m = dp.bar_y(
            table="t", x="species", y="count()", fill="species",
            transforms=[dp.stack_y(), dp.topN(10)],
        )
        d = m.to_mark_dict()
        assert d["transforms"] == [
            {"transform": "stackY"},
            {"transform": "topN", "n": 10},
        ]


class TestLineMark:
    def test_basic(self):
        m = dp.line(table="t", x="date", y="value", stroke="category")
        d = m.to_mark_dict()
        assert d == {
            "mark": "line",
            "table": "t",
            "x": "date",
            "y": "value",
            "stroke": "category",
        }

    def test_with_curve_and_optimize(self):
        m = dp.line(
            table="t", x="date", y="value",
            stroke_width=2, curve="monotone", optimize="auto",
        )
        d = m.to_mark_dict()
        assert d["strokeWidth"] == 2
        assert d["curve"] == "monotone"
        assert d["optimize"] == "auto"


class TestAreaMarks:
    def test_area_y(self):
        m = dp.area_y(
            table="t", x="date", y="value", fill="category",
            fill_opacity=0.5, curve="catmull-rom",
        )
        d = m.to_mark_dict()
        assert d["mark"] == "areaY"
        assert d["fillOpacity"] == 0.5
        assert d["curve"] == "catmull-rom"

    def test_area_x(self):
        m = dp.area_x(table="t", y="date", x="value", fill="category")
        d = m.to_mark_dict()
        assert d["mark"] == "areaX"


class TestRectMarks:
    def test_rect(self):
        m = dp.rect(table="t", x="a", y="b", fill="density", opacity=0.8)
        d = m.to_mark_dict()
        assert d["mark"] == "rect"
        assert d["opacity"] == 0.8

    def test_rect_x(self):
        m = dp.rect_x(table="t", x="value", fill="category", viewport_local_domain=True)
        d = m.to_mark_dict()
        assert d["mark"] == "rectX"
        assert d["viewportLocalDomain"] is True

    def test_rect_y(self):
        m = dp.rect_y(table="t", y="value", fill="density", preferred_x_scale_type="log")
        d = m.to_mark_dict()
        assert d["mark"] == "rectY"
        assert d["preferredXScaleType"] == "log"


class TestTextMark:
    def test_basic(self):
        m = dp.text(
            table="t", x="a", y="b", text="label",
            font_size=12, text_anchor="middle",
        )
        d = m.to_mark_dict()
        assert d == {
            "mark": "text",
            "table": "t",
            "x": "a",
            "y": "b",
            "text": "label",
            "fontSize": 12,
            "textAnchor": "middle",
        }


class TestNoneStripping:
    def test_unset_props_excluded(self):
        """Only set props appear in output — no None values."""
        m = dp.dot(table="t", x="a", y="b")
        d = m.to_mark_dict()
        assert "fill" not in d
        assert "opacity" not in d
        assert "radiusRange" not in d
        assert set(d.keys()) == {"mark", "table", "x", "y"}
