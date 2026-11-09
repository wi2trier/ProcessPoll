"""Unit and API level tests for the glue code in app.analytics_service."""

from __future__ import annotations

import difflib
import random
import re
from typing import Any

import pytest
from conftest import create_host

from app import analytics_service as asvc
from app.analytics import START

API = "/api/v1"


def test_bin_labels_are_distinct_for_close_and_large_boundaries():
    bins = [1234567.0, 1234568.0, 2500000.0]
    labels = {asvc.bin_label(v, bins) for v in (1.0, 1234567.5, 1234568.5, 3000000.0)}
    assert len(labels) == 4
    assert all("e+" not in label for label in labels)
    assert asvc.bin_label(5, [5, 10]) == "5–10"
    assert asvc.bin_label(0.1 + 0.2, [0.3, 1]) == "0.3–1"


def _rows(keys_and_counts: list[tuple[str, int]]) -> list[dict[str, Any]]:
    return [
        {"raw_key": k, "display": k.capitalize(), "count": c, "canonical": None, "hidden": False}
        for k, c in keys_and_counts
    ]


def _reference_compatible(a: str, b: str) -> bool:
    """Labels that differ only in a number or in a single letter are different on purpose."""
    if re.findall(r"\d+", a) != re.findall(r"\d+", b):
        return False
    ta, tb = a.split(), b.split()
    if len(ta) == len(tb):
        diff = [(x, y) for x, y in zip(ta, tb, strict=True) if x != y]
        if diff and all(len(x) == 1 and len(y) == 1 for x, y in diff):
            return False
    return True


def _reference_suggestions(rows, threshold=0.82, limit=300):
    """Straightforward O(n^2) re-implementation (no pruning, no caching)."""
    cand = [r for r in rows if not r["hidden"] and not r["canonical"]][:limit]
    n = len(cand)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    sims = {}
    for i in range(n):
        for j in range(i + 1, n):
            a, b = cand[i]["raw_key"], cand[j]["raw_key"]
            if not _reference_compatible(a, b):
                continue
            ratio = (
                1.0
                if sorted(a.split()) == sorted(b.split())
                else difflib.SequenceMatcher(None, a, b).ratio()
            )
            if ratio >= threshold:
                sims[(i, j)] = ratio
                parent[find(i)] = find(j)
    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    out = []
    for members in clusters.values():
        if len(members) < 2:
            continue
        ms = set(members)
        pair_sims = [s for (i, j), s in sims.items() if i in ms and j in ms]
        best = max(members, key=lambda i: (cand[i]["count"], cand[i]["display"]))
        out.append(
            {
                "raw_keys": [
                    cand[i]["raw_key"] for i in sorted(members, key=lambda i: -cand[i]["count"])
                ],
                "similarity": round(min(pair_sims) if pair_sims else 1.0, 4),
                "proposed_canonical": cand[best]["display"],
            }
        )
    out.sort(key=lambda s: (-len(s["raw_keys"]), -s["similarity"], s["raw_keys"][0]))
    return out


def test_merge_suggestions_cluster_spelling_variants():
    rows = _rows([("check mail", 5), ("check email", 4), ("check mails", 1), ("shower", 9)])
    out = asvc.merge_suggestions(rows)
    assert len(out) == 1
    assert set(out[0]["raw_keys"]) == {"check mail", "check email", "check mails"}
    assert out[0]["proposed_canonical"] == "Check mail"


def test_merge_suggestions_do_not_merge_labels_that_differ_in_numbers_or_letters():
    rows = _rows([("step 1", 5), ("step 2", 4), ("step 3", 3), ("phase 1.1", 2), ("phase 1.2", 2)])
    assert asvc.merge_suggestions(rows) == []

    rows = _rows([("step 1 done", 5), ("step 1 doen", 4)])
    assert len(asvc.merge_suggestions(rows)) == 1


def test_merge_suggestions_token_permutations_are_suggested():
    out = asvc.merge_suggestions(_rows([("mail check", 3), ("check mail", 5)]))
    assert out and out[0]["similarity"] == 1.0


@pytest.mark.parametrize("seed", range(6))
def test_merge_suggestions_match_the_naive_reference(seed):
    rnd = random.Random(seed)
    stems = ["check mail", "read email", "send report", "ask boss", "wait", "plan day", "coffee"]
    keys: set[str] = set()
    while len(keys) < 70:
        s = rnd.choice(stems)
        chars = list(s)
        for _ in range(rnd.randint(0, 3)):
            op = rnd.choice("ids")
            pos = rnd.randrange(len(chars)) if chars else 0
            if op == "i":
                chars.insert(pos, rnd.choice("abcde "))
            elif op == "d" and chars:
                del chars[pos]
            elif chars:
                chars[pos] = rnd.choice("abcde")
        key = " ".join("".join(chars).split())
        if key:
            keys.add(key)
    rows = _rows([(k, rnd.randint(1, 30)) for k in sorted(keys)])
    rows.sort(key=lambda r: (-r["count"], r["raw_key"]))
    assert asvc.merge_suggestions(rows) == _reference_suggestions(rows)


def test_merge_suggestions_skip_moderated_rows_and_respect_limit():
    rows = _rows([("check mail", 5), ("check email", 4)])
    rows[1]["canonical"] = "Check mail"
    assert asvc.merge_suggestions(rows) == []
    rows = _rows([("check mail", 5), ("check email", 4)])
    assert asvc.merge_suggestions(rows, limit=1) == []


def test_label_rows_count_and_display_are_alias_independent():
    from app.normalize import Alias

    rows = asvc.label_rows(
        [["Coffee", "coffee!"], ["COFFEE", "Tea"], ["..."]], {"tea": Alias(canonical="Drink")}
    )
    by = {r["raw_key"]: r for r in rows}
    assert by["coffee"]["count"] == 3 and by["coffee"]["display"] == "COFFEE"
    assert by["tea"]["canonical"] == "Drink" and "" not in by


def test_dataset_label_counts_equal_the_per_step_normalisation():
    from collections import Counter

    from app.normalize import Alias, normalize_key, resolve_steps

    raw = [["Check mail", "check mail!", "Coffee"], ["COFFEE", "read emails"], ["um", "Tea"]]
    aliases = {"read emails": Alias(canonical="Check mail"), "um": Alias(hidden=True)}
    resolved, display = resolve_steps(raw, aliases)
    ds = asvc.Dataset([], resolved, display)
    expected = Counter(normalize_key(f) for t in ds.traces() for f in t)
    assert ds.label_counts() == expected == Counter({"check mail": 3, "coffee": 2, "tea": 1})
    assert set(ds.label_counts()) == set(display)


async def test_participants_cannot_spoof_the_virtual_nodes_through_labels(client):
    host = await create_host(client)
    for steps in (["__start__", "Coffee"], ["Shower", "__end__"], ["Shower", "Coffee"]):
        assert (await host.submit(steps)).status_code == 201
    r = await client.get(
        f"{API}/sessions/{host.code}/analytics",
        params={"question_id": host.trace_id},
        headers=host.headers,
    )
    assert r.status_code == 200
    a = r.json()
    ids = [n["id"] for n in a["dfg"]["nodes"]]
    assert len(ids) == len(set(ids))
    assert sum(e["count"] for e in a["dfg"]["edges"] if e["source"] == START) == 3


async def test_lone_surrogate_in_a_label_cannot_break_the_dashboard_json(client):
    """A label with an unpaired surrogate is not encodable as UTF-8; if it were stored, every
    analytics response of the session would fail with a 500."""
    host = await create_host(client)
    token = await host.participant()
    body = (
        '{"answers":[{"question_id":"' + host.trace_id + '","value":{"steps":["a\\ud800","b"]}}]}'
    ).encode()
    r = await client.post(
        f"{API}/sessions/{host.code}/responses",
        content=body,
        headers={"X-Participant-Token": token, "Content-Type": "application/json"},
    )
    assert r.status_code in (201, 422)
    for path, params in (
        ("analytics", {"question_id": host.trace_id}),
        ("labels", {"question_id": host.trace_id}),
    ):
        got = await client.get(
            f"{API}/sessions/{host.code}/{path}", params=params, headers=host.headers
        )
        assert got.status_code == 200
        got.content.decode("utf-8")
    exported = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "csv"}, headers=host.headers
    )
    assert exported.status_code == 200


async def test_compare_by_multiple_choice_warns_about_overlapping_groups(client):
    qs = [
        {"type": "trace", "prompt": "T", "config": {"min_steps": 1}},
        {
            "type": "multiple_choice",
            "prompt": "Tools",
            "required": False,
            "config": {"options": ["A", "B"]},
        },
    ]
    host = await create_host(client, questions=qs, settings={"k_min": 1})
    ids = {q["prompt"]: q["id"] for q in host.session["questions"]}

    async def submit(steps, tools):
        token = await host.participant()
        answers = [
            {"question_id": ids["T"], "value": {"steps": steps}},
            {"question_id": ids["Tools"], "value": {"values": tools}},
        ]
        r = await client.post(
            f"{API}/sessions/{host.code}/responses",
            json={"answers": answers},
            headers={"X-Participant-Token": token},
        )
        assert r.status_code == 201, r.text

    async def compare():
        r = await client.get(
            f"{API}/sessions/{host.code}/compare",
            params={"question_id": ids["T"], "group_by": ids["Tools"]},
            headers=host.headers,
        )
        assert r.status_code == 200
        return r.json()

    await submit(["a"], ["A"])
    await submit(["b"], ["B"])
    assert "overlapping_groups" not in (await compare())["warnings"]
    await submit(["a"], ["A", "B"])
    assert "overlapping_groups" in (await compare())["warnings"]
