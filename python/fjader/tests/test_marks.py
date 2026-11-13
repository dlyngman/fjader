"""Tests for all 10 mark types — verifies exact dict output matching TS spec."""

import fjader as fj


class TestDotMark:
    def test_basic(self):
        m = fj.dot(table="penguins", x="bill_length", y="bill_depth", fill="species")
        d = m.to_mark_dict()
        assert d == {
            "mark": "dot",
            "table": "penguins",
            "x": "bill_length",
            "y": "bill_depth",
            "fill": "species",
        }

    def test_all_props(self):
        m = fj.dot(
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
        m = fj.dot(table="t", x="species", y=fj.count())
        d = m.to_mark_dict()
        assert d["y"] == {"aggregate": "count"}

    def test_with_bin_field(self):
        m = fj.dot(table="t", x=fj.bin("bill_length", steps=30), y=fj.count())
        d = m.to_mark_dict()
        assert d["x"] == {"bin": "bill_length", "steps": 30}


class TestBarMarks:
    def test_bar_y(self):
        m = fj.bar_y(table="t", x="species", y="count()", fill="species", padding=0.1)
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
        m = fj.bar_x(table="t", x="count()", y="species", inset=1)
        d = m.to_mark_dict()
        assert d["mark"] == "barX"
        assert d["inset"] == 1

    def test_contribute_domain(self):
        # The top N background-totals layering: the faint whole ranks, the part
        # follows its axis. False is the value that matters, so it must survive.
        whole = fj.bar_y(
            table="t", x="carrier", y=fj.count(), opacity=0.2,
            selection_response="ignore", transforms=[fj.topN(4)],
        )
        part = fj.bar_y(table="t", x="carrier", y=fj.count(), contribute_domain=False)
        assert "contributeDomain" not in whole.to_mark_dict()
        assert part.to_mark_dict()["contributeDomain"] is False
        horizontal = fj.bar_x(table="t", x="n", y="c", contribute_domain=False)
        assert horizontal.to_mark_dict()["contributeDomain"] is False

    def test_bar_y_with_transforms(self):
        m = fj.bar_y(
            table="t", x="species", y="count()", fill="species",
            transforms=[fj.stack_y(), fj.topN(10)],
        )
        d = m.to_mark_dict()
        assert d["transforms"] == [
            {"transform": "stackY"},
            {"transform": "topN", "n": 10},
        ]


class TestLineMark:
    def test_basic(self):
        m = fj.line(table="t", x="date", y="value", stroke="category")
        d = m.to_mark_dict()
        assert d == {
            "mark": "line",
            "table": "t",
            "x": "date",
            "y": "value",
            "stroke": "category",
        }

    def test_with_curve_and_lod(self):
        m = fj.line(
            table="t", x="date", y="value",
            stroke_width=2, curve="monotone", lod={"decimate": "auto"},
        )
        d = m.to_mark_dict()
        assert d["strokeWidth"] == 2
        assert d["curve"] == "monotone"
        assert d["lod"] == {"decimate": "auto"}


class TestAreaMarks:
    def test_area_y(self):
        m = fj.area_y(
            table="t", x="date", y="value", fill="category",
            fill_opacity=0.5, curve="catmull-rom",
        )
        d = m.to_mark_dict()
        assert d["mark"] == "areaY"
        assert d["fillOpacity"] == 0.5
        assert d["curve"] == "catmull-rom"

    def test_area_x(self):
        m = fj.area_x(table="t", y="date", x="value", fill="category")
        d = m.to_mark_dict()
        assert d["mark"] == "areaX"


class TestRectMarks:
    def test_rect(self):
        m = fj.rect(table="t", x="a", y="b", fill="density", opacity=0.8)
        d = m.to_mark_dict()
        assert d["mark"] == "rect"
        assert d["opacity"] == 0.8

    def test_rect_x(self):
        m = fj.rect_x(table="t", x="value", fill="category", fit_domain="y")
        d = m.to_mark_dict()
        assert d["mark"] == "rectX"
        assert d["fitDomain"] == "y"

    def test_rect_y(self):
        m = fj.rect_y(table="t", y="value", fill="density", preferred_x_scale_type="log")
        d = m.to_mark_dict()
        assert d["mark"] == "rectY"
        assert d["preferredXScaleType"] == "log"


class TestTextMark:
    def test_basic(self):
        m = fj.text(
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


class TestTipProp:
    def test_tip_explicit_fields(self):
        m = fj.dot(table="t", x="a", y="b", fill="c", tip=["x", "fill", "island"])
        d = m.to_mark_dict()
        assert d["tip"] == ["x", "fill", "island"]

    def test_tip_wildcard(self):
        m = fj.dot(table="t", x="a", y="b", tip=["*", "island"])
        d = m.to_mark_dict()
        assert d["tip"] == ["*", "island"]

    def test_tip_false_disables(self):
        m = fj.dot(table="t", x="a", y="b", tip=False)
        d = m.to_mark_dict()
        assert d["tip"] is False

    def test_tip_none_excluded(self):
        m = fj.dot(table="t", x="a", y="b")
        d = m.to_mark_dict()
        assert "tip" not in d

    def test_tip_on_all_marks(self):
        """Verify tip passes through on all mark types."""
        factories = [
            lambda: fj.dot(table="t", x="a", y="b", tip=["x"]),
            lambda: fj.bar_x(table="t", x="a", y="b", tip=["x"]),
            lambda: fj.bar_y(table="t", x="a", y="b", tip=["x"]),
            lambda: fj.line(table="t", x="a", y="b", tip=["x"]),
            lambda: fj.area_y(table="t", x="a", y="b", tip=["x"]),
            lambda: fj.area_x(table="t", x="a", y="b", tip=["x"]),
            lambda: fj.rect(table="t", x="a", y="b", tip=["x"]),
            lambda: fj.rect_x(table="t", x="a", tip=["x"]),
            lambda: fj.rect_y(table="t", y="a", tip=["x"]),
            lambda: fj.text(table="t", x="a", y="b", text="c", tip=["x"]),
        ]
        for factory in factories:
            d = factory().to_mark_dict()
            assert d["tip"] == ["x"], f"tip failed on {d['mark']}"


class TestTooltipProximity:
    def test_tooltip_proximity(self):
        m = fj.dot(table="t", x="a", y="b", tooltip_proximity="x")
        d = m.to_mark_dict()
        assert d["tooltipProximity"] == "x"

    def test_tooltip_proximity_none_excluded(self):
        m = fj.dot(table="t", x="a", y="b")
        d = m.to_mark_dict()
        assert "tooltipProximity" not in d


class TestNoneStripping:
    def test_unset_props_excluded(self):
        """Only set props appear in output — no None values."""
        m = fj.dot(table="t", x="a", y="b")
        d = m.to_mark_dict()
        assert "fill" not in d
        assert "opacity" not in d
        assert "radiusRange" not in d
        assert "tip" not in d
        assert "tooltipProximity" not in d
        assert set(d.keys()) == {"mark", "table", "x", "y"}


class TestEntrance:
    def test_holds_entrance_serializes_camel_case(self):
        mark = fj.dot(table="t", x="a", y="b", holds_entrance=False)
        assert mark.to_mark_dict()["holdsEntrance"] is False

    def test_holds_entrance_omitted_by_default(self):
        assert "holdsEntrance" not in fj.bar_y(table="t", x="a", y=fj.count()).to_mark_dict()

    def test_plot_entrance(self):
        spec = fj.plot(fj.dot(table="t", x="a", y="b"), entrance="fade").to_dict()
        assert spec["plot"]["entrance"] == "fade"

    def test_opts_entrance(self):
        p = fj.plot(fj.dot(table="t", x="a", y="b")).opts(entrance="none")
        assert p.to_dict()["plot"]["entrance"] == "none"


class TestTooltipOptions:
    def test_tooltip_options_serialize_camel_case(self):
        mark = fj.dot(table="t", x="a", y="b", tooltip={"sort_table": True})
        assert mark.to_mark_dict()["tooltip"] == {"sortTable": True}
