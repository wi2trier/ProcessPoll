"""Cross-check our variants/DFG/XES against PM4Py (AGPL-3.0-or-later; test oracle only)."""

from __future__ import annotations

import random

import pytest
from conftest import create_host

from app.analytics import END, START, analyze

pm4py = pytest.importorskip("pm4py")
pd = pytest.importorskip("pandas")

API = "/api/v1"


def random_log(seed: int, n: int = 60) -> list[list[str]]:
    rnd = random.Random(seed)
    alphabet = ["a", "b", "c", "d", "e", "f"]
    return [[rnd.choice(alphabet) for _ in range(rnd.randint(1, 9))] for _ in range(n)]


def to_dataframe(log: list[list[str]]):
    rows = []
    for i, trace in enumerate(log):
        for j, act in enumerate(trace):
            rows.append(
                {
                    "case:concept:name": f"c{i}",
                    "concept:name": act,
                    "time:timestamp": pd.Timestamp("2026-01-01", tz="UTC")
                    + pd.Timedelta(seconds=j),
                }
            )
    return pm4py.format_dataframe(pd.DataFrame(rows))


@pytest.mark.parametrize("seed", range(5))
def test_variants_and_dfg_match_pm4py(seed):
    log = random_log(seed)
    df = to_dataframe(log)
    ours = analyze(log, min_support=1)

    pm_variants = pm4py.get_variants(df)
    expected = {tuple(k): v for k, v in pm_variants.items()}
    got = {tuple(v["steps"]): v["count"] for v in ours["variants"]}
    assert got == expected

    dfg, start, end = pm4py.discover_dfg(df)[:3]
    our_edges = {
        (e["source"], e["target"]): e["count"]
        for e in ours["dfg"]["edges"]
        if e["source"] != START and e["target"] != END
    }
    assert our_edges == {tuple(k): v for k, v in dfg.items()}
    assert {e["target"]: e["count"] for e in ours["dfg"]["edges"] if e["source"] == START} == dict(
        start
    )
    assert {e["source"]: e["count"] for e in ours["dfg"]["edges"] if e["target"] == END} == dict(
        end
    )


async def test_xes_export_roundtrips_through_pm4py(client, tmp_path):
    host = await create_host(client)
    log = random_log(99, n=15)
    for i, steps in enumerate(log):
        r = await host.submit(
            steps[:10] if len(steps) > 1 else [*steps, "z"], role="Student" if i % 2 else "Lecturer"
        )
        assert r.status_code == 201, r.text
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "xes"}, headers=host.headers
    )
    path = tmp_path / "export.xes"
    path.write_bytes(r.content)
    imported = pm4py.read_xes(str(path), return_legacy_log_object=True)
    assert len(imported) == 15
    assert all("Role" in t.attributes for t in imported)
    variants = pm4py.get_variants(pm4py.convert_to_dataframe(imported))
    ours = analyze(
        [steps[:10] if len(steps) > 1 else [*steps, "z"] for steps in log], min_support=1
    )
    assert {tuple(k): v for k, v in variants.items()} == {
        tuple(v["steps"]): v["count"] for v in ours["variants"]
    }


def varied_log(seed: int) -> list[list[str]]:
    """Mix of short and very long traces over a larger alphabet (with repetitions)."""
    rnd = random.Random(seed)
    alphabet = [f"act {i}" for i in range(25)]
    log = []
    for _ in range(80):
        length = rnd.choice([1, 2, 3, 5, 8, 13, 50])
        log.append([rnd.choice(alphabet[: rnd.choice([3, 8, 25])]) for _ in range(length)])
    return log


@pytest.mark.parametrize("seed", range(5, 10))
def test_activity_statistics_start_end_and_kpis_match_pm4py_and_pandas(seed):
    log = varied_log(seed)
    df = to_dataframe(log)
    ours = analyze(log, min_support=1)
    n = len(log)

    pm_start = pm4py.get_start_activities(df)
    pm_end = pm4py.get_end_activities(df)
    acts = {a["label"]: a for a in ours["activities"]}
    assert {a: v["start_count"] for a, v in acts.items() if v["start_count"]} == dict(pm_start)
    assert {a: v["end_count"] for a, v in acts.items() if v["end_count"]} == dict(pm_end)
    assert ours["kpis"]["start_agreement"] == pytest.approx(max(pm_start.values()) / n, abs=1e-6)
    assert ours["kpis"]["end_agreement"] == pytest.approx(max(pm_end.values()) / n, abs=1e-6)

    assert {a: v["count"] for a, v in acts.items()} == df["concept:name"].value_counts().to_dict()
    case_counts = df.groupby("concept:name")["case:concept:name"].nunique().to_dict()
    assert {a: v["case_count"] for a, v in acts.items()} == case_counts
    per_case = df.groupby(["concept:name", "case:concept:name"]).size()
    repeats = (per_case > 1).groupby(level="concept:name").sum().to_dict()
    assert {a: v["repeat_traces"] for a, v in acts.items()} == repeats
    df = df.assign(position=df.groupby("case:concept:name").cumcount() + 1)
    mean_pos = df.groupby("concept:name")["position"].mean().to_dict()
    for a, v in acts.items():
        assert v["mean_position"] == pytest.approx(mean_pos[a], abs=1e-6)
    sizes = df.groupby("case:concept:name").size()
    assert ours["kpis"]["mean_length"] == pytest.approx(sizes.mean(), abs=1e-6)
    assert ours["n"] == df["case:concept:name"].nunique() == n


@pytest.mark.parametrize("seed", range(5, 10))
def test_variants_dfg_and_case_dfg_match_pm4py_on_long_varied_logs(seed):
    log = varied_log(seed)
    df = to_dataframe(log)
    ours = analyze(log, min_support=1)

    variants = {tuple(k): v for k, v in pm4py.get_variants(df).items()}
    assert {tuple(v["steps"]): v["count"] for v in ours["variants"]} == variants
    dfg, start, end = pm4py.discover_dfg(df)[:3]
    ours_edges = {(e["source"], e["target"]): e for e in ours["dfg"]["edges"]}
    inner = {k: e["count"] for k, e in ours_edges.items() if START not in k and END not in k}
    assert inner == {tuple(k): v for k, v in dfg.items()}
    assert {t: e["count"] for (s, t), e in ours_edges.items() if s == START} == dict(start)
    assert {s: e["count"] for (s, t), e in ours_edges.items() if t == END} == dict(end)

    case_dfg: dict[tuple[str, str], int] = {}
    for steps, count in variants.items():
        for pair in {(steps[i], steps[i + 1]) for i in range(len(steps) - 1)}:
            case_dfg[pair] = case_dfg.get(pair, 0) + count
    assert {
        k: e["case_count"] for k, e in ours_edges.items() if START not in k and END not in k
    } == case_dfg
    assert all(e["case_count"] <= e["count"] for e in ours_edges.values())


def test_group_logs_agree_with_pm4py_per_group():
    log = varied_log(11)
    groups = {"x": log[:30], "y": log[30:55], "z": log[55:]}
    from app.analytics import compare_groups

    result = compare_groups(groups, k_min=5)
    for g in result["groups"]:
        df = to_dataframe(groups[g["value"]])
        variants = {tuple(k): v for k, v in pm4py.get_variants(df).items()}
        assert {tuple(v["steps"]): v["count"] for v in g["analytics"]["variants"]} == variants
        dfg = pm4py.discover_dfg(df)[0]
        got = {
            (e["source"], e["target"]): e["count"]
            for e in g["analytics"]["dfg"]["edges"]
            if e["source"] != START and e["target"] != END
        }
        assert got == {tuple(k): v for k, v in dfg.items()}
