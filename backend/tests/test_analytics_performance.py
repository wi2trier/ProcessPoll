"""Performance guards for the analytics hot paths.

The budgets are 5-10x the measured times on a developer laptop (see the review notes); they only
exist to catch accidental return of quadratic behaviour (per-step normalisation, scipy per edge,
quadratic difflib, interpreted Levenshtein), not to benchmark.
"""

from __future__ import annotations

import random
import time

from app import analytics_service as asvc
from app.analytics import analyze, compare_groups
from app.normalize import resolve_traces

WORDS = [
    *("check", "read", "send", "write", "ask", "call", "plan", "wait", "review", "approve"),
    *("reject", "open", "close", "print", "scan", "file", "sort", "merge", "mail", "report"),
    *("budget", "invoice", "ticket", "customer", "order", "boss", "team", "lunch", "coffee"),
]


def free_text_log(n: int, steps: tuple[int, int], n_labels: int, seed: int) -> list[list[str]]:
    """Zipf-distributed labels with spelling noise: hundreds of distinct labels, many rare edges."""
    rnd = random.Random(seed)
    vocab = list(
        dict.fromkeys(
            " ".join(rnd.choice(WORDS) for _ in range(rnd.randint(1, 3))) + f" {i % 7}"
            for i in range(n_labels)
        )
    )
    weights = [1 / (i + 1) for i in range(len(vocab))]
    log = []
    for _ in range(n):
        trace = []
        for _ in range(rnd.randint(*steps)):
            label = rnd.choices(vocab, weights)[0]
            r = rnd.random()
            trace.append(label.upper() if r < 0.15 else label + "!" if r < 0.25 else label)
        log.append(trace)
    return log


def timed(fn, *args, **kwargs):
    start = time.perf_counter()
    result = fn(*args, **kwargs)
    return time.perf_counter() - start, result


RAW = free_text_log(2000, (10, 30), 400, seed=1)


def test_resolve_2000_traces_with_free_text_noise_is_fast():
    elapsed, (traces, display) = timed(resolve_traces, RAW)
    assert len(traces) == 2000 and len(display) > 100
    assert elapsed < 1.0, elapsed


def test_analyze_2000_traces_including_the_medoid_is_fast():
    traces, _ = resolve_traces(RAW)
    elapsed, result = timed(analyze, traces)
    assert result["consensus"]["medoid"]["approximate"]
    assert elapsed < 2.0, elapsed


def test_compare_two_and_six_groups_on_2000_free_text_traces_is_fast():
    traces, _ = resolve_traces(RAW)
    for k, budget in ((2, 3.0), (6, 6.0)):
        groups = {f"g{i}": traces[i::k] for i in range(k)}
        elapsed, result = timed(compare_groups, groups, k_min=5)
        assert len(result["groups"]) == k and result["diff_edges"]
        assert elapsed < budget, (
            k,
            elapsed,
        )


def test_merge_suggestions_for_the_300_most_frequent_labels_is_fast():
    rows = asvc.label_rows(RAW, {})
    assert len(rows) > 300
    elapsed, _ = timed(asvc.merge_suggestions, rows)
    assert elapsed < 2.0, elapsed
    elapsed, _ = timed(asvc.label_rows, RAW, {})
    assert elapsed < 1.0, elapsed
