"""Request and response models for the API."""

from __future__ import annotations

from datetime import UTC, datetime
from itertools import pairwise
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    field_validator,
    model_validator,
)

from app.textutil import clean_multiline, has_lone_surrogate

QuestionType = Literal["trace", "single_choice", "multiple_choice", "number", "text"]
SessionStatus = Literal["draft", "open", "paused", "closed"]

MAX_TITLE = 200
MAX_PROMPT = 500
MAX_HELP = 1000
MAX_DESCRIPTION = 1000
MAX_LABEL = 80
MAX_QUESTIONS = 20
MAX_ACTIVITIES = 60
MAX_OPTIONS = 30


def _contains_lone_surrogate(data: Any) -> bool:
    """Walk decoded JSON (iteratively) looking for strings that cannot be encoded as UTF-8."""
    stack = [data]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if has_lone_surrogate(item):
                return True
        elif isinstance(item, dict):
            stack.extend(item.keys())
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return False


class _Strict(BaseModel):
    model_config = ConfigDict(extra="ignore")

    @model_validator(mode="before")
    @classmethod
    def _no_lone_surrogates(cls, data: Any) -> Any:

        if _contains_lone_surrogate(data):
            raise ValueError("text contains invalid characters (lone surrogate)")
        return data


class TraceConfig(_Strict):
    mode: Literal["free", "select_sort"] = "free"
    allow_repeats: bool = True
    allow_skip: bool = True
    min_steps: int = Field(2, ge=1, le=50)
    max_steps: int = Field(30, ge=1, le=50)
    activities: list[str] = Field(default_factory=list)
    allow_custom: bool = False
    suggest_existing: bool = True
    max_label_length: int = Field(80, ge=5, le=120)

    @field_validator("activities")
    @classmethod
    def _activities(cls, v: list[str]) -> list[str]:
        from app.normalize import clean_label, normalize_key

        seen: set[str] = set()
        out: list[str] = []
        for a in v:
            c = clean_label(a)
            k = normalize_key(c)
            if not c:
                continue
            if k in seen:
                raise ValueError("duplicate activity in pool")
            seen.add(k)
            out.append(c)
        if len(out) > MAX_ACTIVITIES:
            raise ValueError(f"at most {MAX_ACTIVITIES} activities")
        return out

    @model_validator(mode="after")
    def _check(self) -> TraceConfig:
        if self.min_steps > self.max_steps:
            raise ValueError("min_steps must be <= max_steps")
        if self.mode == "select_sort":
            if len(self.activities) < 2:
                raise ValueError("select_sort needs at least 2 activities in the pool")
            if any(len(a) > self.max_label_length for a in self.activities):
                raise ValueError("activity longer than max_label_length")
        else:
            self.activities = []
        return self


class ChoiceConfig(_Strict):
    options: list[str] = Field(min_length=2, max_length=MAX_OPTIONS)
    max_selected: int | None = Field(None, ge=1)

    @field_validator("options")
    @classmethod
    def _options(cls, v: list[str]) -> list[str]:
        from app.normalize import clean_label

        out = [clean_label(o) for o in v]
        if any(not o or len(o) > 120 for o in out):
            raise ValueError("options must be non-empty and <= 120 characters")
        if len({o.casefold() for o in out}) != len(out):
            raise ValueError("duplicate options")
        if any(o.casefold() == "(no answer)" for o in out):
            raise ValueError("'(no answer)' is reserved for unanswered questions")
        return out


Finite = Annotated[float, Field(allow_inf_nan=False)]


class NumberConfig(_Strict):
    min: Finite | None = None
    max: Finite | None = None
    integer: bool = False
    bins: list[Finite] | None = None

    @model_validator(mode="after")
    def _check(self) -> NumberConfig:
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("min must be <= max")
        if self.bins is not None and (
            len(self.bins) > 20 or any(b2 <= b1 for b1, b2 in pairwise(self.bins))
        ):
            raise ValueError("bins must be strictly ascending (max 20)")
        return self


class TextConfig(_Strict):
    max_length: int = Field(500, ge=1, le=2000)


CONFIG_MODELS: dict[str, type[BaseModel]] = {
    "trace": TraceConfig,
    "single_choice": ChoiceConfig,
    "multiple_choice": ChoiceConfig,
    "number": NumberConfig,
    "text": TextConfig,
}


def _clean_optional_label(v: str | None) -> str | None:
    from app.normalize import clean_label

    if v is None:
        return None
    return clean_label(v) or None


def _clean_optional_text(v: str | None) -> str | None:
    return clean_multiline(v) or None if v is not None else None


class QuestionIn(_Strict):
    id: str | None = None
    type: QuestionType
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT)
    label: str | None = Field(None, max_length=MAX_LABEL)
    help: str | None = Field(None, max_length=MAX_HELP)
    required: bool = True
    config: dict[str, Any] = Field(default_factory=dict)

    @field_validator("prompt")
    @classmethod
    def _prompt(cls, v: str) -> str:
        from app.normalize import clean_label

        c = clean_label(v)
        if not c:
            raise ValueError("prompt must not be empty")
        return c

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        return _clean_optional_label(v)

    @field_validator("help")
    @classmethod
    def _help(cls, v: str | None) -> str | None:
        return None if v is None else clean_multiline(v)

    @model_validator(mode="after")
    def _normalise_config(self) -> QuestionIn:
        model = CONFIG_MODELS[self.type]
        self.config = model.model_validate(self.config).model_dump(exclude_none=False)
        return self


class SettingsModel(_Strict):
    results_public: bool = False
    allow_resubmit: bool = False
    retention_days: int = Field(90, ge=1, le=365)
    k_min: int = Field(5, ge=1, le=50)


class SettingsPatch(_Strict):
    results_public: bool | None = None
    allow_resubmit: bool | None = None
    retention_days: int | None = Field(None, ge=1, le=365)
    k_min: int | None = Field(None, ge=1, le=50)


def _validate_question_list(qs: list[QuestionIn]) -> list[QuestionIn]:
    if not qs:
        raise ValueError("at least one question is required")
    if len(qs) > MAX_QUESTIONS:
        raise ValueError(f"at most {MAX_QUESTIONS} questions")
    if not any(q.type == "trace" for q in qs):
        raise ValueError("at least one trace question is required")
    ids = [q.id for q in qs if q.id]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate question ids")
    return qs


class SessionCreate(_Strict):
    title: str = Field(min_length=1, max_length=MAX_TITLE)
    description: str | None = Field(None, max_length=MAX_DESCRIPTION)
    questions: list[QuestionIn]
    settings: SettingsPatch | None = None

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        from app.normalize import clean_label

        c = clean_label(v)
        if not c:
            raise ValueError("title must not be empty")
        return c

    @field_validator("description")
    @classmethod
    def _description(cls, v: str | None) -> str | None:
        return _clean_optional_text(v)

    @field_validator("questions")
    @classmethod
    def _questions(cls, v: list[QuestionIn]) -> list[QuestionIn]:
        return _validate_question_list(v)


class QuestionsPut(_Strict):
    questions: list[QuestionIn]

    @field_validator("questions")
    @classmethod
    def _questions(cls, v: list[QuestionIn]) -> list[QuestionIn]:
        return _validate_question_list(v)


class SessionPatch(_Strict):
    status: SessionStatus | None = None
    title: str | None = Field(None, min_length=1, max_length=MAX_TITLE)

    description: str | None = Field(None, max_length=MAX_DESCRIPTION)
    settings: SettingsPatch | None = None

    @field_validator("description")
    @classmethod
    def _description(cls, v: str | None) -> str | None:
        return _clean_optional_text(v)


class QuestionTextPatch(_Strict):
    prompt: str | None = Field(None, min_length=1, max_length=MAX_PROMPT)
    label: str | None = Field(None, max_length=MAX_LABEL)
    help: str | None = Field(None, max_length=MAX_HELP)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        return _clean_optional_label(v)

    @field_validator("help")
    @classmethod
    def _help(cls, v: str | None) -> str | None:
        return None if v is None else clean_multiline(v)


class JoinIn(_Strict):
    token: str | None = Field(None, max_length=200)


class AnswerIn(_Strict):
    question_id: str
    value: dict[str, Any] | None = None


class ResponseIn(_Strict):
    answers: list[AnswerIn] = Field(max_length=MAX_QUESTIONS)


class AliasIn(_Strict):
    raw_key: str = Field(min_length=1, max_length=300)
    canonical: str | None = Field(None, max_length=200)
    hidden: bool = False


class AliasesPut(_Strict):
    question_id: str
    aliases: list[AliasIn] = Field(max_length=2000)


class QuestionOut(BaseModel):
    id: str
    position: int
    type: QuestionType
    prompt: str
    label: str | None
    help: str | None
    required: bool
    config: dict[str, Any]


class PublicSessionOut(BaseModel):
    code: str
    title: str
    description: str | None
    status: SessionStatus
    questions: list[QuestionOut]
    settings: dict[str, Any]


def utc_z(value: datetime) -> str:
    """ISO 8601, always UTC with a trailing Z (SQLite hands back naive datetimes)."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


UtcDatetime = Annotated[datetime, PlainSerializer(utc_z, return_type=str)]


class AdminSessionOut(PublicSessionOut):
    joined: int
    submitted: int
    version: int
    created_at: UtcDatetime
    opened_at: UtcDatetime | None
    closed_at: UtcDatetime | None
    expires_at: UtcDatetime | None
    display_key: str


class SessionCreated(BaseModel):
    code: str
    admin_key: str
    display_key: str
    session: AdminSessionOut


class JoinOut(BaseModel):
    participant_token: str
    has_submitted: bool


class ResponseCreated(BaseModel):
    response_id: str


class _Doc(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ErrorItem(_Doc):
    """One entry of ``errors``: ``question_id`` for answers, ``field`` for other requests."""

    message: str
    field: str | None = None
    question_id: str | None = None


class ErrorOut(_Doc):
    detail: str
    message: str
    errors: list[ErrorItem] | None = None


class MetaOut(_Doc):
    version: str
    demo_mode: bool = False


class LabelRowOut(_Doc):
    raw_key: str
    display: str
    count: int
    canonical: str | None
    hidden: bool


class MergeSuggestionOut(_Doc):
    raw_keys: list[str]
    similarity: float
    proposed_canonical: str


class LabelsOut(_Doc):
    question_id: str
    labels: list[LabelRowOut]
    suggestions: list[MergeSuggestionOut]


class AliasesSaved(_Doc):
    ok: bool
    version: int


class SuggestOut(_Doc):
    labels: list[str]


class FilterOut(_Doc):
    question_id: str
    value: str


class KpisOut(_Doc):
    n: int
    n_variants: int
    variant_ratio: float
    top_variant_share: float
    coverage_top5: float
    mean_length: float
    start_agreement: float
    end_agreement: float


class VariantOut(_Doc):
    steps: list[str]
    count: int
    share: float
    cumulative_share: float


class ActivityOut(_Doc):
    label: str
    count: int
    case_count: int
    repeat_traces: int
    mean_position: float
    start_count: int
    end_count: int


class DfgNodeOut(_Doc):
    id: str
    label: str
    kind: Literal["start", "end", "activity"]
    count: int
    case_count: int


class DfgEdgeOut(_Doc):
    source: str
    target: str
    count: int
    case_count: int


class DfgOut(_Doc):
    nodes: list[DfgNodeOut]
    edges: list[DfgEdgeOut]


class StrongEdgeOut(_Doc):
    source: str
    target: str
    support: int
    share: float
    ci_low: float
    ci_high: float


class ContinuationOut(_Doc):
    target: str
    count: int
    share: float


class HotspotOut(_Doc):
    activity: str
    support: int
    dominant_share: float
    ci_low: float
    ci_high: float
    entropy_norm: float
    disagreement_mass: int
    continuations: list[ContinuationOut]


class MedoidOut(_Doc):
    steps: list[str]
    mean_distance: float

    approximate: bool


class ConsensusOut(_Doc):
    min_support: int
    theta: float
    strong: list[StrongEdgeOut]
    hotspots: list[HotspotOut]
    low_support: list[str]
    medoid: MedoidOut | None


class AnalyticsCore(_Doc):
    """The analysis of one set of traces (also the ``analytics`` of a comparison group)."""

    n: int
    kpis: KpisOut
    variants: list[VariantOut]
    activities: list[ActivityOut]
    dfg: DfgOut
    consensus: ConsensusOut


class AnalyticsOut(AnalyticsCore):
    version: int
    question_id: str
    filter: FilterOut | None

    suppressed: bool | None = None


class GroupByOut(_Doc):
    question_id: str
    prompt: str
    label: str | None


class CompareGroupOut(_Doc):
    value: str
    n: int
    analytics: AnalyticsCore


class HiddenGroupOut(_Doc):
    value: str
    n: int


class PairwiseOut(_Doc):
    a: str
    b: str
    js_edges: float
    js_variants: float


class DiffEdgeOut(_Doc):
    source: str
    target: str
    shares: dict[str, float]
    delta: float
    p_value: float | None
    q_value: float | None


class CompareOut(_Doc):
    version: int
    question_id: str
    group_by: GroupByOut
    groups: list[CompareGroupOut]
    hidden_groups: list[HiddenGroupOut]
    pairwise: list[PairwiseOut]
    diff_edges: list[DiffEdgeOut]
    warnings: list[str]
