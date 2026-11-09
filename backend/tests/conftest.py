from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest_asyncio

from app import compute
from app.config import Settings
from app.db import Database
from app.main import create_app

TEST_DB_URL = os.environ.get("PROCESSPOLL_TEST_DATABASE_URL")


def make_test_settings(url: str, **overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "database_url": url,
        "env": "dev",
        "tick_interval_seconds": 0.01,
        "heartbeat_seconds": 0.2,
        "retention_sweep_seconds": 3600,
    }
    base.update(overrides)
    return Settings(**base)


@pytest_asyncio.fixture
async def app(tmp_path) -> AsyncIterator[Any]:
    url = TEST_DB_URL or f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"
    settings = make_test_settings(url)
    db = Database(settings.database_url)
    if not settings.database_url.startswith("sqlite"):
        from app.db import Base

        async with db.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
    await db.create_all()
    application = create_app(settings, db)
    application.state.db = db

    compute.start(int(os.environ.get("PROCESSPOLL_TEST_COMPUTE_PROCESSES", "0")))
    yield application
    compute.shutdown()
    await db.dispose()


@pytest_asyncio.fixture
async def client(app) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


MORNING_QUESTIONS = [
    {
        "type": "trace",
        "prompt": "What is your typical morning routine?",
        "config": {"mode": "free", "min_steps": 2, "max_steps": 10},
    },
    {
        "type": "single_choice",
        "prompt": "Role",
        "required": False,
        "config": {"options": ["Student", "Lecturer"]},
    },
    {
        "type": "single_choice",
        "prompt": "Experience",
        "required": False,
        "config": {"options": ["Beginner", "Expert"]},
    },
]


class Host:
    """Convenience wrapper around a created session."""

    def __init__(self, client: httpx.AsyncClient, created: dict[str, Any]) -> None:
        self.client = client
        self.code: str = created["code"]
        self.admin_key: str = created["admin_key"]
        self.display_key: str = created["display_key"]
        self.session: dict[str, Any] = created["session"]
        self.q = {q["prompt"]: q for q in self.session["questions"]}

    @property
    def headers(self) -> dict[str, str]:
        return {"X-Admin-Key": self.admin_key}

    @property
    def trace_id(self) -> str:
        return next(q["id"] for q in self.session["questions"] if q["type"] == "trace")

    async def set_status(self, status: str) -> httpx.Response:
        return await self.client.patch(
            f"/api/v1/sessions/{self.code}", json={"status": status}, headers=self.headers
        )

    async def participant(self) -> str:
        r = await self.client.post(f"/api/v1/sessions/{self.code}/join", json={})
        assert r.status_code == 200, r.text
        return r.json()["participant_token"]

    async def submit(
        self,
        steps: list[str],
        role: str | None = None,
        experience: str | None = None,
        token: str | None = None,
        key: str | None = None,
    ) -> httpx.Response:
        token = token or await self.participant()
        answers: list[dict[str, Any]] = [{"question_id": self.trace_id, "value": {"steps": steps}}]
        if role:
            answers.append({"question_id": self.q["Role"]["id"], "value": {"value": role}})
        if experience:
            answers.append(
                {"question_id": self.q["Experience"]["id"], "value": {"value": experience}}
            )
        headers = {"X-Participant-Token": token}
        if key:
            headers["Idempotency-Key"] = key
        return await self.client.post(
            f"/api/v1/sessions/{self.code}/responses", json={"answers": answers}, headers=headers
        )


async def create_host(
    client: httpx.AsyncClient,
    questions: list[dict[str, Any]] | None = None,
    settings: dict[str, Any] | None = None,
    open_session: bool = True,
) -> Host:
    body: dict[str, Any] = {"title": "Morning poll", "questions": questions or MORNING_QUESTIONS}
    if settings:
        body["settings"] = settings
    r = await client.post("/api/v1/sessions", json=body)
    assert r.status_code == 201, r.text
    host = Host(client, r.json())
    if open_session:
        assert (await host.set_status("open")).status_code == 200
    return host
