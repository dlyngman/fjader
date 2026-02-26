"""Tests for FieldSpec helpers."""

import diveplot as dp


class TestAggregateFields:
    def test_count(self):
        assert dp.count().to_dict() == {"aggregate": "count"}

    def test_sum(self):
        assert dp.sum("revenue").to_dict() == {"aggregate": "sum", "field": "revenue"}

    def test_avg(self):
        assert dp.avg("score").to_dict() == {"aggregate": "avg", "field": "score"}

    def test_min(self):
        assert dp.min_("price").to_dict() == {"aggregate": "min", "field": "price"}

    def test_max(self):
        assert dp.max_("price").to_dict() == {"aggregate": "max", "field": "price"}

    def test_median(self):
        assert dp.median("age").to_dict() == {"aggregate": "median", "field": "age"}


class TestBinField:
    def test_bin_no_steps(self):
        assert dp.bin("bill_length").to_dict() == {"bin": "bill_length"}

    def test_bin_with_steps(self):
        assert dp.bin("bill_length", steps=30).to_dict() == {"bin": "bill_length", "steps": 30}


class TestFieldSpecSerialization:
    def test_string_passes_through(self):
        """Plain strings are serialized as-is by serialize_value."""
        from diveplot._convert import serialize_value

        assert serialize_value("bill_length") == "bill_length"
        assert serialize_value("count()") == "count()"

    def test_aggregate_serialized_via_to_dict(self):
        from diveplot._convert import serialize_value

        result = serialize_value(dp.count())
        assert result == {"aggregate": "count"}

    def test_bin_serialized_via_to_dict(self):
        from diveplot._convert import serialize_value

        result = serialize_value(dp.bin("x", steps=20))
        assert result == {"bin": "x", "steps": 20}
