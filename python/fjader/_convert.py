"""snake_case to camelCase conversion and serialization helpers."""

from __future__ import annotations

from typing import Any


def to_camel_case(name: str) -> str:
    """Convert snake_case to camelCase.

    stroke_width -> strokeWidth
    fill_opacity -> fillOpacity
    preferred_x_scale_type -> preferredXScaleType
    """
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def serialize_value(value: Any) -> Any:
    """Recursively serialize a value for JSON output."""
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [serialize_value(v) for v in value]
    if isinstance(value, dict):
        return {to_camel_case(k): serialize_value(v) for k, v in value.items()}
    if hasattr(value, "to_dict"):
        return value.to_dict()
    raise TypeError(f"Cannot serialize {type(value).__name__}: {value!r}")


def clean_dict(d: dict[str, Any]) -> dict[str, Any]:
    """Remove keys whose values are None (unset optional props)."""
    return {k: v for k, v in d.items() if v is not None}
