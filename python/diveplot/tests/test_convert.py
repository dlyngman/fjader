"""Tests for snake_case → camelCase conversion and serialization."""

from diveplot._convert import clean_dict, serialize_value, to_camel_case


class TestToCamelCase:
    def test_single_word(self):
        assert to_camel_case("width") == "width"

    def test_single_letter(self):
        assert to_camel_case("x") == "x"

    def test_two_words(self):
        assert to_camel_case("stroke_width") == "strokeWidth"

    def test_three_words(self):
        assert to_camel_case("fill_opacity") == "fillOpacity"

    def test_abbreviation_in_middle(self):
        assert to_camel_case("preferred_x_scale_type") == "preferredXScaleType"

    def test_radius_range(self):
        assert to_camel_case("radius_range") == "radiusRange"

    def test_include_others(self):
        assert to_camel_case("include_others") == "includeOthers"

    def test_filter_nulls(self):
        assert to_camel_case("filter_nulls") == "filterNulls"

    def test_viewport_local_domain(self):
        assert to_camel_case("viewport_local_domain") == "viewportLocalDomain"


class TestSerializeValue:
    def test_primitives(self):
        assert serialize_value("hello") == "hello"
        assert serialize_value(42) == 42
        assert serialize_value(3.14) == 3.14
        assert serialize_value(True) is True
        assert serialize_value(None) is None

    def test_list(self):
        assert serialize_value([1, 2, 3]) == [1, 2, 3]

    def test_tuple(self):
        assert serialize_value((2, 12)) == [2, 12]

    def test_dict_converts_keys(self):
        result = serialize_value({"stroke_width": 2, "fill_opacity": 0.5})
        assert result == {"strokeWidth": 2, "fillOpacity": 0.5}

    def test_object_with_to_dict(self):
        class Fake:
            def to_dict(self):
                return {"key": "val"}

        assert serialize_value(Fake()) == {"key": "val"}


class TestCleanDict:
    def test_removes_none(self):
        assert clean_dict({"a": 1, "b": None, "c": "x"}) == {"a": 1, "c": "x"}

    def test_keeps_falsy_non_none(self):
        assert clean_dict({"a": 0, "b": False, "c": ""}) == {"a": 0, "b": False, "c": ""}

    def test_empty(self):
        assert clean_dict({}) == {}
