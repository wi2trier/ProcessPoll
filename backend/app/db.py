from __future__ import annotations

from collections.abc import AsyncIterator

import sqlalchemy as sa
from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


class Base(DeclarativeBase):
    pass


def _add_missing_nullable_columns(sync_conn) -> list[str]:
    """Dev convenience for SQLite files that were created by an older version of the app.

    ``create_all`` never alters existing tables, so a long-lived local ``processpoll.db`` would
    fail with "no such column" after an update that adds a column. Additive, nullable columns
    are added here (PostgreSQL always uses Alembic). Returns the added "table.column" names."""
    inspector = sa.inspect(sync_conn)
    added: list[str] = []
    for table in Base.metadata.sorted_tables:
        existing = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing or not column.nullable:
                continue
            ddl_type = column.type.compile(dialect=sync_conn.dialect)
            sync_conn.execute(
                sa.text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {ddl_type}')
            )
            added.append(f"{table.name}.{column.name}")
    return added


class Database:
    """Holds the engine/sessionmaker so tests can create isolated instances."""

    def __init__(self, url: str) -> None:
        self.url = url

        kwargs: dict = {"pool_pre_ping": True, "hide_parameters": True}
        if url.startswith("sqlite"):
            if ":memory:" in url or url.endswith("sqlite://"):
                from sqlalchemy.pool import StaticPool

                kwargs = {
                    "poolclass": StaticPool,
                    "connect_args": {"check_same_thread": False},
                    "hide_parameters": True,
                }
        else:
            kwargs.update(pool_size=10, max_overflow=20)
        self.engine: AsyncEngine = create_async_engine(url, **kwargs)
        if url.startswith("sqlite"):

            @event.listens_for(self.engine.sync_engine, "connect")
            def _fk_pragma(dbapi_conn, _record):
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()

        self.sessionmaker = async_sessionmaker(self.engine, expire_on_commit=False)

    async def create_all(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            if self.url.startswith("sqlite"):
                await conn.run_sync(_add_missing_nullable_columns)

    async def dispose(self) -> None:
        await self.engine.dispose()


def make_database(url: str | None = None) -> Database:
    return Database(url or get_settings().database_url)


async def get_session(request) -> AsyncIterator[AsyncSession]:
    async with request.app.state.db.sessionmaker() as session:
        yield session
