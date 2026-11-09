"""Synthetic participants for ProcessPoll demos and load tests ("morning routine").

Shared by ``simulate.py`` and ``locustfile.py``. Pure standard library, no I/O.

Model
-----
* A participant has a *role* (Student / Lecturer) and a process-mining
  *experience* (None / Basic / Advanced). Both influence behaviour:
  students check their phone first and often skip breakfast, lecturers make
  coffee before anything else and check e-mail, experienced participants add
  planning steps, novices skip optional steps.
* Every activity has a typical *slot* (position in the morning) and an
  inclusion probability per role. The trace is the list of included activities
  ordered by ``slot + noise``, so the order varies a little between people.
* In ``free`` mode the label a participant types is a noisy rendering of the
  canonical activity: synonyms ("check mail" / "read emails"), typos, casing,
  trailing punctuation, extra whitespace, a few German labels. In
  ``select_sort`` mode labels are exactly the canonical pool entries.

All functions take an explicit ``random.Random`` so runs are reproducible
(``--seed``).
"""
from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field
from typing import Any


ROLES: dict[str, float] = {"Student": 0.7, "Lecturer": 0.3}
EXPERIENCE_LEVELS: list[str] = ["None", "Basic", "Advanced"]
EXPERIENCE_WEIGHTS: dict[str, list[float]] = {
    "Student": [0.50, 0.35, 0.15],
    "Lecturer": [0.10, 0.40, 0.50],
}


VARIANTS: dict[str, list[str]] = {
    "Wake up": ["Wake up", "get up", "wake-up", "wakeup", "alarm rings", "Aufstehen"],
    "Check phone": ["Check phone", "look at phone", "scroll social media", "check my phone", "phone"],
    "Shower": ["Shower", "take a shower", "have a shower", "showering", "Duschen"],
    "Brush teeth": ["Brush teeth", "brushing teeth", "brush my teeth", "clean teeth", "Zähne putzen"],
    "Get dressed": ["Get dressed", "dress", "put on clothes", "get dressed up", "Anziehen"],
    "Make coffee": ["Make coffee", "coffee", "drink coffee", "have coffee", "Kaffee kochen"],
    "Eat breakfast": ["Eat breakfast", "breakfast", "have breakfast", "eat something", "Frühstück"],
    "Check email": ["Check email", "check mail", "read emails", "check e-mails", "read mails", "emails"],
    "Read news": ["Read news", "read the news", "news", "check news"],
    "Plan day": ["Plan day", "plan my day", "make a todo list", "plan the day"],
    "Check calendar": ["Check calendar", "look at calendar", "check my calendar", "calendar"],
    "Pack bag": ["Pack bag", "pack my bag", "pack backpack", "get my stuff"],
    "Commute": ["Commute", "go to work", "leave home", "take the bus", "drive to uni", "walk to uni"],
}


POOL: list[str] = [
    "Wake up", "Check phone", "Shower", "Brush teeth", "Get dressed", "Make coffee",
    "Eat breakfast", "Check email", "Read news", "Plan day", "Check calendar",
    "Pack bag", "Commute",
]


_PROFILE: dict[str, dict[str, tuple[float, float]]] = {
    "Student": {
        "Wake up": (1.00, 0.0), "Check phone": (0.85, 0.8), "Shower": (0.75, 2.0),
        "Brush teeth": (0.95, 2.6), "Get dressed": (0.98, 3.0), "Make coffee": (0.50, 3.6),
        "Eat breakfast": (0.45, 3.8), "Check email": (0.20, 4.2), "Read news": (0.25, 4.0),
        "Plan day": (0.10, 4.4), "Check calendar": (0.05, 4.1), "Pack bag": (0.70, 4.5),
        "Commute": (1.00, 9.0),
    },
    "Lecturer": {
        "Wake up": (1.00, 0.0), "Make coffee": (0.95, 0.8), "Check phone": (0.35, 0.9),
        "Shower": (0.90, 2.0), "Brush teeth": (0.95, 2.6), "Get dressed": (0.98, 3.0),
        "Eat breakfast": (0.85, 3.4), "Read news": (0.50, 3.8), "Check email": (0.75, 4.0),
        "Check calendar": (0.40, 4.1), "Plan day": (0.45, 4.4), "Pack bag": (0.55, 4.6),
        "Commute": (1.00, 9.0),
    },
}
_FIXED_SLOT = {"Wake up", "Commute"}


@dataclass
class Participant:
    role: str
    experience: str
    steps: list[str]
    extras: dict[str, Any] = field(default_factory=dict)


def pick_role(rng: random.Random, weights: dict[str, float] | None = None) -> str:
    weights = weights or ROLES
    return rng.choices(list(weights), weights=list(weights.values()))[0]


def pick_experience(rng: random.Random, role: str) -> str:
    weights = EXPERIENCE_WEIGHTS.get(role, EXPERIENCE_WEIGHTS["Student"])
    return rng.choices(EXPERIENCE_LEVELS, weights=weights)[0]


def generate_canonical_steps(rng: random.Random, role: str, experience: str, allow_repeats: bool = True) -> list[str]:
    """Canonical activity sequence for one participant (no label noise yet)."""
    profile = _PROFILE.get(role, _PROFILE["Student"])
    scored: list[tuple[float, str]] = []
    for activity, (p, slot) in profile.items():
        if activity in ("Plan day", "Check calendar"):
            p += {"None": -0.05, "Basic": 0.0, "Advanced": 0.30}[experience]
        elif activity not in _FIXED_SLOT:
            p -= {"None": 0.10, "Basic": 0.0, "Advanced": 0.0}[experience]
        if rng.random() < max(0.0, min(1.0, p)):
            jitter = 0.0 if activity in _FIXED_SLOT else rng.gauss(0.0, 0.45)
            scored.append((slot + jitter, activity))
    scored.sort()
    steps = [a for _, a in scored]

    if allow_repeats and "Check phone" in steps and rng.random() < 0.12:
        pos = rng.randint(max(1, len(steps) - 3), len(steps) - 1)
        steps.insert(pos, "Check phone")
    return steps


_NEIGHBOURS = "qwertzuiopasdfghjklyxcvbnm"


def _typo(rng: random.Random, text: str) -> str:
    letters = [i for i, c in enumerate(text) if c.isalpha()]
    if len(letters) < 4:
        return text
    i = rng.choice(letters[1:-1] or letters)
    op = rng.choice(("swap", "delete", "double", "replace"))
    if op == "swap" and i + 1 < len(text) and text[i + 1].isalpha():
        return text[:i] + text[i + 1] + text[i] + text[i + 2:]
    if op == "delete":
        return text[:i] + text[i + 1:]
    if op == "double":
        return text[:i] + text[i] + text[i:]
    return text[:i] + rng.choice(_NEIGHBOURS) + text[i + 1:]


def render_label(rng: random.Random, canonical: str, noise: float = 0.25, max_len: int = 80) -> str:
    """Turn a canonical activity into what a participant might actually type.

    ``noise`` in [0, 1]: 0 = always the canonical label, 0.25 = typical,
    1 = very messy.
    """
    noise = max(0.0, min(1.0, noise))
    variants = VARIANTS.get(canonical, [canonical])
    if len(variants) > 1 and rng.random() < min(0.8, 1.6 * noise):
        text = rng.choice(variants[1:])
    else:
        text = variants[0]
    if rng.random() < 0.5 * noise:
        text = rng.choice((str.lower, str.upper, str.capitalize, str.title))(text)
    if rng.random() < 0.35 * noise:
        text = _typo(rng, text)
    if rng.random() < 0.30 * noise:
        text += rng.choice((".", "!", " ."))
    if rng.random() < 0.10 * noise:
        text = f" {text}  " if rng.random() < 0.5 else text.replace(" ", "  ", 1)
    return text[:max_len]


def render_labels(rng: random.Random, steps: list[str], noise: float, max_len: int = 80) -> list[str]:
    return [render_label(rng, s, noise, max_len) for s in steps]


def new_idempotency_key() -> str:
    return uuid.uuid4().hex


def session_payload(
    title: str = "Morning routine (demo)",
    mode: str = "free",
    results_public: bool = False,
    allow_resubmit: bool = False,
    retention_days: int = 7,
    k_min: int = 5,
) -> dict[str, Any]:
    """Body for ``POST /api/v1/sessions``: trace + role + experience question."""
    if mode not in ("free", "select_sort"):
        raise ValueError("mode must be 'free' or 'select_sort'")
    trace_config = {
        "mode": mode,
        "allow_repeats": True,
        "allow_skip": True,
        "min_steps": 2,
        "max_steps": 30,
        "activities": list(POOL) if mode == "select_sort" else [],
        "allow_custom": False,
        "suggest_existing": True,
        "max_label_length": 80,
    }
    return {
        "title": title,
        "questions": [
            {
                "type": "trace",
                "prompt": "Describe your typical morning routine, from waking up until you leave home.",
                "help": "One activity per step, in the order you usually do them.",
                "required": True,
                "config": trace_config,
            },
            {
                "type": "single_choice",
                "prompt": "What is your role?",
                "help": None,
                "required": True,
                "config": {"options": list(ROLES)},
            },
            {
                "type": "single_choice",
                "prompt": "How much process mining experience do you have?",
                "help": None,
                "required": True,
                "config": {"options": list(EXPERIENCE_LEVELS)},
            },
        ],
        "settings": {
            "results_public": results_public,
            "allow_resubmit": allow_resubmit,
            "retention_days": retention_days,
            "k_min": k_min,
        },
    }


def _choose_option(rng: random.Random, options: list[str], role: str, experience: str) -> str:
    lowered = {o.lower(): o for o in options}
    if set(ROLES) <= set(options):
        return role
    if set(EXPERIENCE_LEVELS) <= set(options):
        return experience

    for candidate in (role, experience):
        if candidate.lower() in lowered and rng.random() < 0.9:
            return lowered[candidate.lower()]
    return rng.choice(options)


def _trace_steps(rng: random.Random, cfg: dict[str, Any], participant: Participant, noise: float) -> list[str]:
    mode = cfg.get("mode", "free")
    min_steps = int(cfg.get("min_steps", 2))
    max_steps = int(cfg.get("max_steps", 30))
    allow_repeats = bool(cfg.get("allow_repeats", True))
    max_len = int(cfg.get("max_label_length", 80))
    steps = list(participant.steps)
    if not allow_repeats:
        seen: set[str] = set()
        steps = [s for s in steps if not (s in seen or seen.add(s))]

    if mode == "select_sort":
        pool = list(cfg.get("activities") or POOL)
        by_lower = {p.lower(): p for p in pool}
        mapped = [by_lower[s.lower()] for s in steps if s.lower() in by_lower]
        if len(mapped) < min_steps:
            mapped = rng.sample(pool, k=min(len(pool), max(min_steps, 3)))
        labels = mapped
    else:
        labels = render_labels(rng, steps, noise, max_len)

    labels = labels[:max_steps]
    while len(labels) < min_steps:
        labels.append(render_label(rng, rng.choice(POOL), noise, max_len))
    return labels


def make_participant(rng: random.Random, role_weights: dict[str, float] | None = None, allow_repeats: bool = True) -> Participant:
    role = pick_role(rng, role_weights)
    experience = pick_experience(rng, role)
    return Participant(role, experience, generate_canonical_steps(rng, role, experience, allow_repeats))


_TEXTS = [
    "Mornings are hectic.", "I usually have no time for breakfast.", "Depends on the day.",
    "Always the same order.", "Kids come first.", "",
]


def generate_answers(
    rng: random.Random,
    questions: list[dict[str, Any]],
    noise: float = 0.25,
    role_weights: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """Answers (``AnswerIn[]``) for every question of a session, whatever its structure."""
    allow_repeats = all(
        q["config"].get("allow_repeats", True) for q in questions if q["type"] == "trace"
    )
    participant = make_participant(rng, role_weights, allow_repeats)
    answers: list[dict[str, Any]] = []
    for q in sorted(questions, key=lambda x: x.get("position", 0)):
        qtype, cfg = q["type"], q.get("config") or {}
        value: dict[str, Any] | None
        if not q.get("required", True) and rng.random() < 0.1:
            value = None
        elif qtype == "trace":
            value = {"steps": _trace_steps(rng, cfg, participant, noise)}
        elif qtype == "single_choice":
            value = {"value": _choose_option(rng, list(cfg["options"]), participant.role, participant.experience)}
        elif qtype == "multiple_choice":
            options = list(cfg["options"])
            limit = int(cfg.get("max_selected") or len(options))
            k = rng.randint(1, max(1, min(limit, 3, len(options))))
            value = {"values": rng.sample(options, k=k)}
        elif qtype == "number":
            lo, hi = cfg.get("min", 0), cfg.get("max", 10)
            if cfg.get("integer", True):
                value = {"value": rng.randint(int(lo), int(hi))}
            else:
                value = {"value": round(rng.uniform(float(lo), float(hi)), 1)}
        elif qtype == "text":
            text = rng.choice(_TEXTS) or ("" if not q.get("required", True) else "ok")
            value = {"value": text[: int(cfg.get("max_length", 500))]} if text else None
        else:
            value = None
        answers.append({"question_id": q["id"], "value": value})
    return answers


def trace_question(questions: list[dict[str, Any]]) -> dict[str, Any] | None:
    return next((q for q in sorted(questions, key=lambda x: x.get("position", 0)) if q["type"] == "trace"), None)


def role_question(questions: list[dict[str, Any]]) -> dict[str, Any] | None:
    for q in questions:
        if q["type"] == "single_choice" and set(ROLES) <= set(q["config"].get("options", [])):
            return q
    return next((q for q in questions if q["type"] == "single_choice"), None)


if __name__ == "__main__":
    demo_rng = random.Random(1)
    demo_questions = [
        {"id": "t", "position": 0, "type": "trace", "required": True, "config": session_payload()["questions"][0]["config"]},
        {"id": "r", "position": 1, "type": "single_choice", "required": True, "config": {"options": list(ROLES)}},
        {"id": "e", "position": 2, "type": "single_choice", "required": True, "config": {"options": EXPERIENCE_LEVELS}},
    ]
    for _ in range(5):
        print(generate_answers(demo_rng, demo_questions))
