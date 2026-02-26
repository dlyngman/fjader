"""Data reference types and helpers."""

from __future__ import annotations


def sql(expr: str) -> str:
    """Mark a string as raw SQL for use in transform conditions.

    In Phase 1, this is identity — returns the string as-is.
    Exists to establish the API contract: dp.filter(dp.sql('x > 0'))
    """
    return expr
