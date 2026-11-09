"""Label normalisation and alias resolution."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import chain


def _ranges(*items: int | tuple[int, int]) -> str:
    """Body of a regex character class from code points / inclusive ranges.

    Built from numbers on purpose: the invisible characters it names stay reviewable and cannot
    be damaged by editors or formatters."""
    out = []
    for item in items:
        lo, hi = (item, item) if isinstance(item, int) else item
        out.append(f"\\U{lo:08x}" if lo == hi else f"\\U{lo:08x}-\\U{hi:08x}")
    return "".join(out)


_WS = re.compile(r"\s+")


_CONTROL = re.compile(
    "["
    + _ranges(
        (0x00, 0x08),
        (0x0E, 0x1B),
        (0x7F, 0x84),
        (0x86, 0x9F),
        0xAD,
        0x061C,
        0x180E,
        (0x200B, 0x200F),
        (0x202A, 0x202E),
        (0x2060, 0x206F),
        0xFEFF,
        (0xFFF9, 0xFFFB),
        (0xE0000, 0xE007F),
        (0xD800, 0xDFFF),
    )
    + "]"
)


_KEY_IGNORE = re.compile("[" + _ranges(0x034F, (0xFE00, 0xFE0F), (0xE0100, 0xE01EF)) + "]")

_TRAILING_PUNCT = frozenset(".,;:!?_-") | frozenset(
    map(
        chr,
        (
            *(0x2026, 0x00B7, 0x2013, 0x2014, 0x2025),
            *(0x3001, 0x3002),
            *(0x060C, 0x061B, 0x061F, 0x06D4),
            *(0x0964, 0x0965),
        ),
    )
)


def _strip_trailing_punct(text: str) -> str:
    """Remove trailing whitespace and punctuation in linear time (a regex ``[...]+$`` would
    backtrack quadratically on long punctuation runs)."""
    end = len(text)
    while end and (text[end - 1] in _TRAILING_PUNCT or text[end - 1].isspace()):
        end -= 1
    return text[:end]


_FOLD = str.maketrans(
    {
        **dict.fromkeys(
            map(chr, (0x2018, 0x2019, 0x201A, 0x201B, 0x02BC, 0x2032, 0xB4, 0x60)), "'"
        ),
        **dict.fromkeys(map(chr, (0x201C, 0x201D, 0x201E, 0x201F, 0x2033)), '"'),
        **dict.fromkeys(
            map(
                chr,
                (0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0xFE58, 0xFE63, 0xFF0D),
            ),
            "-",
        ),
    }
)


def clean_label(raw: str) -> str:
    """Trim, strip control/invisible characters and collapse whitespace; keeps the user's casing."""
    text = _CONTROL.sub("", raw)
    return _WS.sub(" ", text).strip()


def normalize_key(raw: str) -> str:
    """Normalisation key: NFKC, casefold, trim, collapse whitespace, strip trailing punctuation.

    Typographic apostrophes, quotes and dashes are folded to their ASCII forms and invisible
    variation selectors are ignored. The function is idempotent: ``normalize_key(k) == k`` for
    every key ``k`` it returns (alias rows store keys and are looked up by them).
    """

    text = _KEY_IGNORE.sub("", clean_label(raw)).translate(_FOLD)
    text = unicodedata.normalize("NFKC", unicodedata.normalize("NFKC", text).casefold())
    text = _strip_trailing_punct(text.translate(_FOLD))
    return _WS.sub(" ", text).strip()


@dataclass(frozen=True)
class Alias:
    canonical: str | None = None
    hidden: bool = False


_DROPPED: tuple[str, str] = ("", "")


def resolve_steps(
    raw_traces: Sequence[Sequence[str]],
    aliases: Mapping[str, Alias] | None = None,
) -> tuple[list[list[tuple[str, str]]], dict[str, str]]:
    """Resolve raw steps to final display labels, keeping alignment with the input traces.

    Returns ``(resolved, display)``: ``resolved[i]`` is a list of ``(raw, final)`` pairs for the
    i-th input trace (hidden/empty steps dropped; the list may be empty), ``display`` maps
    identity key -> display label.

    Identity of a step is the normalisation key of its alias target (or of itself). Alias chains
    are followed (``a -> "B"`` and ``b -> "C"`` put ``a``, ``b`` and ``c`` on one identity); a
    cycle (``a -> "B"``, ``b -> "A"``) merges its members into the identity with the smallest key;
    a step whose chain reaches a hidden label is dropped. The display label is the canonical alias
    string that points at the identity (alphabetically smallest if there are several), otherwise
    the most frequent raw spelling (ties: alphabetical). The result does not depend on the order
    of the traces.
    """
    aliases = aliases or {}
    canonical_for: dict[str, str] = {}
    chains: dict[str, tuple[str, bool, str | None]] = {}

    def follow(key: str) -> tuple[str, bool, str | None]:
        """(identity key, hidden, canonical string of the last hop into the identity)."""
        cached = chains.get(key)
        if cached is not None:
            return cached
        path: list[str] = []
        position: dict[str, int] = {}
        hidden = False
        canon_into: dict[str, str] = {}
        cur = key
        while True:
            position[cur] = len(path)
            path.append(cur)
            alias = aliases.get(cur)
            if alias is None:
                root = cur
                break
            if alias.hidden:
                hidden = True
            if not alias.canonical:
                root = cur
                break
            canon = clean_label(alias.canonical)
            nxt = normalize_key(canon) or cur
            canon_into[nxt] = min(canon, canon_into.get(nxt, canon))
            if nxt == cur:
                root = cur
                break
            if nxt in position:
                root = min(path[position[nxt] :])
                break
            cur = nxt
        out = (root, hidden, canon_into.get(root))
        chains[key] = out
        return out

    resolve_cache: dict[str, tuple[str, str]] = {}

    def resolve_one(step: str) -> tuple[str, str]:
        raw = clean_label(step)
        key = normalize_key(raw) if raw else ""
        if not key:
            return _DROPPED
        root, hidden, canon = follow(key)
        if hidden:
            return _DROPPED
        if canon is not None:
            known = canonical_for.get(root)
            if known is None or canon < known:
                canonical_for[root] = canon
        return raw, root

    keyed: list[list[tuple[str, str]]] = []
    for trace in raw_traces:
        steps: list[tuple[str, str]] = []
        for step in trace:
            item = resolve_cache.get(step)
            if item is None:
                item = resolve_cache[step] = resolve_one(step)
            if item[0]:
                steps.append(item)
        keyed.append(steps)

    spelling: dict[str, Counter[str]] = {}
    for (raw, root), n in Counter(chain.from_iterable(keyed)).items():
        spelling.setdefault(root, Counter())[raw] += n
    display: dict[str, str] = {}
    for key, counter in spelling.items():
        if key in canonical_for:
            display[key] = canonical_for[key]
        else:
            display[key] = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    resolved = [[(raw, display[root]) for raw, root in steps] for steps in keyed]
    return resolved, display


def resolve_traces(
    raw_traces: Sequence[Sequence[str]],
    aliases: Mapping[str, Alias] | None = None,
) -> tuple[list[list[str]], dict[str, str]]:
    """Like :func:`resolve_steps` but returns plain label lists; empty traces are dropped."""
    resolved, display = resolve_steps(raw_traces, aliases)
    return [[final for _, final in t] for t in resolved if t], display
