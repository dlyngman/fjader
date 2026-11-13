"""Mark factory functions — the public API for creating marks.

Each function mirrors a Fjader Svelte mark component with full type hints
for IDE autocompletion.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

from .area import AreaXMark, AreaYMark
from .bar import BarXMark, BarYMark
from .dot import DotMark
from .line import LineMark
from .rect import RectMark, RectXMark, RectYMark
from .text import TextMark

if TYPE_CHECKING:
    from ..fields import ColorChannel, FieldSpec
    from .._types import (
        ColorScheme,
        CurveType,
        DomainConfig,
        LineAnchor,
        ScaleType,
        SortConfig,
        TextAnchor,
    )
    from ..transforms._base import TransformSpec


def dot(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    y: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    opacity: float | None = None,
    r: float | FieldSpec | None = None,
    radius_range: list[float] | tuple[float, float] | None = None,
    preferred_x_scale_type: ScaleType | None = None,
    preferred_y_scale_type: ScaleType | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> DotMark:
    """Scatter/dot mark.

    Args:
        table: Table name in DuckDB.
        x: X position — column name, aggregate (``fj.count()``), or bin (``fj.bin('col')``).
        y: Y position — column name, aggregate, or bin.
        fill: Fill color — column name for color scale, aggregate, or bin; ``fj.colors()`` for explicit colours.
        opacity: Constant opacity (0–1).
        r: Dot radius — constant ``float`` or data-driven ``FieldSpec`` for size scale.
        radius_range: Min/max radius in pixels when ``r`` is data-driven, e.g. ``[2, 12]``.
        preferred_x_scale_type: Force x-axis scale type (e.g. ``'log'``, ``'time'``).
        preferred_y_scale_type: Force y-axis scale type.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.dot(..., selection_response="ignore", opacity=0.2) * fj.dot(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name (e.g. ``'category10'``, ``'viridis'``).
        limit: Maximum number of rows to query.
        transforms: List of transforms (e.g. ``[fj.topN(10), fj.filter(...)]``).
        sort: Sort configuration, e.g. ``{'y': 'count', 'order': 'desc'}``.
        domain: Explicit category order for band scales, e.g. ``{'x': ['Mon', 'Tue', ...]}``.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return DotMark(
        data=data, table=table, x=x, y=y, fill=fill, opacity=opacity, r=r,
        radius_range=radius_range,
        preferred_x_scale_type=preferred_x_scale_type,
        preferred_y_scale_type=preferred_y_scale_type,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def bar_x(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    x1: FieldSpec | None = None,
    x2: FieldSpec | None = None,
    y: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    opacity: float | None = None,
    padding: float | None = None,
    padding_inner: float | None = None,
    padding_outer: float | None = None,
    inset: float | None = None,
    dx: float | None = None,
    dy: float | None = None,
    contribute_domain: bool | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> BarXMark:
    """Horizontal bar mark (bars extend along x-axis).

    Args:
        table: Table name in DuckDB.
        x: Bar length — column name, aggregate, or bin.
        x1: Bar start position (for ranged bars).
        x2: Bar end position (for ranged bars).
        y: Category axis — column name.
        fill: Fill color — column name for color scale; ``fj.colors()`` for explicit colours.
        opacity: Constant opacity (0–1).
        padding: Band scale padding (0–1), shorthand for inner + outer.
        padding_inner: Space between bars within a group (0–1).
        padding_outer: Space at band edges (0–1).
        inset: Pixel inset within each band.
        dx: Horizontal pixel offset.
        dy: Vertical pixel offset.
        contribute_domain: ``False`` makes this mark follow the band axis the
            other marks on it decide (their categories and their order) instead
            of adding its own; rows of categories the axis does not show are not
            drawn. For a layer that gives context to another. It cannot rank or
            reduce its own categories, so ``topN``, ``sort`` and ``domain`` are
            refused with it. With a top N in background totals, rank on one layer
            and give the other ``contribute_domain=False``: ranking on the faint
            whole keeps the same N categories under a selection, ranking on the
            front part re-ranks within it. Not with ``includeOthers``: the
            follower has no Other row.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.bar_x(..., selection_response="ignore", opacity=0.2) * fj.bar_x(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration, e.g. ``{'y': 'count', 'order': 'desc'}``.
        domain: Explicit category order for band scales, e.g. ``{'y': ['sun', 'rain', ...]}``.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return BarXMark(
        data=data, table=table, x=x, x1=x1, x2=x2, y=y, fill=fill, opacity=opacity,
        padding=padding, padding_inner=padding_inner, padding_outer=padding_outer,
        inset=inset, dx=dx, dy=dy, contribute_domain=contribute_domain,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def bar_y(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    y: FieldSpec | None = None,
    y1: FieldSpec | None = None,
    y2: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    opacity: float | None = None,
    padding: float | None = None,
    padding_inner: float | None = None,
    padding_outer: float | None = None,
    inset: float | None = None,
    dx: float | None = None,
    dy: float | None = None,
    contribute_domain: bool | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> BarYMark:
    """Vertical bar mark (bars extend along y-axis).

    Args:
        table: Table name in DuckDB.
        x: Category axis — column name.
        y: Bar height — column name, aggregate (e.g. ``fj.count()``), or bin.
        y1: Bar start position (for ranged/stacked bars).
        y2: Bar end position (for ranged/stacked bars).
        fill: Fill color — column name for color scale; ``fj.colors()`` for explicit colours.
        opacity: Constant opacity (0–1).
        padding: Band scale padding (0–1), shorthand for inner + outer.
        padding_inner: Space between bars within a group (0–1).
        padding_outer: Space at band edges (0–1).
        inset: Pixel inset within each band.
        dx: Horizontal pixel offset.
        dy: Vertical pixel offset.
        contribute_domain: ``False`` makes this mark follow the band axis the
            other marks on it decide (their categories and their order) instead
            of adding its own; rows of categories the axis does not show are not
            drawn. For a layer that gives context to another. It cannot rank or
            reduce its own categories, so ``topN``, ``sort`` and ``domain`` are
            refused with it. With a top N in background totals, rank on one layer
            and give the other ``contribute_domain=False``: ranking on the faint
            whole keeps the same N categories under a selection, ranking on the
            front part re-ranks within it. Not with ``includeOthers``: the
            follower has no Other row.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.bar_y(..., selection_response="ignore", opacity=0.2) * fj.bar_y(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration, e.g. ``{'x': 'name', 'order': 'asc'}``.
        domain: Explicit category order for band scales, e.g. ``{'x': ['Mon', 'Tue', ...]}``.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return BarYMark(
        data=data, table=table, x=x, y=y, y1=y1, y2=y2, fill=fill, opacity=opacity,
        padding=padding, padding_inner=padding_inner, padding_outer=padding_outer,
        inset=inset, dx=dx, dy=dy, contribute_domain=contribute_domain,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def line(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    y: FieldSpec | None = None,
    stroke: ColorChannel | None = None,
    z: FieldSpec | None = None,
    stroke_width: float | None = None,
    dot_radius: float | None = None,
    opacity: float | None = None,
    curve: CurveType | None = None,
    lod: bool | dict | None = None,
    preferred_x_scale_type: ScaleType | None = None,
    preferred_y_scale_type: ScaleType | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> LineMark:
    """Line mark for connected data points.

    Args:
        table: Table name in DuckDB.
        x: X position — column name, aggregate, or bin.
        y: Y position — column name, aggregate, or bin.
        stroke: Line color — column name for color scale (also groups into series).
        z: Explicit series grouping (overrides implicit grouping from ``stroke``).
        stroke_width: Line width in pixels.
        dot_radius: Radius of dots at data points (0 to hide).
        curve: Interpolation curve type (e.g. ``'monotone'``, ``'step'``, ``'catmull-rom'``).
        lod: Level-of-detail config — ``True``/``False`` to enable/disable, or a dict
            with keys ``dots``, ``smooth``, ``decimate``, ``multiplier``.
        preferred_x_scale_type: Force x-axis scale type (e.g. ``'time'``).
        preferred_y_scale_type: Force y-axis scale type.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.line(..., selection_response="ignore", opacity=0.2) * fj.line(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration.
        domain: Explicit category order for band scales.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return LineMark(
        data=data, table=table, x=x, y=y, stroke=stroke, z=z,
        stroke_width=stroke_width, dot_radius=dot_radius, opacity=opacity,
        curve=curve, lod=lod,
        preferred_x_scale_type=preferred_x_scale_type,
        preferred_y_scale_type=preferred_y_scale_type,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def area_y(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    y: FieldSpec | None = None,
    y1: FieldSpec | None = None,
    y2: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    z: FieldSpec | None = None,
    fill_opacity: float | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    dot_radius: float | None = None,
    auto_dots: bool | None = None,
    curve: CurveType | None = None,
    preferred_x_scale_type: ScaleType | None = None,
    preferred_y_scale_type: ScaleType | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> AreaYMark:
    """Vertical area mark (x dimension, y1/y2 boundaries).

    Args:
        table: Table name in DuckDB.
        x: X position — column name, aggregate, or bin.
        y: Y position (shorthand for y2 with y1=0).
        y1: Lower y boundary.
        y2: Upper y boundary.
        fill: Fill color — column name for color scale (also groups into series); ``fj.colors()`` for explicit colours.
        z: Explicit series grouping (overrides implicit grouping from ``fill``).
        fill_opacity: Fill opacity (0–1).
        stroke: CSS color for area outline (e.g. ``'#333'``). Not data-driven.
        stroke_width: Outline width in pixels.
        dot_radius: Radius of dots at data points (0 to hide).
        auto_dots: Density-based dot fading — show dots when data is sparse.
        curve: Interpolation curve type (e.g. ``'monotone'``, ``'step'``).
        preferred_x_scale_type: Force x-axis scale type.
        preferred_y_scale_type: Force y-axis scale type.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.area_y(..., selection_response="ignore", opacity=0.2) * fj.area_y(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms (e.g. ``[fj.stack_y()]``).
        sort: Sort configuration.
        domain: Explicit category order for band scales.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return AreaYMark(
        data=data, table=table, x=x, y=y, y1=y1, y2=y2, fill=fill, z=z,
        fill_opacity=fill_opacity, stroke=stroke, stroke_width=stroke_width,
        dot_radius=dot_radius, auto_dots=auto_dots, curve=curve,
        preferred_x_scale_type=preferred_x_scale_type,
        preferred_y_scale_type=preferred_y_scale_type,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def area_x(
    *,
    data: Any = None,
    table: str | None = None,
    y: FieldSpec | None = None,
    x: FieldSpec | None = None,
    x1: FieldSpec | None = None,
    x2: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    z: FieldSpec | None = None,
    fill_opacity: float | None = None,
    stroke: str | None = None,
    stroke_width: float | None = None,
    dot_radius: float | None = None,
    auto_dots: bool | None = None,
    curve: CurveType | None = None,
    preferred_x_scale_type: ScaleType | None = None,
    preferred_y_scale_type: ScaleType | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> AreaXMark:
    """Horizontal area mark (y dimension, x1/x2 boundaries).

    Args:
        table: Table name in DuckDB.
        y: Y position — column name, aggregate, or bin.
        x: X position (shorthand for x2 with x1=0).
        x1: Left x boundary.
        x2: Right x boundary.
        fill: Fill color — column name for color scale (also groups into series); ``fj.colors()`` for explicit colours.
        z: Explicit series grouping (overrides implicit grouping from ``fill``).
        fill_opacity: Fill opacity (0–1).
        stroke: CSS color for area outline (e.g. ``'#333'``). Not data-driven.
        stroke_width: Outline width in pixels.
        dot_radius: Radius of dots at data points (0 to hide).
        auto_dots: Density-based dot fading — show dots when data is sparse.
        curve: Interpolation curve type.
        preferred_x_scale_type: Force x-axis scale type.
        preferred_y_scale_type: Force y-axis scale type.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.area_x(..., selection_response="ignore", opacity=0.2) * fj.area_x(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration.
        domain: Explicit category order for band scales.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return AreaXMark(
        data=data, table=table, y=y, x=x, x1=x1, x2=x2, fill=fill, z=z,
        fill_opacity=fill_opacity, stroke=stroke, stroke_width=stroke_width,
        dot_radius=dot_radius, auto_dots=auto_dots, curve=curve,
        preferred_x_scale_type=preferred_x_scale_type,
        preferred_y_scale_type=preferred_y_scale_type,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def rect(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    x1: FieldSpec | None = None,
    x2: FieldSpec | None = None,
    y: FieldSpec | None = None,
    y1: FieldSpec | None = None,
    y2: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    opacity: float | None = None,
    preferred_x_scale_type: ScaleType | None = None,
    preferred_y_scale_type: ScaleType | None = None,
    padding: float | None = None,
    padding_inner: float | None = None,
    padding_outer: float | None = None,
    inset: float | None = None,
    dx: float | None = None,
    dy: float | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> RectMark:
    """Rectangle mark for 2D binning or heatmaps.

    Args:
        table: Table name in DuckDB.
        x: X position — column name (band or continuous).
        x1: Left x boundary.
        x2: Right x boundary.
        y: Y position — column name.
        y1: Bottom y boundary.
        y2: Top y boundary.
        fill: Fill color — column name for color scale; ``fj.colors()`` for explicit colours.
        opacity: Constant opacity (0–1).
        preferred_x_scale_type: Force x-axis scale type.
        preferred_y_scale_type: Force y-axis scale type.
        padding: Band scale padding (0–1).
        padding_inner: Space between rects (0–1).
        padding_outer: Space at band edges (0–1).
        inset: Pixel inset within each band.
        dx: Horizontal pixel offset.
        dy: Vertical pixel offset.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.rect(..., selection_response="ignore", opacity=0.2) * fj.rect(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration.
        domain: Explicit category order for band scales.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return RectMark(
        data=data, table=table, x=x, x1=x1, x2=x2, y=y, y1=y1, y2=y2,
        fill=fill, opacity=opacity,
        preferred_x_scale_type=preferred_x_scale_type,
        preferred_y_scale_type=preferred_y_scale_type,
        padding=padding, padding_inner=padding_inner, padding_outer=padding_outer,
        inset=inset, dx=dx, dy=dy,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def rect_x(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    x1: FieldSpec | None = None,
    x2: FieldSpec | None = None,
    y: FieldSpec | None = None,
    y1: FieldSpec | None = None,
    y2: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    opacity: float | None = None,
    inset: float | None = None,
    dx: float | None = None,
    dy: float | None = None,
    preferred_y_scale_type: ScaleType | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> RectXMark:
    """Horizontal rect mark (e.g. histograms along x-axis).

    Args:
        table: Table name in DuckDB.
        x: X position — column name or bin.
        x1: Left x boundary.
        x2: Right x boundary.
        y: Y position.
        y1: Bottom y boundary.
        y2: Top y boundary.
        fill: Fill color — column name for color scale; ``fj.colors()`` for explicit colours.
        opacity: Constant opacity (0–1).
        inset: Pixel inset.
        dx: Horizontal pixel offset.
        dy: Vertical pixel offset.
        preferred_y_scale_type: Force y-axis scale type.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.rect_x(..., selection_response="ignore", opacity=0.2) * fj.rect_x(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration.
        domain: Explicit category order for band scales.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return RectXMark(
        data=data, table=table, x=x, x1=x1, x2=x2, y=y, y1=y1, y2=y2,
        fill=fill, opacity=opacity, inset=inset, dx=dx, dy=dy,
        preferred_y_scale_type=preferred_y_scale_type,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def rect_y(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    x1: FieldSpec | None = None,
    x2: FieldSpec | None = None,
    y: FieldSpec | None = None,
    y1: FieldSpec | None = None,
    y2: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    opacity: float | None = None,
    inset: float | None = None,
    dx: float | None = None,
    dy: float | None = None,
    preferred_x_scale_type: ScaleType | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> RectYMark:
    """Vertical rect mark (e.g. histograms along y-axis).

    Args:
        table: Table name in DuckDB.
        x: X position — column name or bin.
        x1: Left x boundary.
        x2: Right x boundary.
        y: Y position — column name or aggregate.
        y1: Bottom y boundary.
        y2: Top y boundary.
        fill: Fill color — column name for color scale; ``fj.colors()`` for explicit colours.
        opacity: Constant opacity (0–1).
        inset: Pixel inset.
        dx: Horizontal pixel offset.
        dy: Vertical pixel offset.
        preferred_x_scale_type: Force x-axis scale type.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.rect_y(..., selection_response="ignore", opacity=0.2) * fj.rect_y(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration.
        domain: Explicit category order for band scales.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return RectYMark(
        data=data, table=table, x=x, x1=x1, x2=x2, y=y, y1=y1, y2=y2,
        fill=fill, opacity=opacity, inset=inset, dx=dx, dy=dy,
        preferred_x_scale_type=preferred_x_scale_type,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )


def text(
    *,
    data: Any = None,
    table: str | None = None,
    x: FieldSpec | None = None,
    y: FieldSpec | None = None,
    text: FieldSpec | None = None,
    fill: ColorChannel | None = None,
    font_size: float | None = None,
    font_weight: str | None = None,
    font_family: str | None = None,
    dx: float | None = None,
    dy: float | None = None,
    text_anchor: TextAnchor | None = None,
    line_anchor: LineAnchor | None = None,
    rotate: float | None = None,
    preferred_x_scale_type: ScaleType | None = None,
    preferred_y_scale_type: ScaleType | None = None,
    selection: str | None = None,
    selection_response: Literal["auto", "filter", "ignore"] | None = None,
    nulls: Literal["keep", "drop"] | None = None,
    holds_entrance: bool | None = None,
    scheme: ColorScheme | None = None,
    limit: int | None = None,
    transforms: list[TransformSpec] | None = None,
    sort: SortConfig | None = None,
    domain: DomainConfig | None = None,
    tooltip: bool | dict[str, bool] | None = None,
    tooltip_proximity: Literal["x", "y", "xy"] | None = None,
    tip: list[str] | Literal[False] | None = None,
    fit_domain: Literal["x", "y"] | bool | None = None,
) -> TextMark:
    """Text mark for labels and annotations.

    Args:
        table: Table name in DuckDB.
        x: X position — column name, aggregate, or bin.
        y: Y position — column name, aggregate, or bin.
        text: Text content — column name or aggregate.
        fill: Text color — column name for color scale.
        font_size: Font size in pixels.
        font_weight: CSS font weight (e.g. ``'bold'``, ``'600'``).
        font_family: CSS font family.
        dx: Horizontal pixel offset.
        dy: Vertical pixel offset.
        text_anchor: Horizontal alignment: ``'start'``, ``'middle'``, or ``'end'``.
        line_anchor: Vertical alignment: ``'top'``, ``'middle'``, or ``'bottom'``.
        rotate: Rotation angle in degrees.
        preferred_x_scale_type: Force x-axis scale type.
        preferred_y_scale_type: Force y-axis scale type.
        selection: Selection parameter name for linked interactors.
        selection_response: "filter" makes every selection filter this mark, even on
            a field it draws by (top N within the selected region), and it never
            dims. A legend, Toggle or band label filters it in its own chart too;
            a brush still skips its own chart. "auto" (default) dims it for a
            categorical selection on such a field. "ignore": no selection
            filters or dims it; context, such as the whole behind a filtered part.
            Background totals are two layers:
            ``fj.text(..., selection_response="ignore", opacity=0.2) * fj.text(...)``
            draws the filtered part over its faint total.
        nulls: "drop" leaves out rows whose band axis, ordinal colour, series
            or facet value is NULL, before any transform. "keep" (default) draws
            NULL as a category, labelled "(null)".
        holds_entrance: Whether the chart's entrance waits for this mark's
            first data (default ``True``). ``False`` for a mark known to be
            slower than the rest: the chart enters without it.
        scheme: Color scheme name.
        limit: Maximum number of rows.
        transforms: List of transforms.
        sort: Sort configuration.
        domain: Explicit category order for band scales.
        tooltip: Enable tooltip on hover, or ``{"sort_table": True}`` to write the
            tooltip table sorted by x (off by default).
        tooltip_proximity: Tooltip proximity mode: ``'x'``, ``'y'``, or ``'xy'``.
        tip: Tooltip field control — list of channel/field names, ``['*']`` for all, or ``False`` to disable.
        fit_domain: Auto-fit axis domain to visible data — ``'x'``, ``'y'``, or ``True`` for both.
    """
    return TextMark(
        data=data, table=table, x=x, y=y, text=text, fill=fill,
        font_size=font_size, font_weight=font_weight, font_family=font_family,
        dx=dx, dy=dy, text_anchor=text_anchor, line_anchor=line_anchor,
        rotate=rotate,
        preferred_x_scale_type=preferred_x_scale_type,
        preferred_y_scale_type=preferred_y_scale_type,
        selection=selection, selection_response=selection_response, nulls=nulls, holds_entrance=holds_entrance, scheme=scheme, limit=limit,
        transforms=transforms,
        sort=sort, domain=domain, tooltip=tooltip,
        tooltip_proximity=tooltip_proximity, tip=tip,
        fit_domain=fit_domain,
    )
