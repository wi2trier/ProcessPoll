"""Server-side validation and normalisation of submitted answers."""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

from app.models import QuestionRow
from app.normalize import clean_label, normalize_key
from app.schemas import AnswerIn
from app.textutil import clean_multiline, has_lone_surrogate


class AnswerValidationError(Exception):
    def __init__(self, errors: list[dict[str, str]]) -> None:
        super().__init__("validation_error")
        self.errors = errors


def _err(question_id: str, message: str) -> dict[str, str]:
    return {"question_id": question_id, "message": message}


def _validate_trace(q: QuestionRow, value: dict[str, Any]) -> dict[str, Any]:
    cfg = q.config
    steps_in = value.get("steps")
    if not isinstance(steps_in, list) or not all(isinstance(s, str) for s in steps_in):
        raise ValueError("steps must be a list of strings")
    if any(has_lone_surrogate(s) for s in steps_in):
        raise ValueError("labels contain invalid characters")
    steps = [clean_label(s) for s in steps_in]
    if any(not s for s in steps):
        raise ValueError("empty activity label")
    if any(len(s) > cfg["max_label_length"] for s in steps):
        raise ValueError(f"label longer than {cfg['max_label_length']} characters")
    if len(steps) < cfg["min_steps"]:
        raise ValueError(f"at least {cfg['min_steps']} steps required")
    if len(steps) > cfg["max_steps"]:
        raise ValueError(f"at most {cfg['max_steps']} steps allowed")
    keys = [normalize_key(s) for s in steps]
    if any(not k for k in keys):
        raise ValueError("empty activity label")
    if not cfg["allow_repeats"] and len(set(keys)) != len(keys):
        raise ValueError("repeating an activity is not allowed")
    if cfg["mode"] == "select_sort":
        pool = {normalize_key(a): a for a in cfg["activities"]}
        out: list[str] = []
        for s, k in zip(steps, keys, strict=True):
            if k in pool:
                out.append(pool[k])
            elif cfg["allow_custom"]:
                out.append(s)
            else:
                raise ValueError(f"activity not in pool: {s}")
        steps = out
        if not cfg["allow_skip"]:
            missing = set(pool) - {normalize_key(s) for s in steps}
            if missing:
                raise ValueError("all activities must be used")
    return {"steps": steps, "mode": cfg["mode"]}


def _validate_single(q: QuestionRow, value: dict[str, Any]) -> dict[str, Any]:
    v = value.get("value")
    if not isinstance(v, str):
        raise ValueError("value must be a string")
    by_fold = {o.casefold(): o for o in q.config["options"]}
    opt = by_fold.get(clean_label(v).casefold())
    if opt is None:
        raise ValueError("value is not one of the options")
    return {"value": opt}


def _validate_multi(q: QuestionRow, value: dict[str, Any]) -> dict[str, Any]:
    vs = value.get("values")
    if not isinstance(vs, list) or not all(isinstance(v, str) for v in vs):
        raise ValueError("values must be a list of strings")
    by_fold = {o.casefold(): o for o in q.config["options"]}
    out: list[str] = []
    for v in vs:
        opt = by_fold.get(clean_label(v).casefold())
        if opt is None:
            raise ValueError("value is not one of the options")
        if opt not in out:
            out.append(opt)
    mx = q.config.get("max_selected")
    if mx is not None and len(out) > mx:
        raise ValueError(f"at most {mx} options may be selected")
    return {"values": out}


def _validate_number(q: QuestionRow, value: dict[str, Any]) -> dict[str, Any]:
    v = value.get("value")
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise ValueError("value must be a finite number")
    try:
        finite = math.isfinite(v)
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError("value must be a finite number")
    cfg = q.config
    if cfg.get("integer") and isinstance(v, float) and not v.is_integer():
        raise ValueError("value must be an integer")
    if cfg.get("min") is not None and v < cfg["min"]:
        raise ValueError(f"value must be >= {cfg['min']}")
    if cfg.get("max") is not None and v > cfg["max"]:
        raise ValueError(f"value must be <= {cfg['max']}")
    return {"value": int(v) if cfg.get("integer") else v}


def _validate_text(q: QuestionRow, value: dict[str, Any]) -> dict[str, Any]:
    v = value.get("value")
    if not isinstance(v, str):
        raise ValueError("value must be a string")
    if has_lone_surrogate(v):
        raise ValueError("text contains invalid characters")
    text = clean_label(v) if "\n" not in v else clean_multiline(v)
    if len(text) > q.config["max_length"]:
        raise ValueError(f"text longer than {q.config['max_length']} characters")
    return {"value": text}


_VALIDATORS = {
    "trace": _validate_trace,
    "single_choice": _validate_single,
    "multiple_choice": _validate_multi,
    "number": _validate_number,
    "text": _validate_text,
}


def validate_answers(
    questions: Sequence[QuestionRow], answers: Sequence[AnswerIn]
) -> dict[str, dict[str, Any] | None]:
    """Return {question_id: normalised value or None}. Raises AnswerValidationError."""
    by_id = {q.id: q for q in questions}
    errors: list[dict[str, str]] = []
    given: dict[str, AnswerIn] = {}
    for a in answers:
        if a.question_id not in by_id:
            errors.append(_err(a.question_id, "unknown question"))
        elif a.question_id in given:
            errors.append(_err(a.question_id, "duplicate answer"))
        else:
            given[a.question_id] = a
    result: dict[str, dict[str, Any] | None] = {}
    for q in questions:
        ans = given.get(q.id)
        value = ans.value if ans else None

        if value is not None and q.type == "trace" and value.get("steps") == [] and not q.required:
            value = None
        if value is not None and q.type == "multiple_choice" and value.get("values") == []:
            value = None if not q.required else value
        if value is None:
            if q.required:
                errors.append(_err(q.id, "this question is required"))
            else:
                result[q.id] = None
            continue
        try:
            validated = _VALIDATORS[q.type](q, value)
        except ValueError as exc:
            errors.append(_err(q.id, str(exc)))
        else:
            result[q.id] = validated
            if q.type == "multiple_choice" and q.required and not validated["values"]:
                errors.append(_err(q.id, "select at least one option"))
    if errors:
        raise AnswerValidationError(errors)
    return result
