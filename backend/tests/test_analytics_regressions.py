"""Regression tests for defects found in the independent analytics review.

Each test documents a defect (ID in the docstring) that was reproduced before it was fixed.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from itertools import product
from math import comb
from pathlib import Path

import pytest
from scipy import stats as sps

from app.analytics import END, START, analyze, compare_groups
from app.analytics.stats import benjamini_hochberg, js_distance, wilson_interval


def test_a1_reserved_labels_do_not_spoof_virtual_nodes():
    log = [["__start__", "A"], ["A", "__end__"], ["__start__", "__end__"], ["A"]]
    r = analyze(log, min_support=1)
    nodes = r["dfg"]["nodes"]
    ids = [n["id"] for n in nodes]
    assert len(ids) == len(set(ids)), "duplicate node ids break the graph renderer"
    assert [n["kind"] for n in nodes].count("start") == 1
    assert [n["kind"] for n in nodes].count("end") == 1
    edges = r["dfg"]["edges"]

    assert sum(e["count"] for e in edges if e["source"] == START) == len(log)
    assert sum(e["count"] for e in edges if e["target"] == END) == len(log)
    assert sum(e["count"] for e in edges) == sum(len(t) + 1 for t in log)
    acts = {a["label"] for a in r["activities"]}
    assert START not in acts and END not in acts
    assert len(acts) == 3

    assert len({(e["source"], e["target"]) for e in edges}) == len(edges)


def test_a1_escaping_is_injective_and_preserves_ordinary_labels():
    log = [["__start__"], ["\\__start__"], ["start"], ["__start"]] * 3
    r = analyze(log, min_support=1)
    assert {a["label"] for a in r["activities"]} >= {"start", "__start"}
    assert len(r["activities"]) == 4
    assert r["kpis"]["n_variants"] == 4

    plain = analyze([["a", "b"]] * 5)
    assert [a["label"] for a in plain["activities"]] == ["a", "b"]


def test_a1_compare_groups_escapes_reserved_labels_too():
    g1 = [["__start__", "x"]] * 6
    g2 = [["x"]] * 6
    r = compare_groups({"g1": g1, "g2": g2}, k_min=5)
    for edge in r["diff_edges"]:
        assert (edge["source"], edge["target"]) != (START, START)
    sources = {e["source"] for e in r["diff_edges"]}
    targets = {e["target"] for e in r["diff_edges"]}
    assert START in sources and END in targets

    g1_nodes = next(g for g in r["groups"] if g["value"] == "g1")["analytics"]["dfg"]["nodes"]
    assert len({n["id"] for n in g1_nodes}) == len(g1_nodes)


def test_a2_start_node_is_a_consensus_hotspot_when_first_activities_differ():
    log = [["A", "X"]] * 6 + [["B", "X"]] * 4
    c = analyze(log, min_support=5)["consensus"]
    hot = {h["activity"]: h for h in c["hotspots"]}
    assert START in hot
    start = hot[START]
    assert start["support"] == 10 and start["disagreement_mass"] == 4
    assert [x["target"] for x in start["continuations"]] == ["A", "B"]
    assert start["dominant_share"] == pytest.approx(0.6)


def test_a2_strong_consensus_can_start_at_the_virtual_start():
    log = [["A", "X"]] * 30
    c = analyze(log, min_support=5)["consensus"]
    assert (START, "A") in {(s["source"], s["target"]) for s in c["strong"]}


def test_a2_start_is_not_reported_as_low_support_activity():
    c = analyze([["A", "B"]] * 3, min_support=100)["consensus"]
    assert START not in c["low_support"]
    assert set(c["low_support"]) == {"A", "B"}


def _lev(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def _dist(a, b):
    m = max(len(a), len(b))
    return 0.0 if m == 0 else _lev(a, b) / m


def _many_variants_log():

    log = []
    for i in range(160):
        trace = ["s", f"v{i % 17}", f"w{i % 5}", "e"][: 2 + i % 3]
        trace = [*trace, f"u{i}"]
        log.extend([trace] * (1 + (160 - i) // 40))
    return log


def test_a3_medoid_mean_distance_covers_all_traces_when_variants_exceed_cap():
    log = _many_variants_log()
    r = analyze(log)
    assert r["kpis"]["n_variants"] > 120
    m = r["consensus"]["medoid"]
    expected = sum(_dist(m["steps"], t) for t in log) / len(log)
    assert m["mean_distance"] == pytest.approx(expected, abs=1e-6)
    assert m["approximate"] is True


def test_a3_medoid_exact_when_variants_fit_the_cap():
    log = [["A", "B", "C"]] * 4 + [["A", "C"]] * 3 + [["B", "C"]]
    m = analyze(log)["consensus"]["medoid"]
    assert m["approximate"] is False
    assert m["steps"] == ["A", "B", "C"]


def test_a4_empty_traces_are_ignored_instead_of_crashing():
    r = analyze([["A", "B"], [], ["A", "B"]])
    assert r["n"] == 2 and r["kpis"]["n_variants"] == 1
    assert analyze([[], []])["n"] == 0


_JS_SNIPPET = """
import json, random
from app.analytics.stats import js_distance
rnd = random.Random(7)
keys = [f"edge-{i}" for i in range(60)]
p = {k: rnd.randint(1, 50) for k in keys}
q = {k: rnd.randint(1, 50) for k in keys[10:] + [f"x-{i}" for i in range(20)]}
print(repr(js_distance(p, q)))
"""


def test_a5_js_distance_is_bitwise_reproducible_across_hash_seeds():
    outs = set()
    for seed in ("0", "1", "2", "3", "4", "5"):
        proc = subprocess.run(
            [sys.executable, "-c", _JS_SNIPPET],
            capture_output=True,
            text=True,
            check=True,
            env={**os.environ, "PYTHONHASHSEED": seed},
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        outs.add(proc.stdout.strip())
    assert len(outs) == 1, outs


def test_a6_delta_is_rounded_from_exact_shares():
    g = {"a": [["x"]] * 1 + [["y"]] * 2, "b": [["x"]] * 4 + [["y"]] * 3}
    r = compare_groups(g, k_min=1)
    e = next(e for e in r["diff_edges"] if (e["source"], e["target"]) == (START, "x"))
    assert e["delta"] == round(abs(1 / 3 - 4 / 7), 6)


def _ffh_exact(sizes, counts):
    """Brute-force Fisher-Freeman-Halton p-value for a k x 2 table (tiny inputs only)."""
    total = sum(counts)
    n = sum(sizes)
    log_denominator = math.log(comb(n, total))

    def logp(c):
        return sum(math.log(comb(s, x)) for s, x in zip(sizes, c, strict=True)) - log_denominator

    observed = logp(counts)
    p = 0.0
    for c in product(*[range(min(s, total) + 1) for s in sizes]):
        if sum(c) == total:
            lp = logp(c)
            if lp <= observed + 1e-9:
                p += math.exp(lp)
    return min(1.0, p)


def _three_groups_with_rare_edge():

    a = [["A", "B"]] * 8
    b = [["A", "B"]] * 8
    c = [["A", "R", "B"]] * 5 + [["A", "B"]] * 3
    return {"a": a, "b": b, "c": c}


def test_b1_small_expected_counts_do_not_use_chi_square():
    groups = _three_groups_with_rare_edge()
    r = compare_groups(groups, k_min=5)
    edge = next(e for e in r["diff_edges"] if (e["source"], e["target"]) == ("A", "R"))
    exact = _ffh_exact([8, 8, 8], [0, 0, 5])
    chi2 = float(sps.chi2_contingency([[0, 0, 5], [8, 8, 3]]).pvalue)
    assert edge["p_value"] is not None

    assert edge["p_value"] == pytest.approx(exact, rel=0.3)
    assert abs(edge["p_value"] - exact) < abs(chi2 - exact)


def test_b1_three_group_p_values_are_deterministic_and_order_independent():
    groups = _three_groups_with_rare_edge()
    r1 = compare_groups(groups, k_min=5)
    r2 = compare_groups(dict(reversed(list(groups.items()))), k_min=5)
    r3 = compare_groups(groups, k_min=5)
    assert r1 == r2 == r3


def test_b1_chi_square_still_used_when_expected_counts_are_large():
    g = {
        "a": [["A", "B"]] * 30,
        "b": [["A", "C"]] * 30,
        "c": [["A", "B"]] * 15 + [["A", "C"]] * 15,
    }
    r = compare_groups(g, k_min=5)
    edge = next(e for e in r["diff_edges"] if (e["source"], e["target"]) == ("A", "B"))
    ref = float(sps.chi2_contingency([[30, 0, 15], [0, 30, 15]]).pvalue)
    assert edge["p_value"] == pytest.approx(ref, rel=1e-6, abs=1e-12)


def test_b1_edges_without_information_are_outside_the_tested_family():

    g1 = [["A", "B"]] * 9 + [["A", "R", "B"]]
    g2 = [["A", "B"]] * 10
    r = compare_groups({"g1": g1, "g2": g2}, k_min=5)
    by = {(e["source"], e["target"]): e for e in r["diff_edges"]}
    for edge in [(START, "A"), ("B", END)]:
        assert by[edge]["p_value"] is None and by[edge]["q_value"] is None
    for edge in [("A", "R"), ("R", "B")]:
        assert by[edge]["p_value"] is None and by[edge]["q_value"] is None


def test_b1_bh_family_is_the_set_of_informative_edges():
    g1 = [["A", "B", "C"]] * 12 + [["A", "C"]] * 3 + [["A", "D"]] * 5
    g2 = [["A", "B", "C"]] * 4 + [["A", "C"]] * 11 + [["A", "D"]] * 5
    r = compare_groups({"g1": g1, "g2": g2}, k_min=5)
    n1, n2 = len(g1), len(g2)
    ps: dict[tuple[str, str], float] = {}
    for e in r["diff_edges"]:
        c1 = round(e["shares"]["g1"] * n1)
        c2 = round(e["shares"]["g2"] * n2)
        total = c1 + c2
        if min(total, n1 + n2 - total) < 2:
            continue
        ref = float(sps.fisher_exact([[c1, n1 - c1], [c2, n2 - c2]]).pvalue)
        ps[(e["source"], e["target"])] = ref
    keys = sorted(ps)
    q_ref = benjamini_hochberg([ps[k] for k in keys])
    got = {(e["source"], e["target"]): e for e in r["diff_edges"]}
    for k, q in zip(keys, q_ref, strict=True):
        assert got[k]["p_value"] == pytest.approx(ps[k], rel=1e-6, abs=1e-12)
        assert got[k]["q_value"] == pytest.approx(q, rel=1e-6, abs=1e-12)


def test_b2_overlapping_groups_warning():
    g = {"a": [["x", "y"]] * 6, "b": [["x", "y"]] * 6}
    assert "overlapping_groups" not in compare_groups(g, k_min=5)["warnings"]
    assert "overlapping_groups" in compare_groups(g, k_min=5, overlapping=True)["warnings"]


def test_c1_js_distance_known_value_and_bounds():

    assert js_distance({"a": 1}, {"b": 7}) == pytest.approx(1.0, abs=1e-12)

    h_m = -(0.75 * math.log2(0.75) + 0.25 * math.log2(0.25))
    expected = math.sqrt(h_m - (1.0 + 0.0) / 2)
    assert js_distance({"a": 1, "b": 1}, {"a": 5}) == pytest.approx(expected, abs=1e-12)


def test_c1_js_distance_counts_mass_of_keys_present_with_zero_weight_in_the_other_map():

    assert js_distance({"a": 1, "b": 0}, {"a": 0, "b": 1}) == pytest.approx(1.0, abs=1e-12)
    assert js_distance({"a": 0, "b": 2}, {"a": 3, "b": 0}) == pytest.approx(1.0, abs=1e-12)
    assert js_distance({"a": 1, "b": 0}, {"a": 1}) == 0.0


def test_c1_wilson_interval_contains_the_estimate_exactly_even_at_the_boundaries():
    for n in range(1, 120):
        for k in (0, 1, n // 2, n - 1, n):
            lo, hi = wilson_interval(k, n)
            assert lo <= k / n <= hi, (k, n)
    assert wilson_interval(31, 31)[1] == 1.0 and wilson_interval(0, 31)[0] == 0.0


def test_c1_results_are_json_serialisable_without_nan():
    r = compare_groups({"a": [["x"]] * 5, "b": [["y", "x"]] * 7}, k_min=5)
    json.dumps(r, allow_nan=False)
    json.dumps(analyze([["a", "b"]] * 3 + [["c"]]), allow_nan=False)
