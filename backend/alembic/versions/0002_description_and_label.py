"""session description and question label

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-06
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.add_column(sa.Column("description", sa.String(1000), nullable=True))
    with op.batch_alter_table("questions") as batch:
        batch.add_column(sa.Column("label", sa.String(80), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("questions") as batch:
        batch.drop_column("label")
    with op.batch_alter_table("sessions") as batch:
        batch.drop_column("description")
