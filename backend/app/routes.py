"""HTTP API for creating and managing polls, responses and results."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Hashable
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import analytics_service as asvc
from app import export as exporter
from app import service as svc
from app.analytics import analyze
from app.config import DEMO_RETENTION_DAYS, Settings
from app.errors import ApiError
from app.live import Busy, LiveHub
from app.models import (
    AnswerRow,
    LabelAliasRow,
    ParticipantRow,
    QuestionRow,
    ResponseRow,
    SessionRow,
    new_id,
    utcnow,
)
from app.normalize import clean_label, normalize_key
from app.schemas import (
    AdminSessionOut,
    AliasesPut,
    AliasesSaved,
    AnalyticsOut,
    CompareOut,
    ErrorOut,
    JoinIn,
    JoinOut,
    LabelsOut,
    MetaOut,
    PublicSessionOut,
    QuestionsPut,
    QuestionTextPatch,
    ResponseCreated,
    ResponseIn,
    SessionCreate,
    SessionCreated,
    SessionPatch,
    SettingsModel,
    SuggestOut,
)
from app.security import (
    SlidingWindowLimiter,
    client_key,
    generate_code,
    generate_secret,
    hash_secret,
    normalize_code,
    verify_secret,
)
from app.validation import AnswerValidationError, validate_answers

_STATUS_TEXT = {
    401: "Admin/display key or participant token missing or invalid",
    403: "Session not open",
    404: "Unknown session or question",
    409: "Conflict with the current state",
    503: "Busy computing, retry shortly (Retry-After header)",
}


def _err(*codes: int) -> dict[int | str, dict[str, Any]]:
    return {c: {"model": ErrorOut, "description": _STATUS_TEXT[c]} for c in codes}


router = APIRouter(
    prefix="/api/v1",
    responses={
        413: {"model": ErrorOut, "description": "Request body too large"},
        422: {"model": ErrorOut, "description": "Validation failed (see errors)"},
        429: {"model": ErrorOut, "description": "Rate limited"},
        500: {"model": ErrorOut, "description": "Unexpected server error"},
    },
)

TRANSITIONS = {
    "draft": {"open"},
    "open": {"paused", "closed"},
    "paused": {"open", "closed"},
    "closed": set(),
}

MAX_ALIAS_KEY = 300
MAX_TICK_STRETCH = 5.0


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.db.sessionmaker() as session:
        yield session


DB = Annotated[AsyncSession, Depends(get_db)]


def hub_of(request: Request) -> LiveHub:
    return request.app.state.hub


def settings_of(request: Request) -> Settings:
    return request.app.state.settings


def limiter_of(request: Request) -> SlidingWindowLimiter:
    return request.app.state.limiter


def client_ip(request: Request) -> str:
    return client_key(
        request.client.host if request.client else None,
        request.headers.get("x-forwarded-for"),
        trusted=settings_of(request).trusted_proxy,
    )


def extract_key(request: Request) -> str | None:
    return (
        request.headers.get("x-admin-key")
        or request.headers.get("x-display-key")
        or request.query_params.get("key")
    )


async def load_session(db: AsyncSession, code: str, request: Request) -> SessionRow:
    normalized = normalize_code(code)
    row = await svc.get_session_row(db, normalized) if normalized else None
    if row is None:
        cfg = settings_of(request)
        if not limiter_of(request).allow(
            f"miss:{client_ip(request)}", cfg.unknown_code_per_minute, 60
        ):
            raise ApiError(429, "rate_limited", "Too many unknown session codes, slow down")
        raise ApiError(404, "not_found", "Session not found")
    return row


async def load_session_public(db: AsyncSession, code: str, request: Request) -> SessionRow:
    """``load_session`` for the hot public read paths (session config, autocomplete).

    Joining participants poll the session and type into the autocomplete, which made these
    two paths ~65 % of all requests in the load test, each costing two database queries. A
    detached row is cached for a few seconds instead. Status, settings, titles and questions
    only change through the admin endpoints below, which drop the entry (``session_drop``)."""
    normalized = normalize_code(code)
    hub = hub_of(request)
    hit = hub.session_get(normalized) if normalized else None
    if hit is not None:
        return hit
    epoch = hub.session_epoch(normalized)
    row = await load_session(db, code, request)
    db.expunge(row)
    hub.session_put(normalized, row, epoch)
    return row


def role_of(row: SessionRow, key: str | None) -> str | None:
    if verify_secret(key, row.admin_key_hash):
        return "admin"
    if verify_secret(key, row.display_key_hash):
        return "display"
    return None


def require_admin(row: SessionRow, request: Request) -> None:
    if role_of(row, extract_key(request)) != "admin":
        raise ApiError(401, "invalid_key", "Admin key required")


def require_read(row: SessionRow, request: Request) -> str | None:
    """Authorise a read; returns the role of the key ("admin" / "display"), None if public."""
    role = role_of(row, extract_key(request))
    if role is not None:
        return role
    if svc.full_settings(row)["results_public"]:
        return None
    raise ApiError(401, "invalid_key", "Valid key required")


async def cached(
    request: Request, key: Hashable, producer: Callable[[AsyncSession], Awaitable[Any]]
) -> Any:
    """Cache + single-flight for expensive read models.

    The producer gets its own DB session: it runs in a shared task that must outlive the
    request that triggered it (and the request's session). Callers must release their own
    session first (``await db.close()``): a request that keeps its connection while waiting
    for a producer that needs another one deadlocks the pool under concurrent load."""
    hub = hub_of(request)
    hit = hub.cache_get(key)
    if hit is not None:
        return hit

    async def run() -> Any:
        started = time.perf_counter()
        async with request.app.state.db.sessionmaker() as session:
            value = await producer(session)
        hub.record_compute(time.perf_counter() - started)
        hub.cache_put(key, value)
        return value

    try:
        return await hub.single_flight(key, run)
    except (Busy, TimeoutError):
        raise ApiError(
            503,
            "busy",
            "The server is busy computing results, retry shortly",
            headers={"Retry-After": "2"},
        ) from None


async def publish_state(request: Request, db: AsyncSession, code: str) -> None:
    hub = hub_of(request)
    async with hub.publishing(code):
        state = await svc.live_state(db, code)
        if state is not None:
            hub.publish(code, state)


@router.get("/meta", response_model=MetaOut, response_model_exclude_none=True)
async def meta(request: Request) -> dict[str, Any]:
    settings = settings_of(request)
    return {"version": request.app.version, "demo_mode": settings.demo_mode}


@router.post("/sessions", status_code=201, response_model=SessionCreated)
async def create_session(body: SessionCreate, request: Request, db: DB) -> SessionCreated:
    cfg = settings_of(request)
    if not limiter_of(request).allow(
        f"create:{client_ip(request)}", cfg.session_create_per_hour, 3600
    ):
        raise ApiError(429, "rate_limited", "Too many sessions created, try again later")
    settings = SettingsModel.model_validate(
        body.settings.model_dump(exclude_none=True) if body.settings else {}
    )
    if cfg.demo_mode:
        settings.retention_days = DEMO_RETENTION_DAYS
    admin_key, display_key = generate_secret(), generate_secret()
    now = utcnow()
    for _ in range(20):
        row = SessionRow(
            id=new_id(),
            code=generate_code(),
            title=body.title,
            description=body.description,
            status="draft",
            settings=settings.model_dump(),
            admin_key_hash=hash_secret(admin_key),
            display_key_hash=hash_secret(display_key),
            display_key=display_key,
            created_at=now,
        )
        row.expires_at = svc.expiry_for(row, settings.retention_days)
        row.questions = svc.question_rows_from_input(row.id, body.questions)
        db.add(row)
        try:
            await db.commit()
            break
        except IntegrityError:
            await db.rollback()
    else:
        raise ApiError(503, "code_generation_failed", "Could not allocate a join code")
    fresh = await load_session(db, row.code, request)
    await publish_state(request, db, fresh.code)
    return SessionCreated(
        code=fresh.code,
        admin_key=admin_key,
        display_key=display_key,
        session=await svc.admin_session(db, fresh),
    )


@router.get("/sessions/{code}", response_model=PublicSessionOut, responses=_err(404))
async def get_public_session(code: str, request: Request, db: DB) -> PublicSessionOut:
    return svc.public_session(await load_session_public(db, code, request))


@router.get("/sessions/{code}/admin", response_model=AdminSessionOut, responses=_err(401, 404))
async def get_admin_session(code: str, request: Request, db: DB) -> AdminSessionOut:
    row = await load_session(db, code, request)
    require_admin(row, request)
    return await svc.admin_session(db, row)


@router.patch("/sessions/{code}", response_model=AdminSessionOut, responses=_err(401, 404, 409))
async def patch_session(code: str, body: SessionPatch, request: Request, db: DB) -> AdminSessionOut:
    cfg = settings_of(request)
    row = await load_session(db, code, request)
    require_admin(row, request)
    title_changed = False
    if body.title is not None:
        title = clean_label(body.title)
        if not title:
            raise ApiError(422, "validation_error", "title must not be empty")
        title_changed = title != row.title
        row.title = title
    if "description" in body.model_fields_set and body.description != row.description:
        row.description = body.description
        title_changed = True
    settings_changed = False
    if body.settings is not None:
        current = svc.full_settings(row)
        merged = {**current, **body.settings.model_dump(exclude_none=True)}
        if cfg.demo_mode:
            merged["retention_days"] = DEMO_RETENTION_DAYS
        row.settings = SettingsModel.model_validate(merged).model_dump()
        settings_changed = row.settings != current
        expiry = svc.expiry_for(row, row.settings["retention_days"])
        if cfg.demo_mode:
            expiry = min(expiry, row.created_at + timedelta(days=DEMO_RETENTION_DAYS))
        row.expires_at = expiry
    if body.status is not None and body.status != row.status:
        if body.status not in TRANSITIONS[row.status]:
            raise ApiError(
                409,
                "invalid_transition",
                f"Cannot change status from {row.status} to {body.status}",
            )
        now = utcnow()
        changes: dict[str, Any] = {"status": body.status}
        if body.status == "open" and row.opened_at is None:
            changes["opened_at"] = now
        if body.status == "closed":
            changes["closed_at"] = now
            expires_at = now + timedelta(days=row.settings.get("retention_days", 90))
            if cfg.demo_mode:
                expires_at = min(expires_at, row.created_at + timedelta(days=DEMO_RETENTION_DAYS))
            changes["expires_at"] = expires_at

        if not await svc.update_session_if_status(db, row.id, row.status, **changes):
            raise ApiError(409, "invalid_transition", "The session status changed concurrently")
    if settings_changed or title_changed:
        await svc.bump_version(db, row.id)
    await db.commit()
    hub_of(request).session_drop(row.code)
    await publish_state(request, db, row.code)
    return await svc.admin_session(db, await load_session(db, row.code, request))


@router.put(
    "/sessions/{code}/questions", response_model=AdminSessionOut, responses=_err(401, 404, 409)
)
async def put_questions(code: str, body: QuestionsPut, request: Request, db: DB) -> AdminSessionOut:
    row = await load_session(db, code, request)
    require_admin(row, request)
    if row.status != "draft":
        raise ApiError(409, "questions_locked", "Questions can only be edited in draft status")

    if not await svc.bump_version(db, row.id, require_status="draft"):
        raise ApiError(409, "questions_locked", "Questions can only be edited in draft status")
    row.questions = svc.question_rows_from_input(row.id, body.questions)
    await db.commit()
    hub_of(request).session_drop(row.code)
    return await svc.admin_session(db, await load_session(db, row.code, request))


@router.patch(
    "/sessions/{code}/questions/{question_id}",
    response_model=AdminSessionOut,
    responses=_err(401, 404),
)
async def patch_question_text(
    code: str, question_id: str, body: QuestionTextPatch, request: Request, db: DB
) -> AdminSessionOut:
    row = await load_session(db, code, request)
    require_admin(row, request)
    q = next((q for q in row.questions if q.id == question_id), None)
    if q is None:
        raise ApiError(404, "not_found", "Question not found")
    data = body.model_dump(exclude_unset=True)
    prompt_changed = False
    if "prompt" in data and data["prompt"] is not None:
        prompt = clean_label(data["prompt"])
        if not prompt:
            raise ApiError(422, "validation_error", "prompt must not be empty")
        prompt_changed = prompt != q.prompt
        q.prompt = prompt
    label_changed = False
    if "label" in data:
        label_changed = data["label"] != q.label
        q.label = data["label"]
    if "help" in data:
        q.help = data["help"]
    texts_changed = prompt_changed or label_changed
    if texts_changed:
        await svc.bump_version(db, row.id)
    await db.commit()
    hub_of(request).session_drop(row.code)
    if texts_changed:
        await publish_state(request, db, row.code)
    return await svc.admin_session(db, await load_session(db, row.code, request))


@router.delete("/sessions/{code}", status_code=204, responses=_err(401, 404))
async def delete_session(code: str, request: Request, db: DB) -> Response:
    row = await load_session(db, code, request)
    require_admin(row, request)
    await svc.delete_session(db, row)
    await db.commit()
    hub_of(request).forget(row.code)
    return Response(status_code=204)


@router.post("/sessions/{code}/join", response_model=JoinOut, responses=_err(403, 404))
async def join(code: str, request: Request, db: DB, body: JoinIn | None = None) -> JoinOut:
    row = await load_session(db, code, request)
    cfg = settings_of(request)
    token = body.token if body else None
    if token:
        participant = await svc.find_participant(db, row.id, hash_secret(token))
        if participant is not None:
            has = await svc.current_response(db, participant.id) is not None
            return JoinOut(participant_token=token, has_submitted=has)
    if row.status == "closed":
        raise ApiError(403, "session_not_open", "This session is closed")
    if not limiter_of(request).allow(f"join:{row.code}", cfg.join_per_minute_per_session, 60):
        raise ApiError(429, "rate_limited", "Too many participants joining at once, retry shortly")
    new_token = generate_secret()
    db.add(ParticipantRow(session_id=row.id, token_hash=hash_secret(new_token)))
    await svc.bump_joined(db, row.id)
    await db.commit()
    await publish_state(request, db, row.code)
    return JoinOut(participant_token=new_token, has_submitted=False)


@router.post(
    "/sessions/{code}/responses",
    response_model=ResponseCreated,
    status_code=201,
    responses={
        **_err(401, 403, 404, 409),
        200: {"model": ResponseCreated, "description": "Replay of an Idempotency-Key"},
    },
)
async def submit_response(
    code: str,
    body: ResponseIn,
    request: Request,
    response: Response,
    db: DB,
    x_participant_token: Annotated[str | None, Header()] = None,
    idempotency_key: Annotated[str | None, Header(max_length=100)] = None,
) -> ResponseCreated:
    row = await load_session(db, code, request)
    if not x_participant_token:
        raise ApiError(401, "invalid_token", "Participant token required")
    participant = await svc.find_participant(db, row.id, hash_secret(x_participant_token))
    if participant is None:
        raise ApiError(401, "invalid_token", "Unknown participant token")

    session_id, session_code, participant_id = row.id, row.code, participant.id

    async def replay() -> ResponseCreated | None:
        if not idempotency_key:
            return None
        stmt = select(ResponseRow).where(
            ResponseRow.session_id == session_id, ResponseRow.submission_key == idempotency_key
        )
        existing = (await db.execute(stmt)).scalar_one_or_none()
        if existing is None:
            return None
        if existing.participant_id != participant_id:
            raise ApiError(409, "idempotency_conflict", "Idempotency key already used")
        response.status_code = 200
        return ResponseCreated(response_id=existing.id)

    if (replayed := await replay()) is not None:
        return replayed
    if row.status != "open":
        raise ApiError(403, "session_not_open", "This session is not accepting responses")
    allow_resubmit = svc.full_settings(row)["allow_resubmit"]
    current = await svc.current_response(db, participant_id)
    if current is not None and not allow_resubmit:
        raise ApiError(409, "already_submitted", "You have already submitted a response")
    try:
        values = validate_answers(row.questions, body.answers)
    except AnswerValidationError as exc:
        raise ApiError(422, "validation_error", "Some answers are invalid", exc.errors) from exc

    new_response = ResponseRow(
        id=new_id(),
        session_id=session_id,
        participant_id=participant_id,
        submission_key=idempotency_key,
        submitted_at=utcnow(),
        is_current=True,
    )
    try:
        if current is not None:
            await db.execute(delete(AnswerRow).where(AnswerRow.response_id == current.id))
            current.is_current = False
            await db.flush()
        db.add(new_response)
        for question_id, value in values.items():
            new_response.answers.append(AnswerRow(question_id=question_id, value=value))

        if not await svc.bump_version(db, session_id, require_status="open"):
            await db.rollback()
            raise ApiError(403, "session_not_open", "This session is not accepting responses")
        await db.commit()
    except IntegrityError:
        await db.rollback()
        if (replayed := await replay()) is not None:
            return replayed
        raise ApiError(409, "already_submitted", "You have already submitted a response") from None
    await publish_state(request, db, session_code)
    return ResponseCreated(response_id=new_response.id)


async def _raw_traces(db: AsyncSession, row: SessionRow, question_id: str) -> list[list[str]]:
    responses = await svc.load_responses(db, row.id)
    out = []
    for r in responses:
        ans = r.answers.get(question_id)
        if ans and "steps" in ans:
            out.append(list(ans["steps"]))
    return out


def _label_view(raw_traces: list[list[str]], aliases: dict[str, Any]) -> dict[str, Any]:
    rows = asvc.label_rows(raw_traces, aliases)
    return {"labels": rows, "suggestions": asvc.merge_suggestions(rows)}


@router.get("/sessions/{code}/labels", response_model=LabelsOut, responses=_err(401, 404))
async def get_labels(
    code: str, request: Request, db: DB, question_id: Annotated[str, Query()]
) -> dict[str, Any]:
    row = await load_session(db, code, request)
    require_admin(row, request)
    asvc.trace_question(row, question_id)
    aliases = await svc.load_aliases(db, question_id)
    raw = await _raw_traces(db, row, question_id)

    view = await asyncio.to_thread(_label_view, raw, aliases)
    return {"question_id": question_id, **view}


@router.put("/sessions/{code}/aliases", response_model=AliasesSaved, responses=_err(401, 404))
async def put_aliases(code: str, body: AliasesPut, request: Request, db: DB) -> dict[str, Any]:
    row = await load_session(db, code, request)
    require_admin(row, request)
    asvc.trace_question(row, body.question_id)
    merged: dict[str, tuple[str | None, bool]] = {}
    for index, item in enumerate(body.aliases):
        key = normalize_key(item.raw_key)
        if not key:
            continue
        if len(key) > MAX_ALIAS_KEY:
            raise ApiError(
                422,
                "validation_error",
                "Label key too long after normalisation",
                [{"field": f"aliases.{index}.raw_key", "message": "normalised key too long"}],
            )
        canonical = clean_label(item.canonical) if item.canonical else None
        merged[key] = (canonical or None, item.hidden)

    await svc.bump_version(db, row.id)
    await db.execute(delete(LabelAliasRow).where(LabelAliasRow.question_id == body.question_id))
    for key, (canonical, hidden) in merged.items():
        if canonical is None and not hidden:
            continue
        db.add(
            LabelAliasRow(
                session_id=row.id,
                question_id=body.question_id,
                raw_key=key,
                canonical=canonical,
                hidden=hidden,
            )
        )
    await db.commit()
    await publish_state(request, db, row.code)
    fresh = await load_session(db, row.code, request)
    return {"ok": True, "version": fresh.version}


SUGGEST_TTL_SECONDS = 5


@router.get("/sessions/{code}/labels/suggest", response_model=SuggestOut, responses=_err(404, 503))
async def suggest(
    code: str,
    request: Request,
    db: DB,
    question_id: Annotated[str, Query()],
    q: Annotated[str, Query(max_length=120)] = "",
) -> dict[str, Any]:
    """Autocomplete from labels other participants already used (no counts, no auth)."""
    row = await load_session_public(db, code, request)
    question = asvc.trace_question(row, question_id)
    if not question.config.get("suggest_existing") or row.status not in ("open", "paused"):
        return {"labels": []}
    await db.close()

    async def produce(session: AsyncSession) -> tuple[dict[str, str], Counter[str]]:
        ds = await asvc.build_dataset(session, row, question_id)
        return ds.display, await asyncio.to_thread(ds.label_counts)

    bucket = int(time.time() // SUGGEST_TTL_SECONDS)
    display, counts = await cached(request, (row.code, "suggest", question_id, bucket), produce)
    return {"labels": asvc.suggest_labels(display, counts, q)}


def _etag(row: SessionRow, *params: object) -> str:
    digest = hashlib.sha1(json.dumps(params, default=str).encode()).hexdigest()[:12]
    return f'"{row.version}-{digest}"'


def _etag_matches(header: str | None, etag: str) -> bool:
    """If-None-Match may list several validators and proxies weaken them (W/"...")."""
    if not header:
        return False
    candidates = [c.strip().removeprefix("W/") for c in header.split(",")]
    return "*" in candidates or etag in candidates


def _check_groupable(row: SessionRow, question_id: str) -> None:
    """Fail fast (before any data is loaded) if the question cannot define groups."""
    asvc.attribute_values(asvc.question_by_id(row, question_id), {"value": 0, "values": []})


@router.get(
    "/sessions/{code}/analytics",
    response_model=None,
    responses={
        **_err(401, 404, 503),
        200: {"model": AnalyticsOut},
        304: {"description": "If-None-Match matched the ETag"},
    },
)
async def get_analytics(
    code: str,
    request: Request,
    db: DB,
    question_id: Annotated[str, Query()],
    filter_question_id: Annotated[str | None, Query()] = None,
    filter_value: Annotated[str | None, Query(max_length=300)] = None,
    min_support: Annotated[int | None, Query(ge=1, le=100000)] = None,
    theta: Annotated[float, Query(gt=0, le=1)] = 0.7,
) -> Response:
    row = await load_session(db, code, request)
    role = require_read(row, request)
    asvc.trace_question(row, question_id)
    if filter_question_id is not None:
        if filter_value is None:
            raise ApiError(
                422, "validation_error", "filter_value is required with filter_question_id"
            )
        _check_groupable(row, filter_question_id)

    k_min = svc.full_settings(row)["k_min"]
    reader_scoped = filter_question_id is not None and role != "admin"
    params = ("a", question_id, filter_question_id, filter_value, min_support, theta)
    etag = _etag(row, *params, reader_scoped, k_min if reader_scoped else None)
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    version = row.version
    await db.close()
    result = await cached(
        request,
        (row.code, version, *params),
        lambda session: asvc.compute_analytics(
            session,
            row,
            question_id,
            filter_question_id=filter_question_id,
            filter_value=filter_value,
            min_support=min_support,
            theta=theta,
        ),
    )
    if reader_scoped and result["n"] < k_min:
        result = {
            "version": result["version"],
            "question_id": question_id,
            "filter": result["filter"],
            **analyze([], min_support=min_support, theta=theta),
            "suppressed": True,
        }
    return JSONResponse(result, headers=headers)


@router.get(
    "/sessions/{code}/compare",
    response_model=None,
    responses={
        **_err(401, 404, 503),
        200: {"model": CompareOut},
        304: {"description": "If-None-Match matched the ETag"},
    },
)
async def get_compare(
    code: str,
    request: Request,
    db: DB,
    question_id: Annotated[str, Query()],
    group_by: Annotated[str, Query()],
    min_support: Annotated[int | None, Query(ge=1, le=100000)] = None,
    theta: Annotated[float, Query(gt=0, le=1)] = 0.7,
) -> Response:
    row = await load_session(db, code, request)
    require_read(row, request)
    asvc.trace_question(row, question_id)
    _check_groupable(row, group_by)
    k_min = svc.full_settings(row)["k_min"]
    params = ("c", question_id, group_by, k_min, min_support, theta)
    etag = _etag(row, *params)
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if _etag_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    version = row.version
    await db.close()
    result = await cached(
        request,
        (row.code, version, *params),
        lambda session: asvc.compute_compare(
            session,
            row,
            question_id,
            group_by,
            k_min=k_min,
            min_support=min_support,
            theta=theta,
        ),
    )
    return JSONResponse(result, headers=headers)


@router.get(
    "/sessions/{code}/export",
    response_model=None,
    responses={
        **_err(401, 404),
        200: {
            "description": "File download",
            "content": {"text/csv": {}, "application/xml": {}, "application/json": {}},
        },
    },
)
async def export(
    code: str,
    request: Request,
    db: DB,
    format: Annotated[str, Query(pattern="^(csv|xes|json)$")] = "csv",
    question_id: Annotated[str | None, Query()] = None,
) -> Response:
    row = await load_session(db, code, request)
    require_admin(row, request)
    if format == "json":
        responses = await svc.load_responses(db, row.id)
        stmt = select(LabelAliasRow).where(LabelAliasRow.session_id == row.id)
        aliases = [
            {
                "question_id": a.question_id,
                "raw_key": a.raw_key,
                "canonical": a.canonical,
                "hidden": a.hidden,
            }
            for a in (await db.execute(stmt)).scalars()
        ]
        body = await asyncio.to_thread(exporter.export_json, row, responses, aliases, row.joined)
        media, ext = "application/json", "json"
    else:
        trace_q: QuestionRow | None
        if question_id:
            trace_q = asvc.trace_question(row, question_id)
        else:
            trace_q = next((q for q in row.questions if q.type == "trace"), None)
        if trace_q is None:
            raise ApiError(422, "not_a_trace_question", "No trace question")
        ds = await asvc.build_dataset(db, row, trace_q.id)
        if format == "csv":
            body = await asyncio.to_thread(exporter.export_csv, row, trace_q, ds)
            media, ext = "text/csv; charset=utf-8", "csv"
        else:
            body = await asyncio.to_thread(exporter.export_xes, row, trace_q, ds)
            media, ext = "application/xml", "xes"
    filename = f"processpoll-{row.code}.{ext}"
    return Response(
        body,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


def _tick(state: dict[str, Any]) -> str:
    data = {k: state[k] for k in ("version", "joined", "submitted", "status")}
    return f"event: tick\ndata: {json.dumps(data)}\n\n"


@router.get(
    "/sessions/{code}/stream",
    response_model=None,
    responses={**_err(401, 404), 200: {"content": {"text/event-stream": {}}}},
)
async def stream(code: str, request: Request) -> StreamingResponse:
    hub = hub_of(request)
    cfg = settings_of(request)

    async with request.app.state.db.sessionmaker() as db:
        row = await load_session(db, code, request)
        require_read(row, request)
        code = row.code
        if hub.state(code) is None:
            await publish_state(request, db, code)

    metrics = request.app.state.metrics

    async def events() -> AsyncIterator[str]:
        metrics.sse_listeners += 1
        try:
            gen = hub.generation(code)
            state = hub.state(code)
            if state is None:
                return
            yield _tick(state)
            while True:
                new_gen = await hub.wait_for_change(code, gen, cfg.heartbeat_seconds)
                if new_gen == gen:
                    yield ": keepalive\n\n"
                    continue

                window = min(
                    max(cfg.tick_interval_seconds, 4 * hub.compute_seconds), MAX_TICK_STRETCH
                )
                await asyncio.sleep(window)
                gen = hub.generation(code)
                state = hub.state(code)
                if state is None:
                    return
                yield _tick(state)
        finally:
            metrics.sse_listeners -= 1

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
