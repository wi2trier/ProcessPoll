"""Small statistics helpers: Wilson, entropy, Jensen-Shannon, Benjamini-Hochberg, Levenshtein and
the exact / permutation tests used by the group comparison.

Everything here is a pure, thread-safe function. Floating point sums that could depend on the
iteration order of a ``set``/``dict`` (hash randomisation!) use :func:`math.fsum`, so results are
reproducible bit for bit across processes.
"""

from __future__ import annotations

import math
import zlib
from collections.abc import Mapping, Sequence
from typing import Any

import numpy as np
from scipy.special import chdtrc, gammaln


def wilson_interval(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a binomial proportion k/n; (0, 1) for n == 0."""
    if n <= 0:
        return 0.0, 1.0
    p = k / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom

    return max(0.0, min(p, centre - half)), min(1.0, max(p, centre + half))


def normalized_entropy(counts: Sequence[int]) -> float:
    """Shannon entropy (nats) divided by log(K), K = number of non-zero categories. K <= 1 -> 0.

    Note: K is the number of *observed* categories, so values are not comparable between
    activities with different group sizes."""
    nonzero = [c for c in counts if c > 0]
    total = sum(nonzero)
    k = len(nonzero)
    if k <= 1 or total == 0:
        return 0.0
    h = -math.fsum((c / total) * math.log(c / total) for c in nonzero)
    return min(1.0, max(0.0, h / math.log(k)))


def js_distance(p: Mapping[Any, float], q: Mapping[Any, float]) -> float:
    """Jensen-Shannon distance (sqrt of divergence, base 2, range 0..1) of two count/weight maps."""
    sp = float(sum(p.values()))
    sq = float(sum(q.values()))
    if sp <= 0 or sq <= 0:
        return 0.0 if sp == sq else 1.0
    terms: list[float] = []
    for key, pv in p.items():
        a = pv / sp
        if a <= 0:
            continue
        b = q.get(key, 0.0) / sq
        if b > 0:
            m = (a + b) / 2
            terms.append(0.5 * a * math.log2(a / m))
            terms.append(0.5 * b * math.log2(b / m))
        else:
            terms.append(0.5 * a)
    for key, qv in q.items():
        if qv > 0 and p.get(key, 0.0) <= 0:
            terms.append(0.5 * (qv / sq))
    jsd = math.fsum(terms)
    return math.sqrt(max(0.0, min(1.0, jsd)))


def benjamini_hochberg(p_values: Sequence[float | None]) -> list[float | None]:
    """BH-adjusted q-values; ``None`` entries stay ``None`` and are excluded from the family."""
    indexed = [(i, p) for i, p in enumerate(p_values) if p is not None]
    m = len(indexed)
    out: list[float | None] = [None] * len(p_values)
    if m == 0:
        return out
    indexed.sort(key=lambda t: t[1])
    prev = 1.0
    for rank in range(m, 0, -1):
        i, p = indexed[rank - 1]
        q = min(prev, p * m / rank)
        prev = q
        out[i] = min(1.0, q)
    return out


def levenshtein(a: Sequence[int], b: Sequence[int]) -> int:
    """Edit distance between two integer sequences (two-row DP). Reference implementation."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def normalized_levenshtein(a: Sequence[int], b: Sequence[int]) -> float:
    longest = max(len(a), len(b))
    return 0.0 if longest == 0 else levenshtein(a, b) / longest


class LevenshteinPattern:
    """Bit-parallel edit distance against a fixed sequence (Myers 1999 / Hyyroe 2003).

    ``LevenshteinPattern(a).distance(b) == levenshtein(a, b)`` for all inputs, but runs in
    O(len(b)) big-integer operations instead of O(len(a) * len(b)) interpreted steps. The
    pattern is preprocessed once and reused for many ``b``."""

    __slots__ = ("_high", "_mask", "_peq", "length")

    def __init__(self, a: Sequence[Any]) -> None:
        self.length = len(a)
        peq: dict[Any, int] = {}
        for i, sym in enumerate(a):
            peq[sym] = peq.get(sym, 0) | (1 << i)
        self._peq = peq
        self._mask = (1 << self.length) - 1
        self._high = 1 << (self.length - 1) if self.length else 0

    def distance(self, b: Sequence[Any]) -> int:
        m = self.length
        if m == 0:
            return len(b)
        mask, high, peq = self._mask, self._high, self._peq
        vp, vn, score = mask, 0, m
        for sym in b:
            eq = peq.get(sym, 0)
            xv = eq | vn
            xh = (((eq & vp) + vp) ^ vp) | eq
            hp = vn | (~(xh | vp) & mask)
            hn = vp & xh
            if hp & high:
                score += 1
            elif hn & high:
                score -= 1
            hp = ((hp << 1) | 1) & mask
            hn = (hn << 1) & mask
            vp = hn | (~(xv | hp) & mask)
            vn = hp & xv
        return score


_TIE_TOL = 1e-7

MC_MAX_DRAWS = 20_000
MC_BATCH = 100
MC_STOP_EXCEEDANCES = 50


class LogFactorials:
    """Table of log(k!) for 0 <= k <= n (computed once per comparison)."""

    __slots__ = ("table",)

    def __init__(self, n: int) -> None:
        self.table = gammaln(np.arange(n + 2, dtype=np.float64) + 1.0)


def informative(counts: Sequence[int], sizes: Sequence[int]) -> bool:
    """Is a test about "trace contains the edge" meaningful for these group counts?

    The criterion looks only at the margin ``T`` (number of traces containing the edge, all groups
    together), never at its split between the groups. Under the null hypothesis the margin is
    independent of the test statistic of the conditional tests used here, so using it as a filter
    keeps the p-values valid ("independent filtering"). An edge present in fewer than two traces,
    or absent from fewer than two traces, carries no usable information."""
    total = sum(counts)
    return total >= 2 and sum(sizes) - total >= 2


def fisher_exact_two_sided(
    a: int, n1: int, c: int, n2: int, lf: LogFactorials | None = None
) -> float:
    """Two-sided Fisher exact p-value of the table [[a, n1-a], [c, n2-c]].

    Same definition as ``scipy.stats.fisher_exact``: the sum of the probabilities of all tables
    (with the same margins) that are not more probable than the observed one (relative
    tolerance 1e-7 for ties). Vectorised and independent of scipy's per-call overhead."""
    total = a + c
    n = n1 + n2
    lo = max(0, total - n2)
    hi = min(total, n1)
    if lo == hi:
        return 1.0
    table = (lf or LogFactorials(n)).table
    x = np.arange(lo, hi + 1)
    logp = (
        table[n1]
        - table[x]
        - table[n1 - x]
        + table[n2]
        - table[total - x]
        - table[n2 - total + x]
        - (table[n] - table[total] - table[n - total])
    )
    p = np.exp(logp)
    observed = p[a - lo]
    return float(min(1.0, p[p <= observed * (1 + _TIE_TOL)].sum()))


def chi_square_valid(counts: Sequence[int], sizes: Sequence[int]) -> bool:
    """Cochran's rule for the k x 2 table: every expected count >= 1 and at most 20 % of the
    expected counts below 5."""
    total = sum(counts)
    n = sum(sizes)
    expected = [s * total / n for s in sizes] + [s * (n - total) / n for s in sizes]
    return min(expected) >= 1 and sum(e < 5 for e in expected) <= 0.2 * len(expected)


def chi_square_pvalue(counts: Sequence[int], sizes: Sequence[int]) -> float:
    """Pearson chi-square test of independence of the k x 2 table (df = k - 1, no continuity
    correction; identical to ``scipy.stats.chi2_contingency`` for k >= 3)."""
    total = sum(counts)
    n = sum(sizes)
    stat = 0.0
    for c, s in zip(counts, sizes, strict=True):
        e1 = s * total / n
        e0 = s - e1
        stat += (c - e1) ** 2 / e1 + ((s - c) - e0) ** 2 / e0
    return float(min(1.0, chdtrc(len(sizes) - 1, stat)))


def permutation_pvalue(
    counts: Sequence[int],
    sizes: Sequence[int],
    lf: LogFactorials | None = None,
    *,
    max_draws: int = MC_MAX_DRAWS,
    batch: int = MC_BATCH,
    stop_exceedances: int = MC_STOP_EXCEEDANCES,
) -> float:
    """Monte-Carlo version of the Fisher-Freeman-Halton exact test for a k x 2 table.

    Tables with the observed margins are drawn from their null distribution (multivariate
    hypergeometric); the p-value is the share of draws that are not more probable than the
    observed table. Besag-Clifford sequential stopping: stop at ``stop_exceedances`` extreme
    draws (p = h / draws), otherwise p = (r + 1) / (max_draws + 1). The random generator is seeded
    from the table itself, so the result is deterministic and independent of the order in which
    edges or groups are processed. Resolution: 1 / (max_draws + 1)."""
    total = sum(counts)
    n = sum(sizes)
    table = (lf or LogFactorials(n)).table
    size_arr = np.asarray(sizes, dtype=np.int64)
    base = table[size_arr]

    def log_prob(c: np.ndarray) -> np.ndarray:

        return (base - table[c] - table[size_arr - c]).sum(axis=-1)

    observed = float(log_prob(np.asarray(counts, dtype=np.int64)))
    seed = zlib.crc32(repr((tuple(sizes), tuple(counts))).encode())
    rng = np.random.default_rng(seed)
    exceed = 0
    drawn = 0
    size = batch
    while drawn < max_draws:
        size = min(size, max_draws - drawn)
        draws = rng.multivariate_hypergeometric(size_arr, total, size=size)
        extreme = np.flatnonzero(log_prob(draws) <= observed + 1e-9)
        if exceed + len(extreme) >= stop_exceedances:
            stop_at = drawn + int(extreme[stop_exceedances - exceed - 1]) + 1
            return stop_exceedances / stop_at
        exceed += len(extreme)
        drawn += size
        size *= 2
    return (exceed + 1) / (max_draws + 1)


def edge_pvalue(
    counts: Sequence[int], sizes: Sequence[int], lf: LogFactorials | None = None
) -> float | None:
    """p-value for "trace contains edge" across groups, or ``None`` if the edge is not informative.

    * 2 groups: two-sided Fisher exact test;
    * >= 3 groups: Pearson chi-square test if Cochran's rule holds, otherwise the Monte-Carlo
      Fisher-Freeman-Halton permutation test (fixed seed)."""
    if not informative(counts, sizes):
        return None
    if len(sizes) == 2:
        return fisher_exact_two_sided(counts[0], sizes[0], counts[1], sizes[1], lf)
    if chi_square_valid(counts, sizes):
        return chi_square_pvalue(counts, sizes)
    return permutation_pvalue(counts, sizes, lf)
