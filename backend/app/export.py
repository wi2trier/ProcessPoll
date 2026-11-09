"""CSV / XES / JSON exporters (own implementation – no PM4Py at runtime)."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import xml.etree.ElementTree as ET
from datetime import timedelta
from typing import Any

from app.analytics_service import Dataset
from app.models import QuestionRow, SessionRow
from app.normalize import clean_label, normalize_key
from app.schemas import utc_z
from app.service import ResponseData

_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")


def case_id(response_id: str) -> str:
    return "case_" + hashlib.sha256(response_id.encode()).hexdigest()[:10]


def csv_safe(value: str) -> str:
    """Neutralise spreadsheet formula injection."""
    if value and value[0] in "=+-@\t\r":
        return "'" + value
    return value


def _attr_text(question: QuestionRow, value: dict[str, Any] | None) -> str:
    if value is None:
        return ""
    if question.type == "multiple_choice":
        return "; ".join(value["values"])
    return str(value["value"])


def _csv_attr(question: QuestionRow, value: dict[str, Any] | None) -> str:
    text = _attr_text(question, value)

    return text if question.type == "number" else csv_safe(text)


def _attribute_questions(session: SessionRow, trace_q: QuestionRow) -> list[QuestionRow]:
    return [q for q in session.questions if q.id != trace_q.id and q.type != "trace"]


def _unique_names(questions: list[QuestionRow]) -> dict[str, str]:
    names: dict[str, str] = {}
    used: set[str] = set()
    for q in questions:
        base = q.label or q.prompt
        name, n = base, 2
        while name in used:
            name, n = f"{base} ({n})", n + 1
        used.add(name)
        names[q.id] = name
    return names


def export_csv(session: SessionRow, trace_q: QuestionRow, ds: Dataset) -> bytes:
    attrs = _attribute_questions(session, trace_q)
    names = _unique_names(attrs)
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(
        ["case_id", "position", "activity", "activity_raw", "submitted_at"]
        + [csv_safe(names[q.id]) for q in attrs]
    )
    for resp, steps in zip(ds.responses, ds.resolved, strict=True):
        attr_vals = [_csv_attr(q, resp.answers.get(q.id)) for q in attrs]
        for pos, (raw, final) in enumerate(steps, 1):
            writer.writerow(
                [
                    case_id(resp.id),
                    pos,
                    csv_safe(final),
                    csv_safe(raw),
                    utc_z(resp.submitted_at),
                    *attr_vals,
                ]
            )
    return b"\xef\xbb\xbf" + buf.getvalue().encode("utf-8")


def _xes_str(value: Any) -> str:
    return _XML_ILLEGAL.sub("", str(value))


def _attr(parent: ET.Element, kind: str, key: str, value: Any) -> None:
    ET.SubElement(parent, kind, {"key": _xes_str(key), "value": _xes_str(value)})


def export_xes(session: SessionRow, trace_q: QuestionRow, ds: Dataset) -> bytes:
    attrs = _attribute_questions(session, trace_q)
    names = _unique_names(attrs)
    log = ET.Element(
        "log",
        {
            "xes.version": "1.0",
            "xes.features": "nested-attributes",
            "xmlns": "http://www.xes-standard.org/",
        },
    )
    ET.SubElement(
        log,
        "extension",
        {
            "name": "Concept",
            "prefix": "concept",
            "uri": "http://www.xes-standard.org/concept.xesext",
        },
    )
    ET.SubElement(
        log,
        "extension",
        {"name": "Time", "prefix": "time", "uri": "http://www.xes-standard.org/time.xesext"},
    )
    g_trace = ET.SubElement(log, "global", {"scope": "trace"})
    _attr(g_trace, "string", "concept:name", "__INVALID__")
    g_event = ET.SubElement(log, "global", {"scope": "event"})
    _attr(g_event, "string", "concept:name", "__INVALID__")
    _attr(g_event, "date", "time:timestamp", "1970-01-01T00:00:00.000+00:00")
    ET.SubElement(log, "classifier", {"name": "Activity", "keys": "concept:name"})
    _attr(log, "string", "concept:name", f"{session.title} – {trace_q.label or trace_q.prompt}")
    _attr(log, "string", "processpoll:session_code", session.code)
    _attr(log, "string", "processpoll:question", trace_q.prompt)
    _attr(log, "boolean", "processpoll:synthetic_timestamps", "true")
    _attr(
        log,
        "string",
        "processpoll:timestamp_note",
        "time:timestamp is synthetic (submission time + position seconds); "
        "only the order of events is meaningful",
    )
    for resp, steps in zip(ds.responses, ds.resolved, strict=True):
        if not steps:
            continue
        trace = ET.SubElement(log, "trace")
        _attr(trace, "string", "concept:name", case_id(resp.id))
        for q in attrs:
            value = resp.answers.get(q.id)
            if value is None:
                continue
            if q.type == "number":
                is_int = isinstance(value["value"], int)
                _attr(trace, "int" if is_int else "float", names[q.id], value["value"])
            else:
                _attr(trace, "string", names[q.id], _attr_text(q, value))
        for pos, (raw, final) in enumerate(steps, 1):
            ev = ET.SubElement(trace, "event")
            _attr(ev, "string", "concept:name", final)
            ts = (resp.submitted_at + timedelta(seconds=pos)).strftime(
                "%Y-%m-%dT%H:%M:%S.000+00:00"
            )
            _attr(ev, "date", "time:timestamp", ts)
            _attr(ev, "int", "processpoll:position", pos)
            _attr(ev, "string", "processpoll:raw_label", raw)
    ET.indent(log)
    return b'<?xml version="1.0" encoding="UTF-8" ?>\n' + ET.tostring(log, encoding="utf-8")


def _without_hidden(
    answers: dict[str, dict[str, Any] | None], hidden: dict[str, set[str]]
) -> dict[str, dict[str, Any] | None]:
    out: dict[str, dict[str, Any] | None] = {}
    for question_id, value in answers.items():
        blocked = hidden.get(question_id)
        if blocked and value and "steps" in value:
            steps = [s for s in value["steps"] if normalize_key(clean_label(s)) not in blocked]
            value = {**value, "steps": steps}
        out[question_id] = value
    return out


def export_json(
    session: SessionRow,
    responses: list[ResponseData],
    aliases: list[dict[str, Any]],
    participants_joined: int,
) -> bytes:

    hidden: dict[str, set[str]] = {}
    for alias in aliases:
        if alias["hidden"]:
            hidden.setdefault(alias["question_id"], set()).add(alias["raw_key"])
    data = {
        "format": "processpoll-session-v1",
        "session": {
            "code": session.code,
            "title": session.title,
            "description": session.description,
            "status": session.status,
            "settings": session.settings,
            "created_at": utc_z(session.created_at),
            "opened_at": utc_z(session.opened_at) if session.opened_at else None,
            "closed_at": utc_z(session.closed_at) if session.closed_at else None,
            "joined": participants_joined,
        },
        "questions": [
            {
                "id": q.id,
                "position": q.position,
                "type": q.type,
                "prompt": q.prompt,
                "label": q.label,
                "help": q.help,
                "required": q.required,
                "config": q.config,
            }
            for q in session.questions
        ],
        "aliases": [a for a in aliases if not a["hidden"]],
        "responses": [
            {
                "case_id": case_id(r.id),
                "submitted_at": utc_z(r.submitted_at),
                "answers": _without_hidden(r.answers, hidden),
            }
            for r in responses
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
