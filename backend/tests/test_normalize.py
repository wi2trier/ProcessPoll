from __future__ import annotations

from app.normalize import Alias, clean_label, normalize_key, resolve_steps, resolve_traces


def test_clean_label_collapses_whitespace_and_control_chars():
    assert clean_label("  Check \t  mail​ \n") == "Check mail"
    assert clean_label("a\x00b") == "ab"


def test_normalize_key():
    assert normalize_key("  Check   Mail!! ") == "check mail"
    assert normalize_key("ＣＯＦＦＥＥ") == "coffee"
    assert normalize_key("Straße") == normalize_key("STRASSE")
    assert normalize_key("...") == ""


def test_most_frequent_spelling_is_display_label():
    traces, display = resolve_traces([["coffee"], ["Coffee"], ["Coffee!"], ["tea"]])
    assert display["coffee"] == "Coffee"
    assert traces == [["Coffee"], ["Coffee"], ["Coffee"], ["tea"]]


def test_alias_merge_hide_and_identity():
    aliases = {
        "check mail": Alias(canonical="Check email"),
        "read emails": Alias(canonical="check email"),
        "um": Alias(hidden=True),
    }
    raw = [["check mail", "um", "Coffee"], ["Read emails"], ["um"], ["check email"]]
    resolved, _display = resolve_steps(raw, aliases)

    assert len(resolved) == 4 and resolved[2] == []

    assert [f for _, f in resolved[0]] == ["Check email", "Coffee"]
    assert [f for _, f in resolved[1]] == ["Check email"]
    assert [f for _, f in resolved[3]] == ["Check email"]

    traces, _ = resolve_traces(raw, aliases)
    assert len(traces) == 3


def test_resolution_is_independent_of_order():
    raw = [["a", "B"], ["A", "b"], ["a", "b"]]
    t1, _ = resolve_traces(raw)
    t2, _ = resolve_traces(list(reversed(raw)))
    assert t1 == list(reversed(t2))
