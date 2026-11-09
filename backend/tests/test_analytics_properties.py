"""Property-based and statistical sanity tests for the analytics (Hypothesis, fixed seeds)."""

from __future__ import annotations

import json
import math
import random
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.analytics import END, START, analyze, compare_groups
from app.analytics.core import MAX_VARIANTS_RETURNED, MEDOID_MAX_VARIANTS
from app.analytics.stats import benjamini_hochberg, js_distance, wilson_interval
from app.normalize import Alias, resolve_traces

LABELS = ["a", "b", "c", "d", "e", "f", "g"]
label_st = st.sampled_from(LABELS)
trace_st = st.lists(label_st, min_size=1, max_size=12)
log_st = st.lists(trace_st, min_size=1, max_size=50)
SETTINGS = settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow])


def _flatten_ints(obj, out: list[float]) -> None:
    if isinstance(obj, dict):
        for v in obj.values():
            _flatten_ints(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _flatten_ints(v, out)
    elif isinstance(obj, float):
        out.append(obj)


@SETTINGS
@given(log_st, st.integers(1, 6), st.floats(0.05, 1.0))
def test_prop_analyze_invariants(log, min_support, theta):
    r = analyze(log, min_support=min_support, theta=theta)
    n = len(log)
    assert r["n"] == n and r["kpis"]["n"] == n
    assert sum(v["count"] for v in r["variants"]) == n
    shares = [v["cumulative_share"] for v in r["variants"]]
    assert shares == sorted(shares) and shares[-1] == pytest.approx(1.0, abs=1e-5)

    edges = {(e["source"], e["target"]): e for e in r["dfg"]["edges"]}
    assert sum(e["count"] for e in edges.values()) == sum(len(t) + 1 for t in log)
    for e in edges.values():
        assert 1 <= e["case_count"] <= e["count"] and e["case_count"] <= n

    out_flow, in_flow = Counter(), Counter()
    for (s, t), e in edges.items():
        out_flow[s] += e["count"]
        in_flow[t] += e["count"]
    assert out_flow[START] == n and in_flow[END] == n and in_flow[START] == 0 and out_flow[END] == 0
    for act in r["activities"]:
        a = act["label"]
        assert in_flow[a] == out_flow[a] == act["count"]
        assert 1 <= act["case_count"] <= min(act["count"], n)
        assert 1 <= act["mean_position"] <= max(len(t) for t in log)
        assert act["repeat_traces"] <= act["case_count"]
    assert sum(a["start_count"] for a in r["activities"]) == n
    assert sum(a["end_count"] for a in r["activities"]) == n

    c = r["consensus"]
    assert c["min_support"] == min_support and c["theta"] == theta
    for h in c["hotspots"]:
        assert h["support"] >= min_support and h["dominant_share"] < theta
        assert 0 <= h["ci_low"] <= h["dominant_share"] <= h["ci_high"] <= 1
        assert 0 <= h["entropy_norm"] <= 1
        assert sum(x["count"] for x in h["continuations"]) == h["support"]
        assert sum(x["share"] for x in h["continuations"]) == pytest.approx(1.0, abs=1e-5)
        top = h["continuations"][0]["count"]
        assert h["disagreement_mass"] == h["support"] - top > 0
        assert top == max(x["count"] for x in h["continuations"])
    masses = [h["disagreement_mass"] for h in c["hotspots"]]
    assert masses == sorted(masses, reverse=True)
    for s in c["strong"]:
        assert s["support"] >= min_support and s["ci_low"] >= theta - 1e-6
        assert s["ci_low"] <= s["share"] <= s["ci_high"]
    flagged = {h["activity"] for h in c["hotspots"]} | {s["source"] for s in c["strong"]}
    assert flagged.isdisjoint(c["low_support"])
    for a in c["low_support"]:
        assert out_flow[a] < min_support
    m = c["medoid"]
    assert tuple(m["steps"]) in {tuple(v["steps"]) for v in r["variants"]}
    assert 0 <= m["mean_distance"] <= 1 and (r["kpis"]["n_variants"] > 1 or m["mean_distance"] == 0)
    floats: list[float] = []
    _flatten_ints(r, floats)
    assert all(math.isfinite(x) for x in floats)
    json.dumps(r, allow_nan=False)


@SETTINGS
@given(log_st, st.randoms(use_true_random=False))
def test_prop_analyze_is_invariant_under_trace_order(log, rnd):
    shuffled = list(log)
    rnd.shuffle(shuffled)
    assert analyze(log) == analyze(shuffled)


@SETTINGS
@given(st.lists(log_st, min_size=2, max_size=4), st.randoms(use_true_random=False))
def test_prop_compare_is_invariant_under_group_and_trace_order(logs, rnd):
    groups = {f"g{i}": log for i, log in enumerate(logs)}
    base = compare_groups(groups, k_min=1)
    items = list(groups.items())
    rnd.shuffle(items)
    shuffled = {g: rnd.sample(t, len(t)) for g, t in items}
    assert compare_groups(shuffled, k_min=1) == base
    json.dumps(base, allow_nan=False)


@SETTINGS
@given(st.lists(log_st, min_size=2, max_size=4))
def test_prop_compare_invariants(logs):
    groups = {f"g{i}": log for i, log in enumerate(logs)}
    r = compare_groups(groups, k_min=1)
    names = [g["value"] for g in r["groups"]]
    assert names == sorted(names, key=lambda g: (-len(groups[g]), g))
    k = len(logs)
    assert len(r["pairwise"]) == k * (k - 1) // 2
    for pw in r["pairwise"]:
        assert 0 <= pw["js_edges"] <= 1 and 0 <= pw["js_variants"] <= 1
    sizes = {g: len(t) for g, t in groups.items()}
    union = set()
    for g in r["groups"]:
        union |= {(e["source"], e["target"]) for e in g["analytics"]["dfg"]["edges"]}
    assert {(e["source"], e["target"]) for e in r["diff_edges"]} == union
    qs = []
    for e in r["diff_edges"]:
        assert 0 <= e["delta"] <= 1
        assert e["delta"] == pytest.approx(
            max(e["shares"].values()) - min(e["shares"].values()), abs=2e-6
        )
        for g, share in e["shares"].items():
            assert 0 <= share <= 1 and share * sizes[g] == pytest.approx(
                round(share * sizes[g]), abs=1e-4
            )
        if e["p_value"] is not None:
            assert 0 <= e["p_value"] <= 1 and e["p_value"] <= e["q_value"] <= 1
            qs.append(e)
        else:
            assert e["q_value"] is None
    deltas = [e["delta"] for e in r["diff_edges"]]
    assert deltas == sorted(deltas, reverse=True)

    qs.sort(key=lambda e: e["p_value"])
    assert [e["q_value"] for e in qs] == sorted(e["q_value"] for e in qs)


@SETTINGS
@given(
    log_st,
    st.dictionaries(label_st, st.sampled_from(["X", "Y", "Z"]), max_size=5),
)
def test_prop_alias_merge_only_changes_labels(log, merge):
    aliases = {k: Alias(canonical=v) for k, v in merge.items()}
    traces, _display = resolve_traces(log, aliases)
    expected = [[merge.get(a, a) for a in t] for t in log]
    assert traces == expected
    before, after = analyze(log, min_support=1), analyze(traces, min_support=1)
    assert after["n"] == before["n"]
    assert after["kpis"]["mean_length"] == before["kpis"]["mean_length"]
    assert after["kpis"]["n_variants"] <= before["kpis"]["n_variants"]
    assert sum(e["count"] for e in after["dfg"]["edges"]) == sum(
        e["count"] for e in before["dfg"]["edges"]
    )
    assert len(after["activities"]) <= len(before["activities"])


@SETTINGS
@given(log_st, st.sets(label_st, max_size=3))
def test_prop_hiding_labels_never_adds_steps(log, hidden):
    aliases = {k: Alias(hidden=True) for k in hidden}
    traces, _ = resolve_traces(log, aliases)
    assert traces == [t for t in ([a for a in tr if a not in hidden] for tr in log) if t]


@settings(max_examples=100, deadline=None)
@given(st.integers(1, 400), st.data())
def test_prop_wilson_monotone_symmetric_and_containing(n, data):
    k = data.draw(st.integers(0, n))
    lo, hi = wilson_interval(k, n)
    assert 0 <= lo <= k / n <= hi <= 1
    assert lo < hi
    if k < n:
        lo2, hi2 = wilson_interval(k + 1, n)
        assert lo <= lo2 and hi <= hi2
    mlo, mhi = wilson_interval(n - k, n)
    assert (1 - hi, 1 - lo) == pytest.approx((mlo, mhi), abs=1e-12)
    wlo, whi = wilson_interval(2 * k, 2 * n)
    assert (whi - wlo) < (hi - lo) + 1e-12


@settings(max_examples=100, deadline=None)
@given(
    st.lists(st.one_of(st.none(), st.floats(0.0, 1.0)), max_size=30),
)
def test_prop_benjamini_hochberg(ps):
    qs = benjamini_hochberg(ps)
    assert [q is None for q in qs] == [p is None for p in ps]
    pairs = sorted((p, q) for p, q in zip(ps, qs, strict=True) if p is not None and q is not None)
    assert all(q >= p - 1e-12 and q <= 1 for p, q in pairs)
    assert [q for _, q in pairs] == sorted(q for _, q in pairs)


@settings(max_examples=100, deadline=None)
@given(
    st.dictionaries(st.integers(0, 8), st.integers(0, 9), min_size=1, max_size=9),
    st.dictionaries(st.integers(0, 8), st.integers(0, 9), min_size=1, max_size=9),
)
def test_prop_js_distance(p, q):
    if sum(p.values()) == 0 or sum(q.values()) == 0:
        return
    d = js_distance(p, q)
    assert 0 <= d <= 1
    assert d == js_distance(q, p)
    assert js_distance(p, p) == 0.0
    sp, sq = sum(p.values()), sum(q.values())
    equal = all(p.get(k, 0) * sq == q.get(k, 0) * sp for k in set(p) | set(q))
    assert (d < 1e-7) == equal
    disjoint = all(p.get(k, 0) == 0 or q.get(k, 0) == 0 for k in set(p) | set(q))
    assert (d == pytest.approx(1.0, abs=1e-12)) == disjoint


def _markov_log(seed: int, n: int) -> list[list[str]]:
    rnd = random.Random(seed)
    acts = ["A", "B", "C", "D", "E", "F"]
    weights = {a: [rnd.random() ** 2 + 0.05 for _ in acts] for a in acts}
    log = []
    for _ in range(n):
        a = rnd.choice(acts[:2])
        trace = [a]
        for _ in range(rnd.randint(2, 7)):
            a = rnd.choices(acts, weights[a])[0]
            trace.append(a)
        log.append(trace)
    return log


@pytest.mark.parametrize("n_groups", [2, 3])
def test_random_splits_of_the_same_log_rarely_show_significant_edges(n_groups):
    base = _markov_log(1, 240)
    splits_with_hit = 0
    informative_p: list[float] = []
    runs = 40
    for seed in range(runs):
        rnd = random.Random(1000 + seed)
        shuffled = rnd.sample(base, len(base))
        size = len(base) // n_groups
        groups = {f"g{i}": shuffled[i * size : (i + 1) * size] for i in range(n_groups)}
        r = compare_groups(groups, k_min=5)
        ps = [e["p_value"] for e in r["diff_edges"] if e["p_value"] is not None]
        qs = [e["q_value"] for e in r["diff_edges"] if e["q_value"] is not None]
        informative_p += ps
        splits_with_hit += any(q < 0.05 for q in qs)

    assert splits_with_hit <= 7

    assert sum(p < 0.05 for p in informative_p) / len(informative_p) <= 0.075
    assert sum(p < 0.01 for p in informative_p) / len(informative_p) <= 0.02


@pytest.mark.parametrize("n_groups", [2, 4])
def test_planted_group_difference_is_detected(n_groups):
    rnd = random.Random(5)
    common = [["A", "B", "C"] if rnd.random() < 0.5 else ["A", "C"] for _ in range(60 * n_groups)]
    groups = {f"g{i}": common[i * 60 : (i + 1) * 60] for i in range(n_groups)}
    groups["g0"] = [["A", "X", "C"] if rnd.random() < 0.6 else t for t in groups["g0"]]
    r = compare_groups(groups, k_min=5)
    edge = next(e for e in r["diff_edges"] if (e["source"], e["target"]) == ("A", "X"))
    assert edge["q_value"] is not None and edge["q_value"] < 0.001 and edge["delta"] > 0.4


def test_all_identical_traces():
    r = analyze([["a", "b", "c"]] * 40)
    assert r["kpis"]["n_variants"] == 1 and r["kpis"]["variant_ratio"] == pytest.approx(1 / 40)
    assert r["kpis"]["top_variant_share"] == 1.0 and r["kpis"]["coverage_top5"] == 1.0
    assert r["kpis"]["start_agreement"] == r["kpis"]["end_agreement"] == 1.0
    assert r["consensus"]["hotspots"] == [] and len(r["consensus"]["strong"]) == 4
    assert r["consensus"]["medoid"] == {
        "steps": ["a", "b", "c"],
        "mean_distance": 0.0,
        "approximate": False,
    }
    assert all(e["case_count"] == e["count"] == 40 for e in r["dfg"]["edges"])


def test_single_trace_and_length_one_traces():
    r = analyze([["x"]])
    assert r["n"] == 1 and r["kpis"]["mean_length"] == 1.0
    assert {(e["source"], e["target"]) for e in r["dfg"]["edges"]} == {(START, "x"), ("x", END)}
    assert r["consensus"]["medoid"]["steps"] == ["x"]
    r = analyze([["a"], ["b"], ["a"]] * 5, min_support=1)
    assert r["kpis"]["n_variants"] == 2 and r["consensus"]["medoid"]["steps"] == ["a"]
    assert r["activities"][0]["mean_position"] == 1.0
    hot = {h["activity"] for h in r["consensus"]["hotspots"]}
    assert hot == {START}


def test_very_long_traces():
    log = [[f"s{i % 7}" for i in range(50)]] * 3 + [[f"s{i % 5}" for i in range(50)]] * 2
    r = analyze(log, min_support=1)
    assert r["kpis"]["mean_length"] == 50.0
    assert sum(e["count"] for e in r["dfg"]["edges"]) == 5 * 51
    assert 0 < r["consensus"]["medoid"]["mean_distance"] < 1


def test_many_variants_are_capped_with_correct_cumulative_share():
    rnd = random.Random(7)
    log = [[rnd.choice("abcdefgh") for _ in range(rnd.randint(8, 14))] for _ in range(1500)]
    r = analyze(log)
    assert r["kpis"]["n_variants"] > MAX_VARIANTS_RETURNED
    assert len(r["variants"]) == MAX_VARIANTS_RETURNED
    counts = [v["count"] for v in r["variants"]]
    assert counts == sorted(counts, reverse=True)
    last = r["variants"][-1]
    assert last["cumulative_share"] == pytest.approx(sum(counts) / 1500, abs=1e-6)
    assert last["cumulative_share"] < 1
    assert r["kpis"]["variant_ratio"] == pytest.approx(r["kpis"]["n_variants"] / 1500, abs=1e-6)
    assert r["consensus"]["medoid"]["approximate"] is True


def test_huge_alphabet():
    rnd = random.Random(8)
    log = [
        [f"activity {rnd.randrange(600)}" for _ in range(rnd.randint(3, 12))] for _ in range(400)
    ]
    r = analyze(log)
    assert len(r["activities"]) > 400
    assert len(r["dfg"]["nodes"]) == len(r["activities"]) + 2
    assert sum(len(c) for c in [r["consensus"]["low_support"]]) > 0
    json.dumps(r, allow_nan=False)


def test_unicode_labels():
    labels = ["café", "コーヒー", "قهوة", "\U0001f642", "naïve"]
    log = [[labels[i % 5], labels[(i + 1) % 5]] for i in range(30)]
    r = analyze(log)
    assert {a["label"] for a in r["activities"]} == set(labels)
    json.dumps(r, ensure_ascii=False, allow_nan=False).encode("utf-8")


def test_medoid_is_deterministic_beyond_the_candidate_cap():
    rnd = random.Random(21)
    base = [[rnd.choice("abcdef") for _ in range(rnd.randint(4, 9))] for _ in range(400)]
    first = analyze(base)["consensus"]["medoid"]
    assert first["approximate"]
    assert analyze(list(reversed(base)))["consensus"]["medoid"] == first
    assert analyze(random.Random(1).sample(base, len(base)))["consensus"]["medoid"] == first


def test_medoid_candidate_cut_among_equally_frequent_variants_is_not_alphabetical():
    from app.analytics.core import _medoid_candidates

    frequent = [((f"top{i}",), 5) for i in range(20)]
    singles = sorted(((f"s{i:03d}", "x"), 1) for i in range(300))
    ordered = sorted(frequent + singles, key=lambda kv: (-kv[1], kv[0]))
    cand = _medoid_candidates(ordered)
    assert len(cand) == MEDOID_MAX_VARIANTS
    assert all(kv in cand for kv in frequent)
    chosen = sorted(kv[0] for kv in cand if kv[1] == 1)
    alphabetical_prefix = [kv[0] for kv in singles[: len(chosen)]]
    assert chosen != alphabetical_prefix and chosen[-1] > alphabetical_prefix[-1]
    assert _medoid_candidates(list(ordered)) == cand


def test_pure_functions_give_identical_results_when_called_from_many_threads():
    rnd = random.Random(33)
    logs = [
        [[f"x{rnd.randrange(12)}" for _ in range(rnd.randint(2, 9))] for _ in range(150)]
        for _ in range(6)
    ]
    groups = [{"a": log[:70], "b": log[70:], "c": log[::2]} for log in logs]
    expected = [
        (analyze(log), compare_groups(g, k_min=5)) for log, g in zip(logs, groups, strict=True)
    ]

    def work(i: int):
        j = i % len(logs)
        return j, analyze(logs[j]), compare_groups(groups[j], k_min=5)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(work, range(48)))
    for j, a, c in results:
        assert (a, c) == expected[j]
