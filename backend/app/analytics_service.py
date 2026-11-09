"""Glue between stored responses and the pure analytics functions."""

from __future__ import annotations

import difflib
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app import compute
from app.analytics import analyze, compare_groups
from app.errors import ApiError
from app.models import QuestionRow, SessionRow
from app.normalize import Alias, clean_label, normalize_key, resolve_steps
from app.service import ResponseData, load_aliases, load_responses

NO_ANSWER = "(no answer)"


def trace_question(session: SessionRow, question_id: str) -> QuestionRow:
    q = next((q for q in session.questions if q.id == question_id), None)
    if q is None:
        raise ApiError(404, "not_found", "Question not found")
    if q.type != "trace":
        raise ApiError(422, "not_a_trace_question", "Question is not a trace question")
    return q


def question_by_id(session: SessionRow, question_id: str) -> QuestionRow:
    q = next((q for q in session.questions if q.id == question_id), None)
    if q is None:
        raise ApiError(404, "not_found", "Question not found")
    return q


def _fmt(x: float) -> str:

    return f"{x:.12g}"


def bin_label(value: float, bins: Sequence[float]) -> str:
    if value < bins[0]:
        return f"< {_fmt(bins[0])}"
    for lo, hi in pairwise(bins):
        if lo <= value < hi:
            return f"{_fmt(lo)}–{_fmt(hi)}"
    return f"≥ {_fmt(bins[-1])}"


def attribute_values(question: QuestionRow, value: dict[str, Any] | None) -> list[str]:
    """Group values of one answer (multiple choice -> several groups)."""
    if value is None:
        return [NO_ANSWER]
    if question.type == "single_choice":
        return [value["value"]]
    if question.type == "multiple_choice":
        return list(value["values"]) or [NO_ANSWER]
    if question.type == "number":
        bins = question.config.get("bins")
        if not bins:
            raise ApiError(422, "bins_required", "Number question needs bins for grouping")
        return [bin_label(float(value["value"]), bins)]
    raise ApiError(422, "group_by_unsupported", "This question type cannot be used for grouping")


@dataclass
class Dataset:
    responses: list[ResponseData]
    resolved: list[list[tuple[str, str]]]
    display: dict[str, str]

    def traces(self) -> list[list[str]]:
        return [[f for _, f in steps] for steps in self.resolved]

    def label_counts(self) -> Counter[str]:
        """Occurrences per identity key (the keys of ``display``). Equivalent to
        ``Counter(normalize_key(f) for t in traces for f in t)`` without normalising every step
        again (about 100x faster for a few thousand traces)."""
        by_label = {label: key for key, label in self.display.items()}
        counts: Counter[str] = Counter()
        for label, n in Counter(f for steps in self.resolved for _, f in steps).items():
            counts[by_label[label]] += n
        return counts


async def build_dataset(db: AsyncSession, session: SessionRow, question_id: str) -> Dataset:
    responses = await load_responses(db, session.id)
    aliases = await load_aliases(db, question_id)
    raw: list[list[str]] = []
    for r in responses:
        ans = r.answers.get(question_id)
        raw.append(list(ans["steps"]) if ans and "steps" in ans else [])
    resolved, display = await compute.run(resolve_steps, raw, aliases)
    return Dataset(responses, resolved, display)


def _select(dataset: Dataset, keep: list[int]) -> list[list[str]]:
    traces = dataset.traces()
    return [traces[i] for i in keep if traces[i]]


async def compute_analytics(
    db: AsyncSession,
    session: SessionRow,
    question_id: str,
    *,
    filter_question_id: str | None,
    filter_value: str | None,
    min_support: int | None,
    theta: float,
) -> dict[str, Any]:
    trace_question(session, question_id)
    dataset = await build_dataset(db, session, question_id)
    keep = list(range(len(dataset.responses)))
    filt = None
    if filter_question_id is not None:
        fq = question_by_id(session, filter_question_id)
        if filter_value is None:
            raise ApiError(
                422, "validation_error", "filter_value is required with filter_question_id"
            )
        keep = [
            i
            for i in keep
            if filter_value in attribute_values(fq, dataset.responses[i].answers.get(fq.id))
        ]
        filt = {"question_id": filter_question_id, "value": filter_value}
    selected = _select(dataset, keep)
    result = await compute.run(analyze, selected, min_support=min_support, theta=theta)
    return {"version": session.version, "question_id": question_id, "filter": filt, **result}


async def compute_compare(
    db: AsyncSession,
    session: SessionRow,
    question_id: str,
    group_by: str,
    *,
    k_min: int,
    min_support: int | None,
    theta: float,
) -> dict[str, Any]:
    trace_question(session, question_id)
    gq = question_by_id(session, group_by)
    dataset = await build_dataset(db, session, question_id)
    traces = dataset.traces()
    groups: dict[str, list[list[str]]] = {}
    overlapping = False
    for i, resp in enumerate(dataset.responses):
        if not traces[i]:
            continue
        values = attribute_values(gq, resp.answers.get(gq.id))
        overlapping = overlapping or len(values) > 1
        for value in values:
            groups.setdefault(value, []).append(traces[i])
    result = await compute.run(
        compare_groups,
        groups,
        k_min=k_min,
        min_support=min_support,
        theta=theta,
        overlapping=overlapping,
    )
    return {
        "version": session.version,
        "question_id": question_id,
        "group_by": {"question_id": gq.id, "prompt": gq.prompt, "label": gq.label},
        **result,
    }


def label_rows(
    raw_traces: Sequence[Sequence[str]], aliases: dict[str, Alias]
) -> list[dict[str, Any]]:
    cache: dict[str, tuple[str, str]] = {}
    pairs: list[tuple[str, str]] = []
    for trace in raw_traces:
        for step in trace:
            item = cache.get(step)
            if item is None:
                raw = clean_label(step)
                item = cache[step] = (raw, normalize_key(raw))
            if item[1]:
                pairs.append(item)
    spelling: dict[str, Counter[str]] = {}
    counts: Counter[str] = Counter()
    for (raw, key), n in Counter(pairs).items():
        spelling.setdefault(key, Counter())[raw] += n
        counts[key] += n
    rows = []
    for key, count in counts.items():
        display = sorted(spelling[key].items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        alias = aliases.get(key)
        rows.append(
            {
                "raw_key": key,
                "display": display,
                "count": count,
                "canonical": alias.canonical if alias else None,
                "hidden": bool(alias.hidden) if alias else False,
            }
        )
    rows.sort(key=lambda r: (-r["count"], r["raw_key"]))
    return rows


_DIGITS = re.compile(r"\d+")


def _distinguishable(
    da: tuple[str, ...], ta: list[str], db: tuple[str, ...], tb: list[str]
) -> bool:
    """Labels that differ only in a number ("step 1" / "step 2") or in a single letter
    ("plan a" / "plan b") are different on purpose and are never proposed for merging."""
    if da != db:
        return True
    if len(ta) == len(tb):
        diff = [(x, y) for x, y in zip(ta, tb, strict=True) if x != y]
        if diff and all(len(x) == 1 and len(y) == 1 for x, y in diff):
            return True
    return False


def merge_suggestions(
    rows: list[dict[str, Any]], threshold: float = 0.82, limit: int = 300
) -> list[dict[str, Any]]:
    """Cluster similar, not yet moderated labels (character similarity or equal token sets).

    Pairs are linked when ``difflib`` similarity >= ``threshold`` or the token multisets are
    equal; clusters are the connected components (single linkage) and ``similarity`` is the
    weakest linked pair. Cheap upper bounds (length, character multiset) skip the expensive
    ratio for pairs that cannot reach the threshold; the result is identical to evaluating every
    pair."""
    cand = [r for r in rows if not r["hidden"] and not r["canonical"]][:limit]
    n = len(cand)
    keys = [r["raw_key"] for r in cand]
    lengths = [len(k) for k in keys]
    tokens = [k.split() for k in keys]
    token_sets = [sorted(t) for t in tokens]
    digits = [tuple(_DIGITS.findall(k)) for k in keys]
    chars = [Counter(k) for k in keys]
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    sims: dict[tuple[int, int], float] = {}
    matcher = difflib.SequenceMatcher(None)
    for j in range(1, n):
        b = keys[j]
        matcher.set_seq2(b)
        cb, lb = chars[j], lengths[j]
        for i in range(j):
            if _distinguishable(digits[i], tokens[i], digits[j], tokens[j]):
                continue
            if token_sets[i] == token_sets[j]:
                ratio = 1.0
            else:
                la = lengths[i]
                if 2 * min(la, lb) < threshold * (la + lb):
                    continue
                ca = chars[i]
                small, large = (ca, cb) if len(ca) <= len(cb) else (cb, ca)
                shared = sum(min(v, large.get(c, 0)) for c, v in small.items())
                if 2 * shared < threshold * (la + lb):
                    continue
                matcher.set_seq1(keys[i])
                ratio = matcher.ratio()
            if ratio >= threshold:
                sims[(i, j)] = ratio
                parent[find(i)] = find(j)
    clusters: dict[int, list[int]] = {}
    for i in range(n):
        clusters.setdefault(find(i), []).append(i)
    weakest: dict[int, float] = {}
    for (i, _j), s in sims.items():
        root = find(i)
        weakest[root] = min(s, weakest.get(root, 1.0))
    out = []
    for root, members in clusters.items():
        if len(members) < 2:
            continue
        best = max(members, key=lambda i: (cand[i]["count"], cand[i]["display"]))
        out.append(
            {
                "raw_keys": [
                    cand[i]["raw_key"] for i in sorted(members, key=lambda i: -cand[i]["count"])
                ],
                "similarity": round(weakest.get(root, 1.0), 4),
                "proposed_canonical": cand[best]["display"],
            }
        )
    out.sort(key=lambda s: (-len(s["raw_keys"]), -s["similarity"], s["raw_keys"][0]))
    return out


def suggest_labels(
    display: dict[str, str], counts: Counter[str], q: str, limit: int = 8
) -> list[str]:
    needle = normalize_key(q) if q else ""
    scored = []
    for key, label in display.items():
        if needle and needle not in key:
            continue
        prefix = 0 if needle and key.startswith(needle) else 1
        scored.append((prefix, -counts[key], label))
    scored.sort()
    return [label for _, _, label in scored[:limit]]
