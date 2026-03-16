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


class TestWindowField:
    def test_window_basic(self):
        w = dp.window("avg", "value", order_by="date", frame=[-10, 0])
        assert w.to_dict() == {
            "window": "avg",
            "field": "value",
            "orderBy": "date",
            "frame": [-10, 0],
        }

    def test_window_with_partition(self):
        w = dp.window("sum", "revenue", order_by="ts", partition_by="region", frame=[-5, 5])
        assert w.to_dict() == {
            "window": "sum",
            "field": "revenue",
            "orderBy": "ts",
            "partitionBy": "region",
            "frame": [-5, 5],
        }

    def test_window_count_no_field(self):
        w = dp.window("count", order_by="date", frame=[-3, 0])
        assert w.to_dict() == {
            "window": "count",
            "orderBy": "date",
            "frame": [-3, 0],
        }

    def test_window_minimal(self):
        """Window with only aggregate + field, no order/partition/frame."""
        w = dp.window("avg", "value")
        assert w.to_dict() == {"window": "avg", "field": "value"}

    def test_window_serialized_via_to_dict(self):
        from diveplot._convert import serialize_value

        result = serialize_value(dp.window("avg", "x", order_by="t", frame=[-10, 0]))
        assert result == {
            "window": "avg",
            "field": "x",
            "orderBy": "t",
            "frame": [-10, 0],
        }

    def test_window_in_mark(self):
        """Window field used as a channel value on a mark."""
        m = dp.line(
            table="t",
            x="date",
            y=dp.window("avg", "value", order_by="date", frame=[-10, 0]),
        )
        d = m.to_mark_dict()
        assert d["y"] == {
            "window": "avg",
            "field": "value",
            "orderBy": "date",
            "frame": [-10, 0],
        }


class TestRawSqlField:
    def test_sql_expr_basic(self):
        f = dp.sql_expr('EXTRACT(HOUR FROM "ts")')
        assert f.to_dict() == {"sql": 'EXTRACT(HOUR FROM "ts")'}

    def test_sql_expr_case(self):
        f = dp.sql_expr("CASE WHEN x > 0 THEN 'pos' ELSE 'neg' END")
        assert f.to_dict() == {"sql": "CASE WHEN x > 0 THEN 'pos' ELSE 'neg' END"}

    def test_sql_expr_in_mark(self):
        m = dp.dot(
            table="t",
            x=dp.sql_expr('EXTRACT(HOUR FROM "ts")'),
            y="value",
        )
        d = m.to_mark_dict()
        assert d["x"] == {"sql": 'EXTRACT(HOUR FROM "ts")'}

    def test_sql_expr_serialized_via_to_dict(self):
        from diveplot._convert import serialize_value

        result = serialize_value(dp.sql_expr("x + y"))
        assert result == {"sql": "x + y"}


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
