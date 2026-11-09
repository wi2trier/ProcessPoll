"""Variant mining, directly-follows graphs and consensus/divergence."""

from __future__ import annotations

import math
import zlib
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

from app.analytics.stats import LevenshteinPattern, normalized_entropy, wilson_interval

START = "__start__"
END = "__end__"
_RESERVED = frozenset({START, END})

MAX_VARIANTS_RETURNED = 500
MEDOID_MAX_VARIANTS = 120


def default_min_support(n: int) -> int:
    """``max(5, ceil(0.05 * N))`` in exact integer arithmetic."""
    return max(5, -(-n // 20))


def _round(x: float, digits: int = 6) -> float:
    return round(float(x), digits)


def escape_label(label: str) -> str:
    """Make a free-text activity label safe to use as DFG node id.

    ``__start__`` / ``__end__`` are the ids of the virtual nodes. A participant can type exactly
    these strings, which would merge the activity with the virtual node (duplicate node ids,
    corrupted edge counts, broken graph rendering). Such labels get one leading backslash; labels
    that already consist of backslashes followed by a reserved word get one more, so the mapping
    is injective. All other labels are unchanged."""
    return "\\" + label if label.lstrip("\\") in _RESERVED else label


def prepare_traces(traces: Sequence[Sequence[str]]) -> list[Sequence[str]]:
    """Drop empty traces and escape reserved labels (see :func:`escape_label`)."""
    kept = [t for t in traces if len(t) > 0]
    labels: set[str] = set()
    for t in kept:
        labels.update(t)
    mapping = {a: escape_label(a) for a in labels if escape_label(a) != a}
    if not mapping:
        return kept
    return [[mapping.get(a, a) for a in t] for t in kept]


def dfg_counts(
    traces: Sequence[Sequence[str]],
) -> tuple[Counter[tuple[str, str]], Counter[tuple[str, str]]]:
    """Return (E, E_case): absolute and per-trace (case) frequencies of directly-follows pairs
    including the virtual START/END nodes. Labels are used as they are (see
    :func:`prepare_traces` for the escaping of reserved labels)."""
    edges: Counter[tuple[str, str]] = Counter()
    edges_case: Counter[tuple[str, str]] = Counter()
    for trace in traces:
        path = [START, *trace, END]
        pairs = list(pairwise(path))
        edges.update(pairs)
        edges_case.update(set(pairs))
    return edges, edges_case


def _empty(min_support: int, theta: float) -> dict[str, Any]:
    return {
        "n": 0,
        "kpis": {
            "n": 0,
            "n_variants": 0,
            "variant_ratio": 0.0,
            "top_variant_share": 0.0,
            "coverage_top5": 0.0,
            "mean_length": 0.0,
            "start_agreement": 0.0,
            "end_agreement": 0.0,
        },
        "variants": [],
        "activities": [],
        "dfg": {
            "nodes": [
                {"id": START, "label": "Start", "kind": "start", "count": 0, "case_count": 0},
                {"id": END, "label": "End", "kind": "end", "count": 0, "case_count": 0},
            ],
            "edges": [],
        },
        "consensus": {
            "min_support": min_support,
            "theta": theta,
            "strong": [],
            "hotspots": [],
            "low_support": [],
            "medoid": None,
        },
    }


@dataclass
class Parts:
    """Result of one analysis plus the raw counters the group comparison reuses."""

    result: dict[str, Any]
    edges: Counter[tuple[str, str]]
    edges_case: Counter[tuple[str, str]]
    variant_counts: Counter[tuple[str, ...]]


def analyze(
    traces: Sequence[Sequence[str]],
    *,
    min_support: int | None = None,
    theta: float = 0.7,
    with_medoid: bool = True,
) -> dict[str, Any]:
    """Full analysis of already-resolved traces (list of final labels). Pure and deterministic.

    Empty traces are ignored (``N`` counts non-empty traces only); labels equal to the ids of the
    virtual nodes are escaped (:func:`escape_label`)."""
    return analyze_prepared(
        prepare_traces(traces), min_support=min_support, theta=theta, with_medoid=with_medoid
    ).result


def analyze_prepared(
    traces: Sequence[Sequence[str]],
    *,
    min_support: int | None = None,
    theta: float = 0.7,
    with_medoid: bool = True,
) -> Parts:
    """:func:`analyze` for traces that went through :func:`prepare_traces` already."""
    n = len(traces)
    ms = default_min_support(n) if min_support is None else max(1, int(min_support))
    if n == 0:
        return Parts(_empty(ms, theta), Counter(), Counter(), Counter())

    variant_counts: Counter[tuple[str, ...]] = Counter(tuple(t) for t in traces)
    ordered = sorted(variant_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    variants = []
    cumulative = 0
    for steps, n_variant in ordered[:MAX_VARIANTS_RETURNED]:
        cumulative += n_variant
        variants.append(
            {
                "steps": list(steps),
                "count": n_variant,
                "share": _round(n_variant / n),
                "cumulative_share": _round(cumulative / n),
            }
        )
    top5 = sum(c for _, c in ordered[:5])
    start_counts = Counter(t[0] for t in traces)
    end_counts = Counter(t[-1] for t in traces)
    kpis = {
        "n": n,
        "n_variants": len(variant_counts),
        "variant_ratio": _round(len(variant_counts) / n),
        "top_variant_share": _round(ordered[0][1] / n),
        "coverage_top5": _round(top5 / n),
        "mean_length": _round(sum(len(t) for t in traces) / n),
        "start_agreement": _round(max(start_counts.values()) / n),
        "end_agreement": _round(max(end_counts.values()) / n),
    }

    count: Counter[str] = Counter()
    case_count: Counter[str] = Counter()
    repeat_traces: Counter[str] = Counter()
    position_sum: Counter[str] = Counter()
    for trace in traces:
        per_trace = Counter(trace)
        count.update(per_trace)
        case_count.update(per_trace.keys())
        repeat_traces.update(a for a, c in per_trace.items() if c > 1)
        for pos, a in enumerate(trace, 1):
            position_sum[a] += pos
    activities = [
        {
            "label": a,
            "count": count[a],
            "case_count": case_count[a],
            "repeat_traces": repeat_traces[a],
            "mean_position": _round(position_sum[a] / count[a]),
            "start_count": start_counts.get(a, 0),
            "end_count": end_counts.get(a, 0),
        }
        for a in sorted(count, key=lambda x: (-case_count[x], -count[x], x))
    ]

    edges, edges_case = dfg_counts(traces)
    nodes = [
        {"id": START, "label": "Start", "kind": "start", "count": n, "case_count": n},
        {"id": END, "label": "End", "kind": "end", "count": n, "case_count": n},
    ] + [
        {
            "id": a["label"],
            "label": a["label"],
            "kind": "activity",
            "count": a["count"],
            "case_count": a["case_count"],
        }
        for a in activities
    ]
    dfg_edges = [
        {"source": s, "target": t, "count": c, "case_count": edges_case[(s, t)]}
        for (s, t), c in sorted(edges.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    successors: dict[str, Counter[str]] = defaultdict(Counter)
    for (s, t), c in edges.items():
        successors[s][t] += c
    strong: list[dict[str, Any]] = []
    hotspots: list[dict[str, Any]] = []
    low_support: list[str] = []
    for a in sorted(successors):
        succ = successors[a]
        support = sum(succ.values())
        if support < ms:
            if a != START:
                low_support.append(a)
            continue
        ranked = sorted(succ.items(), key=lambda kv: (-kv[1], kv[0]))
        top_target, top_count = ranked[0]
        share = top_count / support
        lo, hi = wilson_interval(top_count, support)
        if lo >= theta:
            strong.append(
                {
                    "source": a,
                    "target": top_target,
                    "support": support,
                    "share": _round(share),
                    "ci_low": _round(lo),
                    "ci_high": _round(hi),
                }
            )
        mass = support - top_count
        if mass > 0 and share < theta:
            hotspots.append(
                {
                    "activity": a,
                    "support": support,
                    "dominant_share": _round(share),
                    "ci_low": _round(lo),
                    "ci_high": _round(hi),
                    "entropy_norm": _round(normalized_entropy(list(succ.values()))),
                    "disagreement_mass": mass,
                    "continuations": [
                        {"target": t, "count": c, "share": _round(c / support)} for t, c in ranked
                    ],
                }
            )
    strong.sort(key=lambda x: (-x["share"], -x["support"], x["source"]))
    hotspots.sort(key=lambda x: (-x["disagreement_mass"], -x["support"], x["activity"]))

    medoid = _medoid(ordered, n) if with_medoid else None

    result = {
        "n": n,
        "kpis": kpis,
        "variants": variants,
        "activities": activities,
        "dfg": {"nodes": nodes, "edges": dfg_edges},
        "consensus": {
            "min_support": ms,
            "theta": theta,
            "strong": strong,
            "hotspots": hotspots,
            "low_support": low_support,
            "medoid": medoid,
        },
    }
    return Parts(result, edges, edges_case, variant_counts)


def _tie_hash(steps: tuple[str, ...]) -> int:
    return zlib.crc32("\x1f".join(steps).encode("utf-8", "surrogatepass"))


def _medoid_candidates(
    ordered: list[tuple[tuple[str, ...], int]],
) -> list[tuple[tuple[str, ...], int]]:
    """At most ``MEDOID_MAX_VARIANTS`` most frequent variants, sorted (count desc, steps).

    Variants tied with the last accepted count are chosen by a stable hash instead of
    alphabetically, so the cut does not systematically favour labels early in the alphabet."""
    cap = MEDOID_MAX_VARIANTS
    if len(ordered) <= cap:
        return ordered
    cutoff = ordered[cap - 1][1]
    head = [kv for kv in ordered if kv[1] > cutoff]
    ties = sorted(
        (kv for kv in ordered if kv[1] == cutoff), key=lambda kv: (_tie_hash(kv[0]), kv[0])
    )
    chosen = head + ties[: cap - len(head)]
    chosen.sort(key=lambda kv: (-kv[1], kv[0]))
    return chosen


def _medoid(ordered: list[tuple[tuple[str, ...], int]], n: int) -> dict[str, Any] | None:
    """Return a weighted medoid trace.

    The medoid ``v*`` minimises ``sum_v count(v) * d(v*, v)`` with ``d = lev / max(len)``. It is
    searched among the ``MEDOID_MAX_VARIANTS`` most frequent variants and compared against that
    same set (cost ``O(C^2 * L)`` with the bit-parallel edit distance). The reported
    ``mean_distance`` is always the exact dispersion of ``v*`` over *all* ``n`` traces.
    ``approximate`` is true when there are more variants than candidates.

    All sums are exact integers (distances are scaled by the lcm of the occurring lengths), so
    ties are exact: higher count first, then lexicographic order of the steps."""
    if not ordered:
        return None
    cand = _medoid_candidates(ordered)
    vocab: dict[str, int] = {}
    seqs = [[vocab.setdefault(a, len(vocab)) for a in steps] for steps, _ in cand]
    weights = [c for _, c in cand]
    lens = [len(s) for s in seqs]
    scale = math.lcm(*set(lens))
    patterns = [LevenshteinPattern(s) for s in seqs]
    m = len(cand)
    cost = [0] * m
    for i in range(m):
        pat, li, wi = patterns[i], lens[i], weights[i]
        for j in range(i + 1, m):
            lj = lens[j]
            unit = pat.distance(seqs[j]) * (scale // (li if li > lj else lj))
            cost[i] += weights[j] * unit
            cost[j] += wi * unit
    best = min(range(m), key=lambda i: (cost[i], i))

    best_steps = cand[best][0]
    best_pat = patterns[best]
    scale_all = math.lcm(*{len(steps) for steps, _ in ordered})
    total = 0
    for steps, count in ordered:
        encoded = [vocab.get(a, -1) for a in steps]
        dist = best_pat.distance(encoded)
        longest = max(len(steps), best_pat.length)
        total += count * dist * (scale_all // longest)
    return {
        "steps": list(best_steps),
        "mean_distance": _round(total / (scale_all * n)),
        "approximate": len(ordered) > MEDOID_MAX_VARIANTS,
    }
