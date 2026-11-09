"""Group comparison: per-group analytics, JS distances, difference DFG with exploratory tests."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from itertools import combinations
from typing import Any

from app.analytics.core import analyze_prepared, prepare_traces
from app.analytics.stats import (
    LogFactorials,
    benjamini_hochberg,
    edge_pvalue,
    js_distance,
)


def compare_groups(
    groups: Mapping[str, Sequence[Sequence[str]]],
    *,
    k_min: int = 5,
    min_support: int | None = None,
    theta: float = 0.7,
    overlapping: bool = False,
) -> dict[str, Any]:
    """Compare groups of traces. Groups smaller than ``k_min`` are hidden (value + size only).

    ``overlapping`` states that one trace can belong to several groups (multiple-choice
    grouping); the tests then violate their independence assumption, which is reported as the
    warning ``overlapping_groups``."""
    clean = {g: prepare_traces(t) for g, t in groups.items()}
    kept = {g: t for g, t in clean.items() if len(t) >= k_min and len(t) > 0}
    hidden = [
        {"value": g, "n": len(t)} for g, t in sorted(clean.items()) if g not in kept and len(t) > 0
    ]
    order = sorted(kept, key=lambda g: (-len(kept[g]), g))

    out_groups = []
    edge_e: dict[str, Any] = {}
    edge_case: dict[str, Any] = {}
    variant_c: dict[str, Any] = {}
    for g in order:
        traces = kept[g]
        parts = analyze_prepared(traces, min_support=min_support, theta=theta, with_medoid=False)
        out_groups.append({"value": g, "n": len(traces), "analytics": parts.result})
        edge_e[g], edge_case[g] = parts.edges, parts.edges_case
        variant_c[g] = parts.variant_counts

    pairwise = [
        {
            "a": a,
            "b": b,
            "js_edges": round(js_distance(edge_e[a], edge_e[b]), 6),
            "js_variants": round(js_distance(variant_c[a], variant_c[b]), 6),
        }
        for a, b in combinations(order, 2)
    ]

    diff_edges: list[dict[str, Any]] = []
    if len(order) >= 2:
        union = sorted(set().union(*[set(edge_case[g]) for g in order]))
        sizes = [len(kept[g]) for g in order]
        lf = LogFactorials(sum(sizes))
        memo: dict[tuple[int, ...], float | None] = {}
        rows = []
        raw_p: list[float | None] = []
        for edge in union:
            cases = tuple(edge_case[g].get(edge, 0) for g in order)
            exact = [c / s for c, s in zip(cases, sizes, strict=True)]
            shares = {g: round(x, 6) for g, x in zip(order, exact, strict=True)}
            rows.append((edge, shares, round(max(exact) - min(exact), 6)))
            if cases not in memo:
                memo[cases] = edge_pvalue(cases, sizes, lf)
            raw_p.append(memo[cases])
        q_vals = benjamini_hochberg(raw_p)
        for (edge, shares, delta), p, q in zip(rows, raw_p, q_vals, strict=True):
            diff_edges.append(
                {
                    "source": edge[0],
                    "target": edge[1],
                    "shares": shares,
                    "delta": delta,
                    "p_value": None if p is None else round(p, 8),
                    "q_value": None if q is None else round(q, 8),
                }
            )
        diff_edges.sort(key=lambda e: (-e["delta"], e["source"], e["target"]))

    warns: list[str] = []
    if len(order) < 2:
        warns.append("single_group")
    if hidden:
        warns.append("small_groups")
    if any(len(kept[g]) < 20 for g in order):
        warns.append("low_n")
    if overlapping:
        warns.append("overlapping_groups")
    return {
        "groups": out_groups,
        "hidden_groups": hidden,
        "pairwise": pairwise,
        "diff_edges": diff_edges,
        "warnings": warns,
    }
