"""One display rule for shares, used in every backend message (the frontend's lib/format.ts fmtShare is identical).

    None      -> "—"        (not measured)
    0         -> "0 %"      (a measured zero)
    0 < v < 1 -> "< 1 %"    (never rounded down to 0, never shown with false precision)
    v >= 1    -> one decimal, e.g. "22.5 %"
"""

from __future__ import annotations


def fmt_share(v: float | None) -> str:
    if v is None:
        return "—"
    if v == 0:
        return "0 %"
    if 0 < v < 1:
        return "< 1 %"
    return f"{v:.1f} %"
