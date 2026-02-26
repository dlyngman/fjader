"""Base class for transform specs."""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Any, ClassVar

from .._convert import clean_dict, serialize_value, to_camel_case


@dataclass(frozen=True)
class TransformSpec:
    """Base for all transform specs. Subclasses set _transform_type."""

    _transform_type: ClassVar[str]

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"transform": self._transform_type}
        for f in fields(self):
            if f.name.startswith("_"):
                continue
            val = getattr(self, f.name)
            if val is not None:
                result[to_camel_case(f.name)] = serialize_value(val)
        return clean_dict(result)
