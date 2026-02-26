"""Layout classes: Overlay, HConcat, VConcat."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .marks._base import Mark, _get_marks, _to_plots


@dataclass
class Overlay:
    """Multiple marks sharing one chart. Intermediate before Plot resolution.

    Created by `mark * mark`. Call `.opts()` or `.to_dict()` to resolve.
    """

    marks: list[Mark] = field(default_factory=list)
    _opts: dict[str, Any] = field(default_factory=dict, repr=False, compare=False)

    def opts(self, **kwargs: Any) -> Any:
        from .plot import Plot

        return Plot(*self.marks, **kwargs)

    def to_dict(self) -> dict[str, Any]:
        from .plot import Plot

        return Plot(*self.marks, **self._opts).to_dict()

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    def __mul__(self, other: Any) -> Overlay:
        return Overlay(marks=self.marks + _get_marks(other))

    def __add__(self, other: Any) -> HConcat:
        from .plot import Plot

        left = Plot(*self.marks, **self._opts)
        return HConcat(items=[left] + _to_plots(other))


@dataclass
class HConcat:
    """Horizontal layout of independent charts. Created by `mark + mark`."""

    items: list[Any] = field(default_factory=list)  # list[Plot]

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        result["hconcat"] = [p._to_plot_spec() for p in self.items]
        return result

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    def __add__(self, other: Any) -> HConcat:
        return HConcat(items=self.items + _to_plots(other))


@dataclass
class VConcat:
    """Vertical layout of independent charts."""

    items: list[Any] = field(default_factory=list)  # list[Plot]

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        result["vconcat"] = [p._to_plot_spec() for p in self.items]
        return result

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    def __add__(self, other: Any) -> VConcat:
        return VConcat(items=self.items + _to_plots(other))


def hconcat(*items: Any) -> HConcat:
    """Create a horizontal layout from plots or marks."""
    plots: list[Any] = []
    for item in items:
        plots.extend(_to_plots(item))
    return HConcat(items=plots)


def vconcat(*items: Any) -> VConcat:
    """Create a vertical layout from plots or marks."""
    plots: list[Any] = []
    for item in items:
        plots.extend(_to_plots(item))
    return VConcat(items=plots)
