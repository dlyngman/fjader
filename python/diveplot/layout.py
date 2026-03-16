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

    def _collect_data(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for m in self.marks:
            result.update(m._collect_data())
        return result

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        return self.to_dict(), self._collect_data()

    def _repr_mimebundle_(self, **kwargs: Any) -> Any:
        from ._display import make_widget

        return make_widget(self)._repr_mimebundle_(**kwargs)

    def __mul__(self, other: Any) -> Overlay:
        return Overlay(marks=self.marks + _get_marks(other))

    def __add__(self, other: Any) -> HConcat:
        from .plot import Plot

        left = Plot(*self.marks, **self._opts)
        return HConcat(items=[left] + _to_plots(other))


def _item_to_spec(item: Any) -> dict[str, Any]:
    """Serialize a layout item (Plot, HConcat, or VConcat) to a spec dict."""
    if isinstance(item, (HConcat, VConcat)):
        return item.to_dict()
    return item._to_plot_spec()


@dataclass
class HConcat:
    """Horizontal layout of independent charts. Created by `mark + mark`."""

    items: list[Any] = field(default_factory=list)  # list[Plot | HConcat | VConcat]

    def to_dict(self) -> dict[str, Any]:
        return {"hconcat": [_item_to_spec(p) for p in self.items]}

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    def _collect_data(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for p in self.items:
            result.update(p._collect_data())
        return result

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        return self.to_dict(), self._collect_data()

    def _repr_mimebundle_(self, **kwargs: Any) -> Any:
        from ._display import make_widget

        return make_widget(self)._repr_mimebundle_(**kwargs)

    def __add__(self, other: Any) -> HConcat:
        return HConcat(items=self.items + _to_items(other))


@dataclass
class VConcat:
    """Vertical layout of independent charts."""

    items: list[Any] = field(default_factory=list)  # list[Plot | HConcat | VConcat]

    def to_dict(self) -> dict[str, Any]:
        return {"vconcat": [_item_to_spec(p) for p in self.items]}

    def _all_marks(self) -> list[Any]:
        marks: list[Any] = []
        for p in self.items:
            if hasattr(p, '_marks'):
                marks.extend(p._marks)
            elif hasattr(p, '_all_marks'):
                marks.extend(p._all_marks())
        return marks

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    def _collect_data(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for p in self.items:
            result.update(p._collect_data())
        return result

    def _to_full_spec(self) -> tuple[dict[str, Any], dict[str, Any]]:
        return self.to_dict(), self._collect_data()

    def _repr_mimebundle_(self, **kwargs: Any) -> Any:
        from ._display import make_widget

        return make_widget(self)._repr_mimebundle_(**kwargs)

    def __add__(self, other: Any) -> VConcat:
        return VConcat(items=self.items + _to_items(other))


def _to_items(obj: Any) -> list[Any]:
    """Convert to list of layout items, preserving nested layouts."""
    from .plot import Plot

    if isinstance(obj, Mark):
        return [Plot(obj)]
    if isinstance(obj, Overlay):
        return [Plot(*obj.marks, **obj._opts)]
    if isinstance(obj, Plot):
        return [obj]
    if isinstance(obj, (HConcat, VConcat)):
        return [obj]
    raise TypeError(f"Cannot convert {type(obj).__name__} to layout item")


def hconcat(*items: Any) -> HConcat:
    """Create a horizontal layout from plots, marks, or nested layouts."""
    result: list[Any] = []
    for item in items:
        result.extend(_to_items(item))
    return HConcat(items=result)


def vconcat(*items: Any) -> VConcat:
    """Create a vertical layout from plots, marks, or nested layouts."""
    result: list[Any] = []
    for item in items:
        result.extend(_to_items(item))
    return VConcat(items=result)
