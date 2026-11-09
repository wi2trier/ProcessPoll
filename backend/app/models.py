from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import TypeDecorator

from app.db import Base

JsonType = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid.uuid4())


class TZDateTime(TypeDecorator):
    """Timezone-aware UTC datetime that also round-trips through SQLite (which drops tzinfo)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC) if value is not None else None

    def process_result_value(self, value, dialect):
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="draft")
    settings: Mapped[dict[str, Any]] = mapped_column(JsonType, default=dict)
    admin_key_hash: Mapped[str] = mapped_column(String(64))
    display_key_hash: Mapped[str] = mapped_column(String(64))
    display_key: Mapped[str] = mapped_column(String(64))
    version: Mapped[int] = mapped_column(Integer, default=0)
    joined: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    opened_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(TZDateTime(), nullable=True, index=True)

    questions: Mapped[list[QuestionRow]] = relationship(
        back_populates="session", cascade="all, delete-orphan", order_by="QuestionRow.position"
    )


class QuestionRow(Base):
    __tablename__ = "questions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(20))
    prompt: Mapped[str] = mapped_column(String(500))

    label: Mapped[str | None] = mapped_column(String(80), nullable=True)
    help: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    config: Mapped[dict[str, Any]] = mapped_column(JsonType, default=dict)

    session: Mapped[SessionRow] = relationship(back_populates="questions")


class ParticipantRow(Base):
    __tablename__ = "participants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)


class ResponseRow(Base):
    __tablename__ = "responses"
    __table_args__ = (
        UniqueConstraint("session_id", "submission_key", name="uq_response_submission"),
        Index("ix_responses_session_current", "session_id", "is_current"),
        Index(
            "uq_response_participant_current",
            "participant_id",
            unique=True,
            postgresql_where=text("is_current"),
            sqlite_where=text("is_current"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    participant_id: Mapped[str] = mapped_column(
        ForeignKey("participants.id", ondelete="CASCADE"), index=True
    )
    submission_key: Mapped[str | None] = mapped_column(String(100), nullable=True)
    submitted_at: Mapped[datetime] = mapped_column(TZDateTime(), default=utcnow)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)

    answers: Mapped[list[AnswerRow]] = relationship(
        back_populates="response", cascade="all, delete-orphan"
    )


class AnswerRow(Base):
    __tablename__ = "answers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    response_id: Mapped[str] = mapped_column(
        ForeignKey("responses.id", ondelete="CASCADE"), index=True
    )
    question_id: Mapped[str] = mapped_column(
        ForeignKey("questions.id", ondelete="CASCADE"), index=True
    )
    value: Mapped[dict[str, Any] | None] = mapped_column(JsonType, nullable=True)

    response: Mapped[ResponseRow] = relationship(back_populates="answers")


class LabelAliasRow(Base):
    __tablename__ = "label_aliases"
    __table_args__ = (UniqueConstraint("question_id", "raw_key", name="uq_alias_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    question_id: Mapped[str] = mapped_column(
        ForeignKey("questions.id", ondelete="CASCADE"), index=True
    )
    raw_key: Mapped[str] = mapped_column(String(300))
    canonical: Mapped[str | None] = mapped_column(String(200), nullable=True)
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
