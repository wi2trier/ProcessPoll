"""Cross-checks of the analytics against independent, deliberately naive re-implementations.

The helpers use different formulas or libraries from production where possible. They are slow and
simple on purpose; the production code must agree with them on random data.
"""

from __future__ import annotations

import json
import math
import os
import random
import subprocess
import sys
from collections import Counter
from fractions import Fraction
from itertools import product
from math import comb
from pathlib import Path

import pytest
from scipy import stats as sps
from scipy.spatial.distance import jensenshannon

from app.analytics import END, START, analyze
from app.analytics.stats import (
    LevenshteinPattern,
    benjamini_hochberg,
    chi_square_pvalue,
    chi_square_valid,
    fisher_exact_two_sided,
    informative,
    js_distance,
    levenshtein,
    normalized_entropy,
    permutation_pvalue,
    wilson_interval,
)

ALPHABET = list("abcdefgh")


def random_log(seed: int, n: int = 60, max_len: int = 9, alphabet=ALPHABET) -> list[list[str]]:
    rnd = random.Random(seed)
    return [[rnd.choice(alphabet) for _ in range(rnd.randint(1, max_len))] for _ in range(n)]


def naive_edges(log):
    e, e_case = Counter(), Counter()
    for t in log:
        path = [START, *t, END]
        pairs = [(path[i], path[i + 1]) for i in range(len(path) - 1)]
        for p in pairs:
            e[p] += 1
        for p in set(pairs):
            e_case[p] += 1
    return e, e_case


def naive_wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Endpoints as the two roots of n * (k/n - p)^2 = z^2 * p * (1 - p)."""
    ph = k / n
    a = n + z * z
    b = 2 * n * ph + z * z
    c = n * ph * ph
    disc = math.sqrt(max(0.0, b * b - 4 * a * c))
    return max(0.0, (b - disc) / (2 * a)), min(1.0, (b + disc) / (2 * a))


def naive_entropy_norm(counts: list[int]) -> float:
    nz = [c for c in counts if c > 0]
    if len(nz) <= 1:
        return 0.0
    total = sum(nz)
    bits = -sum(c / total * math.log2(c / total) for c in nz)
    return bits / math.log2(len(nz))


def dp_lev(a, b) -> int:
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            d[i][j] = min(
                d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] != b[j - 1])
            )
    return d[-1][-1]


def naive_medoid(log):
    """Exact medoid with rational arithmetic; ties: higher count, then lexicographic."""
    variants = Counter(tuple(t) for t in log)
    best = None
    for cand in variants:
        cost = sum(
            Fraction(count * dp_lev(cand, other), max(len(cand), len(other)))
            for other, count in variants.items()
        )
        key = (cost, -variants[cand], cand)
        if best is None or key < best[0]:
            best = (key, cand)
    assert best is not None
    cost = best[0][0]
    return list(best[1]), float(cost / len(log))


def naive_consensus(log, min_support, theta):
    e, _ = naive_edges(log)
    succ: dict[str, Counter] = {}
    for (s, t), c in e.items():
        succ.setdefault(s, Counter())[t] += c
    strong, hot, low = set(), {}, set()
    for a, counter in succ.items():
        support = sum(counter.values())
        if support < min_support:
            if a != START:
                low.add(a)
            continue
        top = max(counter.values())
        dominant = sorted(t for t, c in counter.items() if c == top)[0]
        lo, _hi = naive_wilson(top, support)
        if lo >= theta:
            strong.add((a, dominant))
        if support - top > 0 and top / support < theta:
            hot[a] = (
                support,
                support - top,
                top / support,
                naive_entropy_norm(list(counter.values())),
            )
    return strong, hot, low


@pytest.mark.parametrize("seed", range(12))
def test_analyze_matches_naive_definitions_on_random_logs(seed):
    log = random_log(seed, n=20 + 7 * seed, max_len=3 + seed % 7, alphabet=ALPHABET[: 3 + seed % 5])
    n = len(log)
    r = analyze(log, min_support=4, theta=0.6)
    assert r["kpis"]["n_variants"] <= 120

    variants = Counter(tuple(t) for t in log)
    ordered = sorted(variants.items(), key=lambda kv: (-kv[1], kv[0]))
    assert [(tuple(v["steps"]), v["count"]) for v in r["variants"]] == ordered
    running = 0
    for v in r["variants"]:
        running += v["count"]
        assert v["cumulative_share"] == pytest.approx(running / n, abs=1e-6)
        assert v["share"] == pytest.approx(v["count"] / n, abs=1e-6)
    k = r["kpis"]
    assert k["n"] == n and k["n_variants"] == len(variants)
    assert k["variant_ratio"] == pytest.approx(len(variants) / n, abs=1e-6)
    assert k["top_variant_share"] == pytest.approx(ordered[0][1] / n, abs=1e-6)
    assert k["coverage_top5"] == pytest.approx(sum(c for _, c in ordered[:5]) / n, abs=1e-6)
    assert k["mean_length"] == pytest.approx(sum(map(len, log)) / n, abs=1e-6)
    assert k["start_agreement"] == pytest.approx(
        max(Counter(t[0] for t in log).values()) / n, abs=1e-6
    )
    assert k["end_agreement"] == pytest.approx(
        max(Counter(t[-1] for t in log).values()) / n, abs=1e-6
    )

    for act in r["activities"]:
        a = act["label"]
        occ = [(i, pos) for i, t in enumerate(log) for pos, x in enumerate(t, 1) if x == a]
        assert act["count"] == len(occ)
        assert act["case_count"] == len({i for i, _ in occ})
        per_trace = Counter(i for i, _ in occ)
        assert act["repeat_traces"] == sum(1 for c in per_trace.values() if c > 1)
        assert act["mean_position"] == pytest.approx(sum(p for _, p in occ) / len(occ), abs=1e-6)
        assert act["start_count"] == sum(t[0] == a for t in log)
        assert act["end_count"] == sum(t[-1] == a for t in log)

    e, e_case = naive_edges(log)
    assert {
        (x["source"], x["target"]): (x["count"], x["case_count"]) for x in r["dfg"]["edges"]
    } == {p: (e[p], e_case[p]) for p in e}
    assert sum(e.values()) == sum(len(t) + 1 for t in log)

    strong, hot, low = naive_consensus(log, 4, 0.6)
    c = r["consensus"]
    assert {(s["source"], s["target"]) for s in c["strong"]} == strong
    assert {h["activity"] for h in c["hotspots"]} == set(hot)
    assert set(c["low_support"]) == low
    for h in c["hotspots"]:
        support, mass, share, ent = hot[h["activity"]]
        assert (h["support"], h["disagreement_mass"]) == (support, mass)
        assert h["dominant_share"] == pytest.approx(share, abs=1e-6)
        assert h["entropy_norm"] == pytest.approx(ent, abs=1e-6)
        lo, hi = naive_wilson(round(share * support), support)
        assert h["ci_low"] == pytest.approx(lo, abs=1e-6) and h["ci_high"] == pytest.approx(
            hi, abs=1e-6
        )
    masses = [h["disagreement_mass"] for h in c["hotspots"]]
    assert masses == sorted(masses, reverse=True)

    steps, mean = naive_medoid(log)
    assert c["medoid"]["steps"] == steps
    assert c["medoid"]["mean_distance"] == pytest.approx(mean, abs=1e-6)


def test_wilson_matches_independent_formula_and_scipy():
    for n in [*range(1, 40), 100, 1000, 12345]:
        for k in sorted({0, 1, n // 3, n // 2, n - 1, n} & set(range(n + 1))):
            lo, hi = wilson_interval(k, n)
            nlo, nhi = naive_wilson(k, n)
            assert lo == pytest.approx(nlo, abs=1e-12) and hi == pytest.approx(nhi, abs=1e-12)
            ref = sps.binomtest(k, n).proportion_ci(confidence_level=0.95, method="wilson")

            assert lo == pytest.approx(ref.low, abs=2e-4) and hi == pytest.approx(
                ref.high, abs=2e-4
            )


def test_wilson_boundary_cases():
    lo, hi = wilson_interval(0, 10)
    assert lo == 0.0 and 0.2 < hi < 0.35
    lo, hi = wilson_interval(10, 10)
    assert hi == 1.0 and lo == pytest.approx(0.7225, abs=1e-3)
    lo, hi = wilson_interval(1, 1)
    assert hi == 1.0 and lo == pytest.approx(0.2065, abs=1e-3)
    lo, hi = wilson_interval(0, 1)
    assert lo == 0.0 and hi == pytest.approx(0.7935, abs=1e-3)
    assert wilson_interval(5, 0) == (0.0, 1.0)


def test_entropy_matches_naive_and_handles_edge_cases():
    rnd = random.Random(5)
    for _ in range(200):
        counts = [rnd.randint(0, 30) for _ in range(rnd.randint(1, 9))]
        assert normalized_entropy(counts) == pytest.approx(naive_entropy_norm(counts), abs=1e-12)
    assert normalized_entropy([]) == 0.0
    assert normalized_entropy([7]) == 0.0
    assert normalized_entropy([0, 7, 0]) == 0.0
    assert normalized_entropy([3, 3, 3]) == pytest.approx(1.0)
    assert normalized_entropy([1, 1, 2]) == normalized_entropy([2, 1, 1])


def test_js_distance_matches_scipy_reference():
    rnd = random.Random(9)
    for _ in range(200):
        keys = list(range(rnd.randint(1, 12)))
        p = {k: rnd.randint(0, 20) for k in keys}
        q = {k: rnd.randint(0, 20) for k in keys}
        if sum(p.values()) == 0 or sum(q.values()) == 0:
            continue
        ref = float(jensenshannon([p[k] for k in keys], [q[k] for k in keys], base=2))
        assert js_distance(p, q) == pytest.approx(ref, abs=1e-9)


def test_js_distance_is_zero_iff_proportional_and_a_metric():
    rnd = random.Random(10)
    for _ in range(100):
        p = {k: rnd.randint(0, 9) for k in "abcd"}
        q = {k: rnd.randint(0, 9) for k in "abcd"}
        r = {k: rnd.randint(0, 9) for k in "abcd"}
        if min(sum(p.values()), sum(q.values()), sum(r.values())) == 0:
            continue
        assert js_distance(p, q) == js_distance(q, p)
        assert js_distance(p, q) <= js_distance(p, r) + js_distance(r, q) + 1e-12
        scaled = {k: 3 * v for k, v in p.items()}
        assert js_distance(p, scaled) == pytest.approx(0.0, abs=1e-6)
        proportional = all(p[a] * sum(q.values()) == q[a] * sum(p.values()) for a in p)
        assert (js_distance(p, q) < 1e-7) == proportional


def test_benjamini_hochberg_matches_scipy_and_handles_ties_and_none():
    rnd = random.Random(11)
    for _ in range(100):
        ps = [round(rnd.random() ** 2, 4) for _ in range(rnd.randint(1, 40))]
        q = benjamini_hochberg(ps)
        ref = sps.false_discovery_control(ps, method="bh")
        assert q == pytest.approx(list(ref), abs=1e-12)
        assert all(qi >= pi - 1e-15 for qi, pi in zip(q, ps, strict=True))
        order = sorted(range(len(ps)), key=lambda i: ps[i])
        assert all(q[order[i]] <= q[order[i + 1]] + 1e-15 for i in range(len(ps) - 1))
    q = benjamini_hochberg([0.5, None, 0.5, 0.01, None])
    assert q[1] is None and q[4] is None and q[0] == q[2]
    assert benjamini_hochberg([]) == []
    assert benjamini_hochberg([None]) == [None]


def test_levenshtein_bitparallel_matches_dynamic_programming():
    rnd = random.Random(12)
    for _ in range(3000):
        la, lb = rnd.randint(0, 12), rnd.randint(0, 12)
        k = rnd.randint(1, 5)
        a = [rnd.randrange(k) for _ in range(la)]
        b = [rnd.randrange(k) for _ in range(lb)]
        assert LevenshteinPattern(a).distance(b) == dp_lev(a, b) == levenshtein(a, b), (a, b)

    for _ in range(100):
        a = [rnd.randrange(4) for _ in range(rnd.randint(60, 140))]
        b = [rnd.randrange(4) for _ in range(rnd.randint(60, 140))]
        assert LevenshteinPattern(a).distance(b) == dp_lev(a, b)

    assert LevenshteinPattern([1, 2, 3]).distance([-1, -1, -1]) == 3


def test_fisher_exact_matches_scipy():
    rnd = random.Random(13)
    for _ in range(1500):
        n1, n2 = rnd.randint(1, 80), rnd.randint(1, 80)
        a, c = rnd.randint(0, n1), rnd.randint(0, n2)
        ref = float(sps.fisher_exact([[a, n1 - a], [c, n2 - c]]).pvalue)
        assert fisher_exact_two_sided(a, n1, c, n2) == pytest.approx(ref, rel=1e-6, abs=1e-12)


def test_fisher_exact_edge_cases():
    assert fisher_exact_two_sided(0, 10, 0, 10) == 1.0
    assert fisher_exact_two_sided(10, 10, 10, 10) == 1.0
    assert fisher_exact_two_sided(5, 10, 5, 10) == pytest.approx(1.0)
    assert fisher_exact_two_sided(10, 10, 0, 10) < 1e-4
    assert fisher_exact_two_sided(3, 5, 0, 5) == fisher_exact_two_sided(0, 5, 3, 5)


def test_chi_square_matches_scipy_and_cochran_rule():
    rnd = random.Random(14)
    for _ in range(300):
        k = rnd.randint(3, 6)
        sizes = [rnd.randint(5, 60) for _ in range(k)]
        counts = [rnd.randint(0, s) for s in sizes]
        total = sum(counts)
        if total in (0, sum(sizes)):
            continue
        ref = float(
            sps.chi2_contingency(
                [counts, [s - c for s, c in zip(sizes, counts, strict=True)]]
            ).pvalue
        )
        assert chi_square_pvalue(counts, sizes) == pytest.approx(ref, rel=1e-9, abs=1e-14)
    assert chi_square_valid([30, 15, 5], [60, 60, 60])
    assert not chi_square_valid([0, 0, 5], [8, 8, 8])
    assert not chi_square_valid([1, 0, 0], [20, 20, 20])


def brute_force_ffh(sizes, counts) -> float:
    total, n = sum(counts), sum(sizes)

    def logp(c):
        return sum(math.log(comb(s, x)) for s, x in zip(sizes, c, strict=True)) - math.log(
            comb(n, total)
        )

    observed = logp(counts)
    p = 0.0
    for c in product(*[range(min(s, total) + 1) for s in sizes]):
        if sum(c) == total and logp(c) <= observed + 1e-9:
            p += math.exp(logp(c))
    return min(1.0, p)


@pytest.mark.parametrize(
    ("sizes", "counts"),
    [
        ([8, 8, 8], [0, 0, 5]),
        ([10, 10, 10], [0, 1, 5]),
        ([6, 9, 7], [1, 0, 5]),
        ([5, 5, 5, 5], [0, 0, 0, 4]),
        ([6, 6, 6], [2, 2, 2]),
        ([7, 7, 7, 7], [1, 0, 2, 1]),
    ],
)
def test_permutation_test_approximates_the_exact_freeman_halton_p_value(sizes, counts):
    exact = brute_force_ffh(sizes, counts)
    got = permutation_pvalue(counts, sizes)

    assert got == pytest.approx(exact, rel=0.35, abs=3e-4)
    assert permutation_pvalue(counts, sizes) == got
    assert permutation_pvalue(list(counts), list(sizes)) == got


def test_permutation_pvalue_is_valid_when_the_observed_table_is_the_most_extreme():
    p = permutation_pvalue([10, 0, 0], [10, 10, 10])
    assert 0 < p < 1e-3


def test_informative_edges_use_only_the_margin():
    assert not informative([1, 0], [10, 10])
    assert not informative([10, 9], [10, 10])
    assert not informative([10, 10], [10, 10])
    assert informative([2, 0], [10, 10])
    assert informative([1, 1], [10, 10])
    assert informative([9, 9], [10, 10])


_REPRO_SNIPPET = """
import json, random
from app.analytics import analyze, compare_groups
rnd = random.Random(3)
alpha = [f"act {i}" for i in range(40)]
log = [[rnd.choice(alpha) for _ in range(rnd.randint(3, 14))] for _ in range(300)]
groups = {"x": log[:140], "y": log[140:260], "z": log[260:]}
print(json.dumps([analyze(log), compare_groups(groups, k_min=5)], sort_keys=True))
"""


def test_full_output_is_byte_identical_for_different_hash_seeds():
    outs = []
    for seed in ("11", "12", "13"):
        proc = subprocess.run(
            [sys.executable, "-c", _REPRO_SNIPPET],
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "PYTHONHASHSEED": seed},
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        outs.append(proc.stdout)
    assert outs[0] == outs[1] == outs[2]
    json.loads(outs[0])
