"""Authorization checks and cross-session isolation."""

from __future__ import annotations

import httpx
from conftest import create_host
from sqlalchemy import func, select

from app.models import (
    AnswerRow,
    LabelAliasRow,
    ParticipantRow,
    QuestionRow,
    ResponseRow,
    SessionRow,
)

API = "/api/v1"


async def two_sessions(client):
    a = await create_host(client, settings={"k_min": 1})
    b = await create_host(client, settings={"k_min": 1})
    for host in (a, b):
        assert (await host.submit(["x", "y"], role="Student")).status_code == 201
    return a, b


async def test_keys_and_tokens_do_not_cross_sessions(client):
    a, b = await two_sessions(client)
    url_b = f"{API}/sessions/{b.code}"

    assert (await client.get(f"{url_b}/admin", headers=a.headers)).status_code == 401
    assert (await client.get(f"{url_b}/admin", params={"key": a.display_key})).status_code == 401
    for method, path, body in (
        ("PATCH", "", {"status": "closed"}),
        ("PUT", "/questions", {"questions": [{"type": "trace", "prompt": "x", "config": {}}]}),
        ("PUT", "/aliases", {"question_id": b.trace_id, "aliases": []}),
        ("DELETE", "", None),
    ):
        r = await client.request(method, url_b + path, json=body, headers=a.headers)
        assert r.status_code == 401, (method, path)
    for path, params in (
        ("/analytics", {"question_id": b.trace_id}),
        ("/compare", {"question_id": b.trace_id, "group_by": b.q["Role"]["id"]}),
        ("/export", {}),
        ("/labels", {"question_id": b.trace_id}),
        ("/stream", {}),
    ):
        r = await client.get(url_b + path, params=params, headers=a.headers)
        assert r.status_code == 401, path

    token_a = await a.participant()
    r = await client.post(
        f"{url_b}/responses",
        json={"answers": [{"question_id": b.trace_id, "value": {"steps": ["x", "y"]}}]},
        headers={"X-Participant-Token": token_a},
    )
    assert r.status_code == 401 and r.json()["detail"] == "invalid_token"

    joined = (await client.post(f"{url_b}/join", json={"token": token_a})).json()
    assert joined["participant_token"] != token_a and joined["has_submitted"] is False


async def test_question_ids_of_another_session_are_rejected_everywhere(client):
    a, b = await two_sessions(client)
    url_b = f"{API}/sessions/{b.code}"
    foreign_trace, foreign_role = a.trace_id, a.q["Role"]["id"]
    checks = [
        client.get(f"{url_b}/analytics", params={"question_id": foreign_trace}, headers=b.headers),
        client.get(
            f"{url_b}/analytics",
            params={
                "question_id": b.trace_id,
                "filter_question_id": foreign_role,
                "filter_value": "Student",
            },
            headers=b.headers,
        ),
        client.get(
            f"{url_b}/compare",
            params={"question_id": b.trace_id, "group_by": foreign_role},
            headers=b.headers,
        ),
        client.get(f"{url_b}/labels", params={"question_id": foreign_trace}, headers=b.headers),
        client.get(f"{url_b}/labels/suggest", params={"question_id": foreign_trace}),
        client.get(
            f"{url_b}/export",
            params={"format": "csv", "question_id": foreign_trace},
            headers=b.headers,
        ),
        client.put(
            f"{url_b}/aliases",
            json={"question_id": foreign_trace, "aliases": []},
            headers=b.headers,
        ),
        client.patch(
            f"{url_b}/questions/{foreign_trace}", json={"prompt": "hijacked"}, headers=b.headers
        ),
    ]
    for response in [await c for c in checks]:
        assert response.status_code == 404, response.text

    token = await b.participant()
    r = await client.post(
        f"{url_b}/responses",
        json={
            "answers": [
                {"question_id": b.trace_id, "value": {"steps": ["x", "y"]}},
                {"question_id": foreign_role, "value": {"value": "Student"}},
            ]
        },
        headers={"X-Participant-Token": token},
    )
    assert r.status_code == 422

    assert (await client.get(f"{API}/sessions/{a.code}")).json()["questions"][0]["prompt"] == (
        a.session["questions"][0]["prompt"]
    )


async def test_idempotency_keys_are_scoped_to_their_session(client):
    a = await create_host(client)
    b = await create_host(client)
    first = await a.submit(["x", "y"], key="shared-key")
    second = await b.submit(["x", "y"], key="shared-key")
    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["response_id"] != second.json()["response_id"]


async def test_display_key_is_read_only_and_never_public(client):
    host = await create_host(client)
    display = {"X-Display-Key": host.display_key}
    url = f"{API}/sessions/{host.code}"
    assert (
        await client.get(f"{url}/analytics", params={"question_id": host.trace_id}, headers=display)
    ).status_code == 200
    for method, path, body in (
        ("GET", "/admin", None),
        ("GET", "/export", None),
        ("GET", "/labels", None),
        ("PATCH", "", {"status": "paused"}),
        ("DELETE", "", None),
    ):
        r = await client.request(
            method, url + path, json=body, headers=display, params={"question_id": host.trace_id}
        )
        assert r.status_code == 401, (method, path)
    public = (await client.get(url)).text
    assert host.display_key not in public and host.admin_key not in public


async def test_api_responses_are_not_cacheable_by_default(client):
    host = await create_host(client)
    url = f"{API}/sessions/{host.code}"
    for response in (
        await client.get(f"{url}/admin", headers=host.headers),
        await client.get(url),
        await client.get(f"{API}/meta"),
        await client.get(f"{url}/admin"),
    ):
        assert response.headers["cache-control"] == "no-store"
    analytics = await client.get(
        f"{url}/analytics", params={"question_id": host.trace_id}, headers=host.headers
    )
    assert analytics.headers["cache-control"] == "private, no-cache"
    assert (await client.get("/healthz")).headers.get("cache-control") is None


async def test_no_secret_leaks_into_exports_or_errors(client):
    host = await create_host(client)
    await host.submit(["x", "y"], role="Student")
    url = f"{API}/sessions/{host.code}"
    secrets = (host.admin_key, host.display_key)
    for fmt in ("csv", "xes", "json"):
        r = await client.get(f"{url}/export", params={"format": fmt}, headers=host.headers)
        assert not any(s.encode() in r.content for s in secrets), fmt
    bad = await client.post(
        f"{url}/responses",
        content="{not json",
        headers={"Content-Type": "application/json", "X-Participant-Token": host.admin_key},
    )
    assert not any(s in bad.text for s in secrets)
    odd = await client.get(f"{url}/analytics", params={"key": host.admin_key})
    assert odd.status_code == 422 and host.admin_key not in odd.text


async def test_production_hides_docs_and_metrics_from_proxied_requests(app):
    from conftest import make_test_settings

    from app.main import create_app

    settings = make_test_settings(app.state.settings.database_url, env="prod")
    prod = create_app(settings, app.state.db)
    prod.state.db = app.state.db
    transport = httpx.ASGITransport(app=prod)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        for path in ("/docs", "/openapi.json", "/redoc", "/docs/oauth2-redirect"):
            assert (await c.get(path)).status_code == 404, path
        assert (await c.get("/healthz")).status_code == 200

        assert (await c.get("/metrics")).status_code == 200
        for header in ("X-Forwarded-For", "Forwarded", "X-Real-IP"):
            assert (await c.get("/metrics", headers={header: "203.0.113.5"})).status_code == 404


async def test_cors_is_limited_to_the_configured_origins(app):
    from conftest import make_test_settings

    from app.main import create_app

    settings = make_test_settings(
        app.state.settings.database_url, allowed_origins="https://poll.example.org"
    )
    cors = create_app(settings, app.state.db)
    cors.state.db = app.state.db
    transport = httpx.ASGITransport(app=cors)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        ok = await c.get(f"{API}/meta", headers={"Origin": "https://poll.example.org"})
        assert ok.headers["access-control-allow-origin"] == "https://poll.example.org"
        assert "access-control-allow-credentials" not in ok.headers
        evil = await c.get(f"{API}/meta", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in evil.headers
        preflight = await c.options(
            f"{API}/sessions",
            headers={
                "Origin": "https://evil.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-admin-key",
            },
        )
        assert preflight.status_code == 400
        assert "access-control-allow-origin" not in preflight.headers

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get(f"{API}/meta", headers={"Origin": "https://poll.example.org"})
        assert "access-control-allow-origin" not in r.headers


async def _counts(app) -> dict[str, int]:
    async with app.state.db.sessionmaker() as s:
        return {
            m.__tablename__: (await s.execute(select(func.count()).select_from(m))).scalar_one()
            for m in (
                SessionRow,
                QuestionRow,
                ParticipantRow,
                ResponseRow,
                AnswerRow,
                LabelAliasRow,
            )
        }


async def test_deleting_a_session_removes_every_dependent_row(app, client):
    keep = await create_host(client)
    await keep.submit(["k", "l"], role="Student")
    gone = await create_host(client)
    await gone.submit(["x", "y"], role="Student")
    await gone.submit(["x", "z"], role="Lecturer")
    await client.put(
        f"{API}/sessions/{gone.code}/aliases",
        json={
            "question_id": gone.trace_id,
            "aliases": [{"raw_key": "x", "canonical": "X", "hidden": False}],
        },
        headers=gone.headers,
    )
    before = await _counts(app)
    assert before["label_aliases"] == 1 and before["responses"] == 3
    r = await client.delete(f"{API}/sessions/{gone.code}", headers=gone.headers)
    assert r.status_code == 204
    after = await _counts(app)

    assert after == {
        "sessions": 1,
        "questions": 3,
        "participants": 1,
        "responses": 1,
        "answers": 3,
        "label_aliases": 0,
    }
    assert (
        await client.delete(f"{API}/sessions/{gone.code}", headers=gone.headers)
    ).status_code == 404
    assert (await client.get(f"{API}/sessions/{keep.code}")).status_code == 200


async def test_database_failures_surface_as_generic_json(app):
    from sqlalchemy.exc import OperationalError

    class Broken:
        def __call__(self):
            return self

        async def __aenter__(self):
            raise OperationalError(
                "SELECT secret_column", {"p": "participant answer"}, Exception("db down")
            )

        async def __aexit__(self, *exc):
            return False

    app.state.db.sessionmaker = Broken()
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get(f"{API}/sessions/ABCD-12")
    assert r.status_code == 500 and r.json()["detail"] == "internal_error"
    assert "secret_column" not in r.text and "participant answer" not in r.text
