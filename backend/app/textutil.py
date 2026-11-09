"""Small text helpers shared by the schemas and the answer validation."""

from __future__ import annotations

from app.normalize import clean_label


def has_lone_surrogate(text: str) -> bool:
    """True if ``text`` cannot be encoded as UTF-8 (JSON ``"\\ud800"`` escapes decode to such
    strings). They break exports and PostgreSQL JSONB, so they are rejected on input."""
    if text.isascii():
        return False
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return True
    return False


def clean_multiline(text: str) -> str:
    """Like ``clean_label`` for every line; line breaks are kept (help texts, free text)."""
    if "\n" not in text and "\r" not in text:
        return clean_label(text)
    return "\n".join(clean_label(line) for line in text.splitlines()).strip()
