"""Tests for all 8 transform types."""

import fjader as fj


class TestSqlTransforms:
    def test_filter(self):
        t = fj.filter(fj.sql("species = 'Adelie'"))
        assert t.to_dict() == {"transform": "filter", "condition": "species = 'Adelie'"}

    def test_having(self):
        t = fj.having(fj.sql("count(*) > 10"))
        assert t.to_dict() == {"transform": "having", "condition": "count(*) > 10"}

    def test_limit(self):
        t = fj.limit(1000)
        assert t.to_dict() == {"transform": "limit", "value": 1000}

    def test_orderby_single(self):
        t = fj.orderby("date DESC")
        assert t.to_dict() == {"transform": "orderby", "fields": ["date DESC"]}

    def test_orderby_multiple(self):
        t = fj.orderby("date DESC", "name ASC")
        assert t.to_dict() == {"transform": "orderby", "fields": ["date DESC", "name ASC"]}


class TestJsTransforms:
    def test_topN_basic(self):
        t = fj.topN(10)
        assert t.to_dict() == {"transform": "topN", "n": 10}

    def test_topN_with_options(self):
        t = fj.topN(10, by="count", include_others=True)
        assert t.to_dict() == {
            "transform": "topN",
            "n": 10,
            "by": "count",
            "includeOthers": True,
        }

    def test_stack_y_default(self):
        t = fj.stack_y()
        assert t.to_dict() == {"transform": "stackY"}

    def test_stack_y_expand(self):
        t = fj.stack_y(offset="expand")
        assert t.to_dict() == {"transform": "stackY", "offset": "expand"}

    def test_stack_x(self):
        t = fj.stack_x(offset="center")
        assert t.to_dict() == {"transform": "stackX", "offset": "center"}

    def test_normalize(self):
        t = fj.normalize()
        assert t.to_dict() == {"transform": "normalize"}

    def test_dodge_default(self):
        t = fj.dodge()
        assert t.to_dict() == {"transform": "dodge"}

    def test_dodge_with_bandwidth(self):
        t = fj.dodge(bandwidth=20)
        assert t.to_dict() == {"transform": "dodge", "bandwidth": 20}
