"""Golden fixtures (hand-computed) and property tests for the pure analytics."""

from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.analytics import END, START, analyze, compare_groups
from app.analytics.stats import (
    benjamini_hochberg,
    js_distance,
    levenshtein,
    normalized_entropy,
    wilson_interval,
)

LOG = [["A", "B", "C"]] * 4 + [["A", "C"]] * 3 + [["A", "B", "B", "C"]] * 2 + [["B", "C"]] * 1


def test_variants_and_kpis():
    r = analyze(LOG)
    assert r["n"] == 10
    v = r["variants"]
    assert [x["steps"] for x in v] == [
        ["A", "B", "C"],
        ["A", "C"],
        ["A", "B", "B", "C"],
        ["B", "C"],
    ]
    assert [x["count"] for x in v] == [4, 3, 2, 1]
    assert v[-1]["cumulative_share"] == 1.0
    k = r["kpis"]
    assert k["n_variants"] == 4
    assert k["variant_ratio"] == 0.4
    assert k["top_variant_share"] == 0.4
    assert k["coverage_top5"] == 1.0
    assert k["mean_length"] == pytest.approx((4 * 3 + 3 * 2 + 2 * 4 + 2) / 10)
    assert k["start_agreement"] == 0.9
    assert k["end_agreement"] == 1.0


def test_activity_statistics():
    acts = {a["label"]: a for a in analyze(LOG)["activities"]}
    assert acts["A"]["count"] == 9 and acts["A"]["case_count"] == 9
    assert acts["B"]["count"] == 4 + 4 + 1 and acts["B"]["case_count"] == 7
    assert acts["B"]["repeat_traces"] == 2
    assert acts["C"]["count"] == 10 and acts["C"]["end_count"] == 10
    assert acts["A"]["start_count"] == 9 and acts["B"]["start_count"] == 1

    assert acts["B"]["mean_position"] == pytest.approx(19 / 9, abs=1e-5)


def test_dfg_counts_absolute_and_case():
    dfg = analyze(LOG)["dfg"]
    edges = {(e["source"], e["target"]): e for e in dfg["edges"]}
    assert edges[(START, "A")]["count"] == 9
    assert edges[(START, "B")]["count"] == 1
    assert edges[("A", "B")]["count"] == 6 and edges[("A", "B")]["case_count"] == 6
    assert edges[("A", "C")]["count"] == 3
    assert edges[("B", "B")]["count"] == 2 and edges[("B", "B")]["case_count"] == 2
    assert edges[("B", "C")]["count"] == 7
    assert edges[("C", END)]["count"] == 10
    ids = {n["id"] for n in dfg["nodes"]}
    assert {START, END, "A", "B", "C"} == ids
    assert sum(e["count"] for e in dfg["edges"]) == sum(len(t) + 1 for t in LOG)


def test_case_count_differs_from_count_with_repeats():
    r = analyze([["A", "B", "B", "B", "C"], ["A", "C"]])
    edge = next(e for e in r["dfg"]["edges"] if (e["source"], e["target"]) == ("B", "B"))
    assert edge["count"] == 2 and edge["case_count"] == 1


def test_consensus_hotspots_and_strong_edges():
    r = analyze(LOG, min_support=5)
    c = r["consensus"]

    hot = {h["activity"]: h for h in c["hotspots"]}
    assert set(hot) == {"A"}
    a = hot["A"]
    assert a["support"] == 9 and a["disagreement_mass"] == 3
    assert a["dominant_share"] == pytest.approx(6 / 9, abs=1e-5)
    assert [x["target"] for x in a["continuations"]] == ["B", "C"]
    lo, hi = wilson_interval(6, 9)
    assert a["ci_low"] == pytest.approx(lo, abs=1e-5) and a["ci_high"] == pytest.approx(
        hi, abs=1e-5
    )

    strong = {(s["source"], s["target"]) for s in c["strong"]}
    assert ("C", END) in strong
    assert ("A", "B") not in strong
    assert c["low_support"] == []


def test_low_support_activities_are_reported():
    r = analyze(LOG, min_support=10)
    assert r["consensus"]["hotspots"] == []
    assert set(r["consensus"]["low_support"]) == {"A", "B"}


def test_medoid_is_most_central_variant():
    r = analyze(LOG)
    m = r["consensus"]["medoid"]
    assert m["steps"] == ["A", "B", "C"]
    assert 0 <= m["mean_distance"] <= 1

    assert m["mean_distance"] == pytest.approx((3 / 3 + 2 / 4 + 1 / 3) / 10, abs=1e-5)


def test_empty_input():
    r = analyze([])
    assert r["n"] == 0 and r["variants"] == [] and r["consensus"]["medoid"] is None
    assert {n["id"] for n in r["dfg"]["nodes"]} == {START, END}


def test_single_trace():
    r = analyze([["A"]])
    assert r["kpis"]["n_variants"] == 1 and r["kpis"]["coverage_top5"] == 1.0
    assert r["consensus"]["hotspots"] == []


def test_default_min_support_scales_with_n():
    assert analyze([["A", "B"]] * 10)["consensus"]["min_support"] == 5
    assert analyze([["A", "B"]] * 200)["consensus"]["min_support"] == 10


def test_wilson_known_values():
    lo, hi = wilson_interval(8, 10)
    assert lo == pytest.approx(0.4902, abs=1e-3) and hi == pytest.approx(0.9433, abs=1e-3)
    assert wilson_interval(0, 0) == (0.0, 1.0)
    lo, hi = wilson_interval(10, 10)
    assert hi == 1.0 and lo == pytest.approx(0.7225, abs=1e-3)


def test_normalized_entropy():
    assert normalized_entropy([5]) == 0.0
    assert normalized_entropy([5, 5]) == pytest.approx(1.0)
    assert normalized_entropy([1, 1, 1, 1]) == pytest.approx(1.0)
    assert 0 < normalized_entropy([9, 1]) < 1


def test_js_distance_bounds():
    assert js_distance({"a": 1}, {"a": 5}) == 0.0
    assert js_distance({"a": 1}, {"b": 1}) == pytest.approx(1.0)
    d = js_distance({"a": 1, "b": 1}, {"a": 3, "b": 1})
    assert 0 < d < 1


def test_benjamini_hochberg_known_values():
    q = benjamini_hochberg([0.01, 0.04, 0.03, 0.005, None])

    assert q[3] == pytest.approx(0.02) and q[0] == pytest.approx(0.02)
    assert q[2] == pytest.approx(0.04) and q[1] == pytest.approx(0.04)
    assert q[4] is None


def test_levenshtein():
    assert levenshtein([1, 2, 3], [1, 2, 3]) == 0
    assert levenshtein([1, 2, 3], [1, 3]) == 1
    assert levenshtein([], [1, 2]) == 2
    assert levenshtein([1, 2, 3], [3, 2, 1]) == 2


def _groups():
    students = [["Wake up", "Shower", "Coffee", "Leave"]] * 18 + [
        ["Wake up", "Coffee", "Leave"]
    ] * 2
    lecturers = [["Wake up", "Coffee", "Leave"]] * 18 + [
        ["Wake up", "Shower", "Coffee", "Leave"]
    ] * 2
    tiny = [["Wake up", "Leave"]] * 2
    return {"Students": students, "Lecturers": lecturers, "Visitors": tiny}


def test_compare_hides_small_groups_and_finds_differences():
    r = compare_groups(_groups(), k_min=5)
    assert [g["value"] for g in r["groups"]] == ["Lecturers", "Students"]
    assert r["hidden_groups"] == [{"value": "Visitors", "n": 2}]
    assert "small_groups" in r["warnings"]
    assert len(r["pairwise"]) == 1
    pw = r["pairwise"][0]
    assert 0 < pw["js_edges"] <= 1 and 0 < pw["js_variants"] <= 1
    top = r["diff_edges"][0]
    assert top["delta"] == pytest.approx(0.8, abs=1e-6)
    assert top["p_value"] is not None and top["p_value"] < 0.001
    assert top["q_value"] is not None and top["q_value"] >= top["p_value"]


def test_compare_identical_groups_has_zero_distance():
    same = [["A", "B"]] * 10
    r = compare_groups({"x": same, "y": list(same)}, k_min=5)
    assert r["pairwise"][0]["js_edges"] == 0.0 and r["pairwise"][0]["js_variants"] == 0.0
    assert all(e["delta"] == 0 for e in r["diff_edges"])


def test_compare_three_groups_uses_chi_square():
    g = {
        "a": [["A", "B"]] * 10,
        "b": [["A", "C"]] * 10,
        "c": [["A", "B"]] * 5 + [["A", "C"]] * 5,
    }
    r = compare_groups(g, k_min=5)
    edge = next(e for e in r["diff_edges"] if (e["source"], e["target"]) == ("A", "B"))
    assert edge["p_value"] is not None and edge["p_value"] < 0.01


def test_compare_single_group_warning():
    r = compare_groups({"only": [["A", "B"]] * 6}, k_min=5)
    assert "single_group" in r["warnings"] and r["diff_edges"] == [] and r["pairwise"] == []


labels = st.sampled_from(["a", "b", "c", "d", "e"])
trace_st = st.lists(labels, min_size=1, max_size=8)
log_st = st.lists(trace_st, min_size=1, max_size=40)


@settings(max_examples=60, deadline=None)
@given(log_st)
def test_property_invariants(log):
    r = analyze(log, min_support=1)
    n = len(log)
    assert sum(v["count"] for v in r["variants"]) == n
    assert r["variants"][-1]["cumulative_share"] == pytest.approx(1.0, abs=1e-5)
    assert sum(e["count"] for e in r["dfg"]["edges"]) == sum(len(t) + 1 for t in log)
    out_start = sum(e["count"] for e in r["dfg"]["edges"] if e["source"] == START)
    into_end = sum(e["count"] for e in r["dfg"]["edges"] if e["target"] == END)
    assert out_start == n and into_end == n
    for e in r["dfg"]["edges"]:
        assert 1 <= e["case_count"] <= e["count"] <= sum(len(t) + 1 for t in log)
    for h in r["consensus"]["hotspots"]:
        assert 0 <= h["dominant_share"] <= 1 and 0 <= h["entropy_norm"] <= 1
        assert 0 <= h["ci_low"] <= h["dominant_share"] <= h["ci_high"] <= 1
        assert h["disagreement_mass"] == h["support"] - h["continuations"][0]["count"]
    m = r["consensus"]["medoid"]
    assert m is not None and 0 <= m["mean_distance"] <= 1


@settings(max_examples=40, deadline=None)
@given(log_st, st.randoms(use_true_random=False))
def test_property_order_of_traces_is_irrelevant(log, rnd):
    shuffled = list(log)
    rnd.shuffle(shuffled)
    assert analyze(log, min_support=2) == analyze(shuffled, min_support=2)


@settings(max_examples=40, deadline=None)
@given(log_st, log_st)
def test_property_js_distance_symmetric_and_bounded(a, b):
    from app.analytics.core import dfg_counts

    ea, eb = dfg_counts(a)[0], dfg_counts(b)[0]
    d = js_distance(ea, eb)
    assert 0 <= d <= 1 + 1e-9
    assert math.isclose(d, js_distance(eb, ea), abs_tol=1e-12)
