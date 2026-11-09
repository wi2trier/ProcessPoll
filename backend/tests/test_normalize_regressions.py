"""Regression tests for the normalisation / alias findings of the independent analytics review.

Special characters are written as ``chr(...)`` constants so that the invisible ones stay visible.
"""

from __future__ import annotations

import random
import time
import unicodedata

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from app.normalize import Alias, clean_label, normalize_key, resolve_steps, resolve_traces

RSQUO, LSQUO = chr(0x2019), chr(0x2018)
LDQUO, RDQUO = chr(0x201C), chr(0x201D)
NB_HYPHEN, EN_DASH, EM_DASH, MINUS = chr(0x2011), chr(0x2013), chr(0x2014), chr(0x2212)
SOFT_HYPHEN = chr(0xAD)
LRI, PDI = chr(0x2066), chr(0x2069)
VS16, HEART = chr(0xFE0F), chr(0x2764)
IDEO_STOP, ARABIC_QMARK = chr(0x3002), chr(0x061F)
COMBINING_ACUTE, E_ACUTE = chr(0x0301), chr(0xE9)
DOTTED_I = chr(0x0130)
SMILE = chr(0x1F642)


def test_n1_key_is_idempotent_on_awkward_unicode():

    samples = [
        DOTTED_I + chr(0x302B) + chr(0xA0) + chr(0xB9),
        DOTTED_I + chr(0x302E) + ">" + chr(0x01AD) + chr(0x0112),
        "S" + DOTTED_I + chr(0x302E) + "\\" + chr(0x0136) + chr(0x039C),
        chr(0x0390),
        "e" + COMBINING_ACUTE + chr(0x0323),
        chr(0xFB01) + "x",
        chr(0x1E9E),
        chr(0x0149),
        chr(0x035A)
        + chr(0x01EC)
        + chr(0x201E)
        + chr(0x0225)
        + chr(0x032F)
        + chr(0x034F)
        + chr(0x031B),
    ]
    for s in samples:
        k = normalize_key(s)
        assert normalize_key(k) == k, (s, k)


def test_n1_key_is_idempotent_on_random_strings():
    rnd = random.Random(2026)
    pool = [
        chr(c)
        for c in [
            *range(0x20, 0x250),
            *range(0x300, 0x370),
            *range(0x2000, 0x2070),
            0x3002,
            0x1F600,
            0x34F,
            0xFE0F,
        ]
    ]
    for _ in range(30000):
        s = "".join(rnd.choice(pool) for _ in range(rnd.randint(1, 7)))
        k = normalize_key(s)
        assert normalize_key(k) == k, (s, k)


@pytest.mark.parametrize(
    ("a", "b"),
    [
        (f"Don{RSQUO}t wait", "Don't wait"),
        (f"Don{LSQUO}t wait", "don't wait"),
        (f"Say {LDQUO}hello{RDQUO}", 'Say "hello"'),
        (f"Check{NB_HYPHEN}in", "Check-in"),
        (f"Check{EN_DASH}in", "check-in"),
        (f"Check{EM_DASH}in", "check-in"),
        (f"5{MINUS}3", "5-3"),
        (f"co{SOFT_HYPHEN}ffee", "coffee"),
        (f"{LRI}coffee{PDI}", "coffee"),
        (HEART + VS16, HEART),
        ("cafe" + COMBINING_ACUTE, "caf" + E_ACUTE),
        ("Wake up" + IDEO_STOP, "wake up"),
        ("Wake up" + ARABIC_QMARK, "wake up"),
        ("Step 1.", "step 1"),
    ],
)
def test_n1_variants_of_the_same_label_share_a_key(a, b):
    assert normalize_key(a) == normalize_key(b)


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("C++", "C"),
        ("C#", "C"),
        ("F#", "F"),
        ("B+", "B"),
        ("e-mail", "email"),
        ("Step 1", "Step 2"),
        ("a b", "ab"),
        (SMILE, SMILE + SMILE),
        ("v1.2", "v1"),
        ("100%", "100"),
        ("Q&A", "Q"),
    ],
)
def test_n1_distinct_labels_keep_distinct_keys(a, b):
    assert normalize_key(a) != normalize_key(b)


def test_n1_punctuation_only_labels_have_an_empty_key():
    for s in ["...", "?!", EM_DASH, "_", "  -  ", IDEO_STOP, chr(0x2026)]:
        assert normalize_key(s) == ""
    assert normalize_key(SMILE) != ""


def test_n1_whitespace_like_controls_separate_words_instead_of_gluing_them():
    for ch in [chr(0x0B), chr(0x0C), chr(0x2028), chr(0x2029), chr(0x85), chr(0x1C)]:
        assert clean_label(f"a{ch}b") == "a b", hex(ord(ch))
    assert normalize_key(f"a{chr(0x2028)}b") == "a b"


def test_n1_invisible_format_characters_are_removed_from_labels():
    for cp in [0xAD, 0x061C, 0x2066, 0x2067, 0x2068, 0x2069, 0xE0067, 0x180E, 0x200B, 0x2060]:
        assert clean_label(f"co{chr(cp)}ffee") == "coffee", hex(cp)
        assert unicodedata.category(chr(cp)) == "Cf"


def test_n1_lone_surrogates_are_removed_because_they_cannot_be_encoded():
    assert clean_label("a" + chr(0xD800) + "b") == "ab"
    assert clean_label(chr(0xDFFF)) == ""

    assert clean_label("a" + SMILE) == "a" + SMILE
    clean_label("x" + chr(0xD83D) + "y").encode("utf-8")


def test_n1_key_of_very_long_inputs_is_computed_in_linear_time():

    start = time.perf_counter()
    assert normalize_key("!" * 200_000 + "x") == "!" * 200_000 + "x"
    assert normalize_key("x" + "!" * 200_000) == "x"
    assert normalize_key(" " * 200_000 + "x" + "." * 200_000) == "x"
    assert time.perf_counter() - start < 2.0


def test_n2_alias_chain_is_followed_to_the_final_target():
    aliases = {"a": Alias(canonical="B"), "b": Alias(canonical="C")}
    traces, display = resolve_traces([["A"], ["B"], ["C"], ["a", "b", "c"]], aliases)
    assert traces == [["C"], ["C"], ["C"], ["C", "C", "C"]]
    assert set(display.values()) == {"C"}


def test_n2_alias_chain_with_missing_intermediate_label():
    aliases = {"a": Alias(canonical="B"), "b": Alias(canonical="C")}
    traces, display = resolve_traces([["A", "x"]], aliases)
    assert traces == [["C", "x"]]
    assert display["c"] == "C"


def test_n2_chain_to_a_hidden_label_hides_the_step():
    aliases = {"a": Alias(canonical="B"), "b": Alias(hidden=True)}
    traces, _ = resolve_traces([["A", "x"], ["B", "x"], ["x"]], aliases)
    assert traces == [["x"], ["x"], ["x"]]


def test_n2_alias_cycle_terminates_and_merges_deterministically():
    aliases = {"a": Alias(canonical="B"), "b": Alias(canonical="A")}
    raw = [["A"], ["B"], ["A", "B"]]
    t1, d1 = resolve_traces(raw, aliases)
    t2, d2 = resolve_traces(raw[::-1], aliases)
    assert t1[0] == t1[1] and t1[2][0] == t1[2][1] == t1[0][0]
    assert t1 == t2[::-1] and d1 == d2


def test_n2_longer_cycle_with_tail():
    aliases = {
        "t": Alias(canonical="A"),
        "a": Alias(canonical="B"),
        "b": Alias(canonical="C"),
        "c": Alias(canonical="A"),
    }
    raw = [["T"], ["A"], ["B"], ["C"], ["x"]]
    traces, _ = resolve_traces(raw, aliases)
    assert len({t[0] for t in traces[:4]}) == 1 and traces[4] == ["x"]
    traces2, _ = resolve_traces(raw[::-1], aliases)
    assert traces == traces2[::-1]


def test_n2_self_alias_overrides_only_the_display_label():
    traces, display = resolve_traces(
        [["coffee"], ["Coffee"], ["coffee!"]], {"coffee": Alias("COFFEE")}
    )
    assert traces == [["COFFEE"]] * 3 and display == {"coffee": "COFFEE"}


def test_n2_hidden_wins_over_canonical_on_the_same_row():
    traces, _ = resolve_traces([["a", "b"]], {"a": Alias(canonical="B", hidden=True)})
    assert traces == [["b"]]


def test_n2_canonical_with_empty_key_only_renames():
    traces, display = resolve_traces([["foo"], ["bar"]], {"foo": Alias(canonical="?")})
    assert traces == [["?"], ["bar"]] and display["foo"] == "?"


def test_n2_most_frequent_spelling_wins_and_ties_are_alphabetical():
    _, display = resolve_traces([["tea"], ["Tea"], ["TEA"], ["Tea"]])
    assert display == {"tea": "Tea"}
    _, display = resolve_traces([["tea"], ["Tea"]])
    assert display == {"tea": "Tea"}


@settings(max_examples=80, deadline=None)
@given(
    st.lists(st.lists(st.sampled_from(["a", "B", "c!", "D", "e", " a "]), max_size=5), max_size=8),
    st.dictionaries(
        st.sampled_from(["a", "b", "c", "d", "e"]),
        st.builds(
            Alias,
            st.sampled_from([None, "A", "B", "C", "d", "E"]),
            st.booleans(),
        ),
        max_size=5,
    ),
    st.randoms(use_true_random=False),
)
def test_n2_resolution_is_order_independent_and_terminates(raw, aliases, rnd):
    shuffled = list(raw)
    rnd.shuffle(shuffled)
    t1, d1 = resolve_traces(raw, aliases)
    t2, d2 = resolve_traces(shuffled, aliases)
    assert sorted(map(tuple, t1)) == sorted(map(tuple, t2))
    assert d1 == d2

    assert all(label in d1.values() for t in t1 for label in t)

    raw_nonempty = sum(1 for t in raw for s in t if normalize_key(s))
    assert sum(len(t) for t in t1) <= raw_nonempty


def test_n2_resolve_steps_keeps_alignment_and_raw_spellings():
    aliases = {"um": Alias(hidden=True)}
    raw = [["Um", "Coffee"], ["um"], []]
    resolved, _ = resolve_steps(raw, aliases)
    assert resolved == [[("Coffee", "Coffee")], [], []]
