"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-10-05
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

JSONX = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _tz() -> sa.DateTime:
    return sa.DateTime(timezone=True)


def upgrade() -> None:
    op.create_table(
        "sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code", sa.String(16), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("settings", JSONX, nullable=False),
        sa.Column("admin_key_hash", sa.String(64), nullable=False),
        sa.Column("display_key_hash", sa.String(64), nullable=False),
        sa.Column("display_key", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("joined", sa.Integer, nullable=False),
        sa.Column("created_at", _tz(), nullable=False),
        sa.Column("opened_at", _tz(), nullable=True),
        sa.Column("closed_at", _tz(), nullable=True),
        sa.Column("expires_at", _tz(), nullable=True),
    )
    op.create_index("ix_sessions_code", "sessions", ["code"], unique=True)
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"])

    op.create_table(
        "questions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("type", sa.String(20), nullable=False),
        sa.Column("prompt", sa.String(500), nullable=False),
        sa.Column("help", sa.String(1000), nullable=True),
        sa.Column("required", sa.Boolean, nullable=False),
        sa.Column("config", JSONX, nullable=False),
    )
    op.create_index("ix_questions_session_id", "questions", ["session_id"])

    op.create_table(
        "participants",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("created_at", _tz(), nullable=False),
    )
    op.create_index("ix_participants_session_id", "participants", ["session_id"])
    op.create_index("ix_participants_token_hash", "participants", ["token_hash"])

    op.create_table(
        "responses",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "participant_id",
            sa.String(36),
            sa.ForeignKey("participants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("submission_key", sa.String(100), nullable=True),
        sa.Column("submitted_at", _tz(), nullable=False),
        sa.Column("is_current", sa.Boolean, nullable=False),
        sa.UniqueConstraint("session_id", "submission_key", name="uq_response_submission"),
    )
    op.create_index("ix_responses_session_id", "responses", ["session_id"])
    op.create_index("ix_responses_participant_id", "responses", ["participant_id"])
    op.create_index("ix_responses_session_current", "responses", ["session_id", "is_current"])
    op.create_index(
        "uq_response_participant_current",
        "responses",
        ["participant_id"],
        unique=True,
        postgresql_where=sa.text("is_current"),
        sqlite_where=sa.text("is_current"),
    )

    op.create_table(
        "answers",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "response_id",
            sa.String(36),
            sa.ForeignKey("responses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "question_id",
            sa.String(36),
            sa.ForeignKey("questions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("value", JSONX, nullable=True),
    )
    op.create_index("ix_answers_response_id", "answers", ["response_id"])
    op.create_index("ix_answers_question_id", "answers", ["question_id"])

    op.create_table(
        "label_aliases",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "question_id",
            sa.String(36),
            sa.ForeignKey("questions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("raw_key", sa.String(300), nullable=False),
        sa.Column("canonical", sa.String(200), nullable=True),
        sa.Column("hidden", sa.Boolean, nullable=False),
        sa.UniqueConstraint("question_id", "raw_key", name="uq_alias_key"),
    )
    op.create_index("ix_label_aliases_session_id", "label_aliases", ["session_id"])
    op.create_index("ix_label_aliases_question_id", "label_aliases", ["question_id"])


def downgrade() -> None:
    for table in ("label_aliases", "answers", "responses", "participants", "questions", "sessions"):
        op.drop_table(table)
