"""Database-facing operations and (de)serialisation."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, cast

from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

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
from app.normalize import Alias
from app.schemas import (
    AdminSessionOut,
    PublicSessionOut,
    QuestionIn,
    QuestionOut,
    QuestionType,
    SessionStatus,
    SettingsModel,
)

PUBLIC_SETTINGS = ("results_public", "allow_resubmit")


async def get_session_row(db: AsyncSession, code: str) -> SessionRow | None:
    stmt = (
        select(SessionRow)
        .where(SessionRow.code == code)
        .options(selectinload(SessionRow.questions))
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def full_settings(row: SessionRow) -> dict[str, Any]:
    return SettingsModel.model_validate(row.settings or {}).model_dump()


def serialize_question(q: QuestionRow) -> QuestionOut:
    return QuestionOut(
        id=q.id,
        position=q.position,
        type=cast(QuestionType, q.type),
        prompt=q.prompt,
        label=q.label,
        help=q.help,
        required=q.required,
        config=q.config,
    )


def public_session(row: SessionRow) -> PublicSessionOut:
    settings = full_settings(row)
    return PublicSessionOut(
        code=row.code,
        title=row.title,
        description=row.description,
        status=cast(SessionStatus, row.status),
        questions=[serialize_question(q) for q in row.questions],
        settings={k: settings[k] for k in PUBLIC_SETTINGS},
    )


async def submitted_count(db: AsyncSession, session_id: str) -> int:
    stmt = (
        select(func.count())
        .select_from(ResponseRow)
        .where(ResponseRow.session_id == session_id, ResponseRow.is_current.is_(True))
    )
    return int((await db.execute(stmt)).scalar_one())


async def admin_session(db: AsyncSession, row: SessionRow) -> AdminSessionOut:
    pub = public_session(row)
    return AdminSessionOut(
        **pub.model_dump(exclude={"settings"}),
        settings=full_settings(row),
        joined=row.joined,
        submitted=await submitted_count(db, row.id),
        version=row.version,
        created_at=row.created_at,
        opened_at=row.opened_at,
        closed_at=row.closed_at,
        expires_at=row.expires_at,
        display_key=row.display_key,
    )


def expiry_for(row: SessionRow, retention_days: int) -> datetime:
    reference = row.closed_at or row.created_at or utcnow()
    return reference + timedelta(days=retention_days)


def question_rows_from_input(session_id: str, items: list[QuestionIn]) -> list[QuestionRow]:
    """Fresh rows with server-generated ids (client-supplied ids are ignored)."""
    return [
        QuestionRow(
            id=new_id(),
            session_id=session_id,
            position=pos,
            type=item.type,
            prompt=item.prompt,
            label=item.label,
            help=item.help,
            required=item.required,
            config=item.config,
        )
        for pos, item in enumerate(items)
    ]


async def bump_version(
    db: AsyncSession,
    session_id: str,
    *,
    joined_delta: int = 0,
    require_status: str | None = None,
) -> bool:
    """Increment the session version (this also takes the row lock for the transaction).

    With ``require_status`` the update only happens while the session still has that status;
    ``False`` means it did not (the caller must abort). Because the check is part of the
    UPDATE, a write that raced with a status change can never slip in behind it."""
    values: dict[str, Any] = {"version": SessionRow.version + 1}
    if joined_delta:
        values["joined"] = SessionRow.joined + joined_delta
    stmt = update(SessionRow).where(SessionRow.id == session_id)
    if require_status is not None:
        stmt = stmt.where(SessionRow.status == require_status)
    result = cast("CursorResult[Any]", await db.execute(stmt.values(**values)))
    return result.rowcount == 1


async def update_session_if_status(
    db: AsyncSession, session_id: str, expected_status: str, **values: Any
) -> bool:
    """Compare-and-set: apply ``values`` only while the session still has ``expected_status``."""
    stmt = (
        update(SessionRow)
        .where(SessionRow.id == session_id, SessionRow.status == expected_status)
        .values(**values)
    )
    result = cast("CursorResult[Any]", await db.execute(stmt))
    return result.rowcount == 1


async def bump_joined(db: AsyncSession, session_id: str) -> None:
    await db.execute(
        update(SessionRow).where(SessionRow.id == session_id).values(joined=SessionRow.joined + 1)
    )


async def live_state(db: AsyncSession, code: str) -> dict[str, Any] | None:
    """Fresh counters straight from the database (used after writes and on SSE connect)."""
    stmt = select(SessionRow.id, SessionRow.version, SessionRow.joined, SessionRow.status).where(
        SessionRow.code == code
    )
    row = (await db.execute(stmt)).one_or_none()
    if row is None:
        return None
    return {
        "version": row.version,
        "joined": row.joined,
        "submitted": await submitted_count(db, row.id),
        "status": row.status,
    }


async def delete_session(db: AsyncSession, row: SessionRow) -> None:
    await db.execute(delete(SessionRow).where(SessionRow.id == row.id))


async def find_participant(
    db: AsyncSession, session_id: str, token_hash: str
) -> ParticipantRow | None:
    stmt = select(ParticipantRow).where(
        ParticipantRow.session_id == session_id, ParticipantRow.token_hash == token_hash
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def current_response(db: AsyncSession, participant_id: str) -> ResponseRow | None:
    stmt = select(ResponseRow).where(
        ResponseRow.participant_id == participant_id, ResponseRow.is_current.is_(True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


@dataclass
class ResponseData:
    id: str
    submitted_at: datetime
    answers: dict[str, dict[str, Any] | None] = field(default_factory=dict)


async def load_responses(db: AsyncSession, session_id: str) -> list[ResponseData]:
    """All current responses with their answers, ordered by submission time.

    A single statement (hence one snapshot): with separate queries a response committed in
    between would show up with answers but without its header row."""
    stmt = (
        select(
            ResponseRow.id,
            ResponseRow.submitted_at,
            AnswerRow.question_id,
            AnswerRow.value,
        )
        .join(AnswerRow, AnswerRow.response_id == ResponseRow.id, isouter=True)
        .where(ResponseRow.session_id == session_id, ResponseRow.is_current.is_(True))
        .order_by(ResponseRow.submitted_at, ResponseRow.id)
    )
    responses: dict[str, ResponseData] = {}
    for r in (await db.execute(stmt)).all():
        data = responses.get(r.id)
        if data is None:
            data = responses[r.id] = ResponseData(r.id, r.submitted_at)
        if r.question_id is not None:
            data.answers[r.question_id] = r.value
    return list(responses.values())


async def load_aliases(db: AsyncSession, question_id: str) -> dict[str, Alias]:
    stmt = select(LabelAliasRow).where(LabelAliasRow.question_id == question_id)
    return {
        r.raw_key: Alias(canonical=r.canonical, hidden=r.hidden)
        for r in (await db.execute(stmt)).scalars()
    }
