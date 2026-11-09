"""A SQLite file from an older version gets the new nullable columns instead of failing."""

from __future__ import annotations

import sqlite3

import httpx

from app.config import Settings
from app.db import Database
from app.main import create_app


def _old_schema(path) -> None:
    """Schema 0001: no sessions.description, no questions.label."""
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE sessions (id VARCHAR(36) PRIMARY KEY, code VARCHAR(16) NOT NULL,
          title VARCHAR(200) NOT NULL, status VARCHAR(16) NOT NULL, settings JSON NOT NULL,
          admin_key_hash VARCHAR(64) NOT NULL, display_key_hash VARCHAR(64) NOT NULL,
          display_key VARCHAR(64) NOT NULL, version INTEGER NOT NULL,
          joined INTEGER NOT NULL, created_at DATETIME NOT NULL, opened_at DATETIME,
          closed_at DATETIME, expires_at DATETIME);
        CREATE TABLE questions (id VARCHAR(36) PRIMARY KEY, session_id VARCHAR(36) NOT NULL,
          position INTEGER NOT NULL, type VARCHAR(20) NOT NULL, prompt VARCHAR(500) NOT NULL,
          help VARCHAR(1000), required BOOLEAN NOT NULL, config JSON NOT NULL);
        """
    )
    con.commit()
    con.close()


async def test_old_sqlite_file_is_upgraded_in_place(tmp_path):
    path = tmp_path / "old.db"
    _old_schema(path)
    db = Database(f"sqlite+aiosqlite:///{path}")
    await db.create_all()
    await db.dispose()
    con = sqlite3.connect(path)
    sessions = {r[1] for r in con.execute("PRAGMA table_info(sessions)")}
    questions = {r[1] for r in con.execute("PRAGMA table_info(questions)")}
    con.close()
    assert "description" in sessions and "label" in questions

    db = Database(f"sqlite+aiosqlite:///{path}")
    await db.create_all()
    await db.dispose()


async def test_api_works_on_an_upgraded_file(tmp_path):
    path = tmp_path / "old2.db"
    _old_schema(path)
    settings = Settings(database_url=f"sqlite+aiosqlite:///{path}", env="dev")
    db = Database(settings.database_url)
    await db.create_all()
    app = create_app(settings, db)
    app.state.db = db
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post(
            "/api/v1/sessions",
            json={
                "title": "x",
                "description": "d",
                "questions": [{"type": "trace", "prompt": "p", "label": "l"}],
            },
        )
        assert r.status_code == 201, r.text
        assert r.json()["session"]["description"] == "d"
    await db.dispose()
