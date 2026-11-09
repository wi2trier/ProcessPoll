"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__, compute
from app.config import DEMO_RETENTION_DAYS, Settings, get_settings
from app.db import Database, make_database
from app.errors import ApiError, install_error_handlers
from app.live import LiveHub
from app.metrics import Metrics
from app.middleware import BodyLimitMiddleware
from app.models import ParticipantRow, ResponseRow, SessionRow, utcnow
from app.routes import router
from app.security import SlidingWindowLimiter

log = logging.getLogger("processpoll")


async def _extend_active(
    session: AsyncSession,
    now: datetime,
    sessions: Sequence[Any],
    max_age_days: int | None = None,
) -> set[str]:
    """Sessions that were never closed expire ``retention_days`` after creation, which would
    delete a poll that is still being used (e.g. retention 1 day, poll open for two). Such a
    session is kept while there was activity within the retention period; returns its codes."""
    kept: set[str] = set()
    for s in sessions:
        if s.status == "closed":
            continue
        deadline = s.created_at + timedelta(days=max_age_days) if max_age_days is not None else None
        if deadline is not None and deadline <= now:
            continue
        last_response = await session.scalar(
            select(func.max(ResponseRow.submitted_at)).where(ResponseRow.session_id == s.id)
        )
        last_join = await session.scalar(
            select(func.max(ParticipantRow.created_at)).where(ParticipantRow.session_id == s.id)
        )
        activity = [t for t in (last_response, last_join) if t is not None]
        if not activity:
            continue
        until = max(activity) + timedelta(days=int((s.settings or {}).get("retention_days", 90)))
        if deadline is not None:
            until = min(until, deadline)
        if until > now:
            await session.execute(
                update(SessionRow)
                .where(SessionRow.id == s.id, SessionRow.status != "closed")
                .values(expires_at=until)
            )
            kept.add(s.code)
    return kept


async def sweep_expired(
    db: Database,
    hub: LiveHub,
    batch_size: int = 500,
    max_age_days: int | None = None,
) -> int:
    """Delete sessions whose retention period has passed. Returns the number removed.

    Works in batches (a huge backlog must not exceed the bind-parameter limit of the driver)
    and re-checks the expiry inside the DELETE: a host who extended the retention in the
    meantime keeps the session."""
    removed = 0
    while True:
        async with db.sessionmaker() as session:
            now = utcnow()
            if max_age_days is None:
                expired = SessionRow.expires_at.is_not(None) & (SessionRow.expires_at < now)
            else:
                expired = SessionRow.created_at <= now - timedelta(days=max_age_days)
            candidates = (
                await session.execute(
                    select(
                        SessionRow.id,
                        SessionRow.code,
                        SessionRow.status,
                        SessionRow.settings,
                        SessionRow.created_at,
                    )
                    .where(expired)
                    .limit(batch_size)
                )
            ).all()
            if not candidates:
                return removed
            kept = await _extend_active(session, now, candidates, max_age_days)
            codes = [s.code for s in candidates if s.code not in kept]
            alive: set[str] = set()
            if codes:
                await session.execute(delete(SessionRow).where(SessionRow.code.in_(codes), expired))
            await session.commit()
            if codes:
                alive = set(
                    (
                        await session.execute(
                            select(SessionRow.code).where(SessionRow.code.in_(codes))
                        )
                    )
                    .scalars()
                    .all()
                )
        gone = [code for code in codes if code not in alive]
        for code in gone:
            hub.forget(code)
        removed += len(gone)
        if not gone and not kept:
            return removed


async def _sweeper(app: FastAPI) -> None:
    interval = app.state.settings.retention_sweep_seconds
    while True:
        try:
            max_age = DEMO_RETENTION_DAYS if app.state.settings.demo_mode else None
            removed = await sweep_expired(app.state.db, app.state.hub, max_age_days=max_age)
            if removed:
                log.info("retention sweep removed %d expired sessions", removed)
        except Exception:
            log.exception("retention sweep failed")
        await asyncio.sleep(interval)


def create_app(settings: Settings | None = None, database: Database | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = database or make_database(settings.database_url)
        app.state.db = db
        if db.url.startswith("sqlite"):
            await db.create_all()
        tasks = []
        try:
            if settings.demo_mode:
                removed = await sweep_expired(db, app.state.hub, max_age_days=DEMO_RETENTION_DAYS)
                log.info("demo retention sweep removed %d sessions", removed)
            tasks.append(asyncio.create_task(_sweeper(app)))
            compute.start(settings.compute_processes)
            yield
        finally:
            compute.shutdown()
            for task in tasks:
                task.cancel()
            for task in tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await db.dispose()

    app = FastAPI(
        title="ProcessPoll API",
        version=__version__,
        lifespan=lifespan,
        docs_url=None if settings.is_prod else "/docs",
        redoc_url=None,
        openapi_url=None if settings.is_prod else "/openapi.json",
    )
    app.state.settings = settings
    app.state.hub = LiveHub(
        settings.analytics_cache_size,
        compute_slots=settings.compute_concurrency,
        queue_limit=settings.compute_queue_limit,
        cache_per_session=settings.analytics_cache_per_session,
        compute_timeout=settings.compute_timeout_seconds,
    )
    app.state.limiter = SlidingWindowLimiter()
    app.state.metrics = Metrics()
    install_error_handlers(app)

    app.add_middleware(BodyLimitMiddleware, max_bytes=settings.max_request_bytes)

    if settings.origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.origins,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=[
                "Content-Type",
                "X-Admin-Key",
                "X-Display-Key",
                "X-Participant-Token",
                "Idempotency-Key",
                "If-None-Match",
            ],
            expose_headers=["ETag", "Content-Disposition"],
        )

    @app.middleware("http")
    async def guard(request: Request, call_next):
        started = time.perf_counter()

        def observe(status: int) -> None:
            route = request.scope.get("route")
            app.state.metrics.observe(
                request.method,
                getattr(route, "path", "unmatched"),
                status,
                time.perf_counter() - started,
            )

        try:
            response = await call_next(request)
        except Exception:
            observe(500)
            raise
        observe(response.status_code)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response

    app.include_router(router)

    @app.get("/metrics", include_in_schema=False)
    async def metrics(request: Request) -> PlainTextResponse:

        if any(h in request.headers for h in ("x-forwarded-for", "forwarded", "x-real-ip")):
            raise ApiError(404, "not_found", "Not Found")
        return PlainTextResponse(request.app.state.metrics.render())

    @app.get("/healthz")
    async def healthz(request: Request) -> JSONResponse:
        async def ping() -> None:
            async with request.app.state.db.sessionmaker() as session:
                await session.execute(text("SELECT 1"))

        ok = True
        try:
            await asyncio.wait_for(ping(), timeout=3)
        except Exception:
            ok = False
        return JSONResponse(
            {"status": "ok" if ok else "degraded", "db": ok}, status_code=200 if ok else 503
        )

    return app


app = create_app()
