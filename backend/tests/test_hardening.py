"""Regression tests from the adversarial backend review (authz, input, concurrency, privacy)."""

from __future__ import annotations

import asyncio
import csv
import io
import json
import re
from datetime import timedelta

import httpx
import pytest
from conftest import MORNING_QUESTIONS, create_host

from app import service as svc
from app.live import Busy, LiveHub
from app.security import SlidingWindowLimiter, client_key, normalize_code

API = "/api/v1"
JSON_HEADERS = {"Content-Type": "application/json"}

TRACE_AND_NUMBER = [
    {"type": "trace", "prompt": "T", "config": {"min_steps": 1}},
    {"type": "number", "prompt": "N", "required": False, "config": {}},
    {"type": "text", "prompt": "X", "required": False, "config": {}},
]


async def post_raw(client, path: str, raw: str, **headers: str) -> httpx.Response:
    return await client.post(f"{API}{path}", content=raw, headers={**JSON_HEADERS, **headers})


def raw_answers(*items: tuple[str, str]) -> str:
    """Hand-written JSON (Python's encoder would refuse e.g. lone surrogates)."""
    inner = ",".join(f'{{"question_id":{json.dumps(qid)},"value":{value}}}' for qid, value in items)
    return '{"answers":[' + inner + "]}"


async def test_body_limit_is_enforced_for_chunked_uploads(client):
    host = await create_host(client)

    async def too_big():
        for _ in range(5):
            yield b" " * 20_000
        yield b'{"token": null}'

    r = await client.post(
        f"{API}/sessions/{host.code}/join", content=too_big(), headers=JSON_HEADERS
    )
    assert r.status_code == 413 and r.json()["detail"] == "payload_too_large"

    async def small():
        yield b'{"token": null}'

    r = await client.post(f"{API}/sessions/{host.code}/join", content=small(), headers=JSON_HEADERS)
    assert r.status_code == 200


async def test_body_limit_error_carries_cors_headers(app, tmp_path):
    from conftest import make_test_settings

    from app.main import create_app

    settings = make_test_settings(
        app.state.settings.database_url, allowed_origins="https://poll.example.org"
    )
    cors_app = create_app(settings, app.state.db)
    cors_app.state.db = app.state.db
    transport = httpx.ASGITransport(app=cors_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.post(
            f"{API}/sessions",
            content=b"x" * 70_000,
            headers={**JSON_HEADERS, "Origin": "https://poll.example.org"},
        )
    assert r.status_code == 413
    assert r.headers.get("access-control-allow-origin") == "https://poll.example.org"


async def test_huge_number_answer_is_a_validation_error_not_a_500(client):
    host = await create_host(client, questions=TRACE_AND_NUMBER)
    token = await host.participant()
    raw = raw_answers(
        (host.trace_id, '{"steps":["a"]}'), (host.q["N"]["id"], '{"value":' + "9" * 400 + "}")
    )
    r = await post_raw(
        client, f"/sessions/{host.code}/responses", raw, **{"X-Participant-Token": token}
    )
    assert r.status_code == 422, r.text
    assert r.json()["errors"][0]["question_id"] == host.q["N"]["id"]


@pytest.mark.parametrize("target", ["trace", "text"])
async def test_lone_surrogates_in_answers_are_rejected(client, target):
    host = await create_host(client, questions=TRACE_AND_NUMBER)
    token = await host.participant()
    trace_value = '{"steps":["a\\ud800","b"]}' if target == "trace" else '{"steps":["a","b"]}'
    text_value = '{"value":"x\\udfff"}' if target == "text" else '{"value":"ok"}'
    raw = raw_answers((host.trace_id, trace_value), (host.q["X"]["id"], text_value))
    headers = {"X-Participant-Token": token}
    r = await post_raw(client, f"/sessions/{host.code}/responses", raw, **headers)
    assert r.status_code == 422, r.text

    assert (await host.submit(["a", "b"], token=token)).status_code == 201
    for fmt in ("csv", "json", "xes"):
        r = await client.get(
            f"{API}/sessions/{host.code}/export", params={"format": fmt}, headers=host.headers
        )
        assert r.status_code == 200, fmt


@pytest.mark.parametrize(
    ("where", "body"),
    [
        ("answer question_id", '{"answers":[{"question_id":"\\ud800","value":null}]}'),
        ("answer key", '{"answers":[{"question_id":"a","value":{"\\udfff":1}}]}'),
        ("alias question_id", None),
        ("choice option", None),
        ("activity pool", None),
        ("number bins key", None),
    ],
)
async def test_lone_surrogates_are_a_422_in_every_json_field(client, where, body):
    host = await create_host(client)
    token = await host.participant()
    headers = {"X-Participant-Token": token, **host.headers}
    if where.startswith("answer"):
        r = await post_raw(client, f"/sessions/{host.code}/responses", body, **headers)
    elif where == "alias question_id":
        raw = '{"question_id":"\\ud800","aliases":[]}'
        r = await client.put(
            f"{API}/sessions/{host.code}/aliases", content=raw, headers={**JSON_HEADERS, **headers}
        )
    else:
        q = {
            "choice option": (
                '{"type":"single_choice","prompt":"c","config":{"options":["a","\\ud800"]}}'
            ),
            "activity pool": (
                '{"type":"trace","prompt":"t",'
                '"config":{"mode":"select_sort","activities":["a","\\ud800"]}}'
            ),
            "number bins key": '{"type":"number","prompt":"n","config":{"bins":[1,2],"\\ud800":1}}',
        }[where]
        raw = '{"title":"x","questions":[{"type":"trace","prompt":"T","config":{}},' + q + "]}"
        r = await post_raw(client, "/sessions", raw)
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "validation_error"

    assert "ud800" not in r.text and "udfff" not in r.text


async def test_control_characters_in_help_text_are_stripped(client):
    qs = [{"type": "trace", "prompt": "T", "help": "line 1\nline\x002", "config": {}}]
    r = await client.post(f"{API}/sessions", json={"title": "x", "questions": qs})
    assert r.status_code == 201, r.text
    assert r.json()["session"]["questions"][0]["help"] == "line 1\nline2"


@pytest.mark.parametrize(
    "config",
    [
        '{"min": NaN}',
        '{"max": Infinity}',
        '{"min": -Infinity}',
        '{"bins": [1, NaN, 3]}',
        '{"bins": [1, Infinity]}',
    ],
)
async def test_non_finite_numbers_in_question_config_are_rejected(client, config):
    raw = (
        '{"title":"x","questions":[{"type":"trace","prompt":"T","config":{}},'
        '{"type":"number","prompt":"N","config":' + config + "}]}"
    )
    r = await post_raw(client, "/sessions", raw)
    assert r.status_code == 422, r.text


async def test_malformed_join_codes_are_plain_404s(client):
    for code in ("%00", "A" * 300, "ab%00cd", "%F0%9F%98%80", "..%2F..", "AB CD"):
        r = await client.get(f"{API}/sessions/{code}")
        assert r.status_code == 404 and r.json()["detail"] == "not_found", code
    assert normalize_code(" morn-24 ") == "MORN-24"


async def test_invalid_json_nesting_has_a_stable_error_code(client):
    host = await create_host(client)
    raw = '{"answers":[{"question_id":"x","value":{"steps":%s}}]}' % ("[" * 5000 + "]" * 5000)
    r = await post_raw(
        client,
        f"/sessions/{host.code}/responses",
        raw,
        **{"X-Participant-Token": await host.participant()},
    )
    assert r.status_code in (400, 422) and r.json()["detail"] in ("bad_request", "validation_error")


async def test_unhandled_errors_become_generic_json_and_are_counted(app):
    async def boom() -> None:
        raise RuntimeError("secret internal detail")

    app.add_api_route("/boom", boom)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.get("/boom")
        assert r.status_code == 500
        assert r.headers["content-type"].startswith("application/json")
        assert r.json()["detail"] == "internal_error"
        assert "secret" not in r.text and "Traceback" not in r.text
        text = (await c.get("/metrics")).text
    assert 'route="/boom",status="5xx"} 1' in text


async def test_metrics_do_not_grow_with_arbitrary_http_methods(client):
    for i in range(20):
        await client.request(f"FUZZ{i}", f"{API}/meta")
    text = (await client.get("/metrics")).text
    assert "FUZZ" not in text


def test_limiter_cleanup_does_not_forget_longer_windows():
    now = [0.0]
    limiter = SlidingWindowLimiter(clock=lambda: now[0])
    assert limiter.allow("create:1.2.3.4", 1, 3600)
    now[0] = 100.0
    for i in range(10_100):
        limiter.allow(f"join:{i}", 5, 60)
    now[0] = 101.0
    assert limiter.allow("create:1.2.3.4", 1, 3600) is False


def test_client_key_normalises_addresses():
    assert client_key("10.0.0.1", "203.0.113.9, 10.0.0.1", trusted=True) == "203.0.113.9"
    assert client_key("10.0.0.1", "203.0.113.9", trusted=False) == "10.0.0.1"

    assert client_key("10.0.0.1", "x" * 5000, trusted=True) == "10.0.0.1"

    a = client_key("2001:db8:1:2:aaaa::1", None, trusted=False)
    b = client_key("2001:db8:1:2:bbbb::7", None, trusted=False)
    c = client_key("2001:db8:1:3::1", None, trusted=False)
    assert a == b != c
    assert client_key("::ffff:192.0.2.5", None, trusted=False) == "192.0.2.5"
    assert len(client_key("weird-" * 50, None, trusted=False)) <= 64


async def _fill_roles(host, students: int, lecturers: int) -> None:
    for _ in range(students):
        assert (await host.submit(["a", "b"], role="Student")).status_code == 201
    for _ in range(lecturers):
        assert (await host.submit(["a", "c"], role="Lecturer")).status_code == 201


async def test_changing_k_min_invalidates_cached_comparison(client):
    host = await create_host(client, settings={"k_min": 1})
    await _fill_roles(host, 6, 2)
    url = f"{API}/sessions/{host.code}/compare"
    params = {"question_id": host.trace_id, "group_by": host.q["Role"]["id"]}
    first = await client.get(url, params=params, headers=host.headers)
    assert {g["value"] for g in first.json()["groups"]} == {"Student", "Lecturer"}
    r = await client.patch(
        f"{API}/sessions/{host.code}", json={"settings": {"k_min": 3}}, headers=host.headers
    )
    assert r.status_code == 200
    second = await client.get(
        url, params=params, headers={**host.headers, "If-None-Match": first.headers["etag"]}
    )
    assert second.status_code == 200, "stale ETag must not give a 304 after k_min changed"
    body = second.json()
    assert [g["value"] for g in body["groups"]] == ["Student"]
    assert body["hidden_groups"] == [{"value": "Lecturer", "n": 2}]
    assert body["version"] > first.json()["version"]


async def test_if_none_match_accepts_weak_validators_and_lists(client):
    host = await create_host(client)
    await host.submit(["a", "b"])
    url = f"{API}/sessions/{host.code}/analytics"
    params = {"question_id": host.trace_id}
    etag = (await client.get(url, params=params, headers=host.headers)).headers["etag"]
    for value in (etag, f"W/{etag}", f'"other", W/{etag}', "*"):
        r = await client.get(url, params=params, headers={**host.headers, "If-None-Match": value})
        assert r.status_code == 304, value
    r = await client.get(url, params=params, headers={**host.headers, "If-None-Match": '"nope"'})
    assert r.status_code == 200


async def test_question_text_change_is_visible_in_cached_comparison(client):
    host = await create_host(client, settings={"k_min": 1})
    await _fill_roles(host, 2, 2)
    url = f"{API}/sessions/{host.code}/compare"
    params = {"question_id": host.trace_id, "group_by": host.q["Role"]["id"]}
    assert (await client.get(url, params=params, headers=host.headers)).json()["group_by"][
        "prompt"
    ] == "Role"
    r = await client.patch(
        f"{API}/sessions/{host.code}/questions/{host.q['Role']['id']}",
        json={"prompt": "Position"},
        headers=host.headers,
    )
    assert r.status_code == 200
    again = await client.get(url, params=params, headers=host.headers)
    assert again.json()["group_by"]["prompt"] == "Position"


async def test_filtered_analytics_hide_small_groups_from_non_admins(client):
    host = await create_host(client)
    await _fill_roles(host, 6, 2)
    url = f"{API}/sessions/{host.code}/analytics"
    role = host.q["Role"]["id"]

    def params(value: str) -> dict[str, str]:
        return {
            "question_id": host.trace_id,
            "filter_question_id": role,
            "filter_value": value,
        }

    admin = (await client.get(url, params=params("Lecturer"), headers=host.headers)).json()
    assert admin["n"] == 2 and admin.get("suppressed") is None
    shown = await client.get(url, params={**params("Lecturer"), "key": host.display_key})
    assert shown.status_code == 200
    body = shown.json()
    assert body["n"] == 0 and body["variants"] == [] and body["suppressed"] is True
    assert body["filter"] == {"question_id": role, "value": "Lecturer"}
    assert (
        shown.headers["etag"]
        != (await client.get(url, params=params("Lecturer"), headers=host.headers)).headers["etag"]
    )
    big = (await client.get(url, params={**params("Student"), "key": host.display_key})).json()
    assert big["n"] == 6 and big.get("suppressed") is None

    await client.patch(
        f"{API}/sessions/{host.code}",
        json={"settings": {"results_public": True}},
        headers=host.headers,
    )
    anon = (await client.get(url, params=params("Lecturer"))).json()
    assert anon["n"] == 0 and anon["suppressed"] is True

    full = (await client.get(url, params={"question_id": host.trace_id})).json()
    assert full["n"] == 8


async def test_analytics_arguments_are_validated_before_computing(client, monkeypatch):
    host = await create_host(client)
    called = False

    async def boom(*args, **kwargs):
        nonlocal called
        called = True
        raise AssertionError("dataset must not be built for invalid arguments")

    monkeypatch.setattr("app.analytics_service.build_dataset", boom)
    base = {"question_id": host.trace_id}
    url = f"{API}/sessions/{host.code}"
    cases = [
        (f"{url}/analytics", {**base, "filter_question_id": "nope", "filter_value": "x"}, 404),
        (
            f"{url}/analytics",
            {**base, "filter_question_id": host.trace_id, "filter_value": "x"},
            422,
        ),
        (f"{url}/compare", {**base, "group_by": host.trace_id}, 422),
        (f"{url}/compare", {**base, "group_by": "nope"}, 404),
        (f"{url}/analytics", {"question_id": host.q["Role"]["id"]}, 422),
    ]
    for path, params, status in cases:
        r = await client.get(path, params=params, headers=host.headers)
        assert r.status_code == status, (path, params, r.text)
    assert not called


async def test_single_flight_bounds_concurrency_and_queue():
    hub = LiveHub(compute_slots=2, queue_limit=4)
    running = peak = 0
    release = asyncio.Event()

    async def producer() -> str:
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await release.wait()
        running -= 1
        return "ok"

    tasks = [asyncio.create_task(hub.single_flight(f"k{i}", producer)) for i in range(4)]
    await asyncio.sleep(0.02)
    with pytest.raises(Busy):
        await hub.single_flight("one-too-many", producer)

    joiner = asyncio.create_task(hub.single_flight("k0", producer))
    release.set()
    assert await asyncio.gather(*tasks, joiner) == ["ok"] * 5
    assert peak == 2 and not hub._inflight


async def test_stuck_computation_times_out_and_frees_its_slot():
    hub = LiveHub(compute_slots=1, compute_timeout=0.05)

    async def stuck() -> str:
        await asyncio.sleep(30)
        return "never"

    async def fine() -> str:
        return "ok"

    with pytest.raises(TimeoutError):
        await hub.single_flight("a", stuck)
    assert await asyncio.wait_for(hub.single_flight("b", fine), 1) == "ok"
    assert not hub._inflight and hub._queued == 0


async def test_timed_out_computation_is_reported_as_busy(app, client, monkeypatch):
    host = await create_host(client)
    await host.submit(["a", "b"])
    app.state.hub._compute_timeout = 0.05

    async def slow(*args, **kwargs):
        await asyncio.sleep(5)

    monkeypatch.setattr("app.analytics_service.compute_analytics", slow)
    r = await client.get(
        f"{API}/sessions/{host.code}/analytics",
        params={"question_id": host.trace_id},
        headers=host.headers,
    )
    assert r.status_code == 503 and r.json()["detail"] == "busy"
    assert r.headers["retry-after"] == "2"


async def test_cache_is_bounded_per_session():
    hub = LiveHub(cache_size=100, cache_per_session=3)
    for i in range(10):
        hub.cache_put(("A", 1, i), i)
    hub.cache_put(("B", 1, 0), "b")
    assert sum(1 for k in hub._cache if k[0] == "A") == 3
    assert hub.cache_get(("A", 1, 9)) == 9 and hub.cache_get(("A", 1, 0)) is None
    assert hub.cache_get(("B", 1, 0)) == "b"


async def test_hub_forget_drops_generation_and_waiters_still_wake():
    hub = LiveHub()
    hub.publish("X", {"version": 1})
    gen = hub.generation("X")
    waiter = asyncio.create_task(hub.wait_for_change("X", gen, timeout=5))
    await asyncio.sleep(0.01)
    hub.forget("X")
    assert await asyncio.wait_for(waiter, 1) != gen
    assert "X" not in hub._gen and hub.state("X") is None
    assert await hub.wait_for_change("X", gen, timeout=0.01) != gen


async def test_publish_order_follows_database_order(client, app, monkeypatch):
    """A slow, stale read must not overwrite a newer state published by a later request."""
    host = await create_host(client)
    original = svc.live_state
    calls = 0

    async def delayed(db, code):
        nonlocal calls
        calls += 1
        mine = calls
        state = await original(db, code)
        if mine == 1:
            await asyncio.sleep(0.3)
        return state

    monkeypatch.setattr(svc, "live_state", delayed)
    first = asyncio.create_task(client.post(f"{API}/sessions/{host.code}/join", json={}))
    await asyncio.sleep(0.1)
    second = asyncio.create_task(client.post(f"{API}/sessions/{host.code}/join", json={}))
    await asyncio.gather(first, second)
    assert app.state.hub.state(host.code)["joined"] == 2


async def test_concurrent_cache_misses_do_not_exhaust_the_db_pool(app, client):
    host = await create_host(client)
    for _ in range(3):
        assert (await host.submit(["a", "b"])).status_code == 201
    app.state.db.engine.pool._timeout = 2
    url = f"{API}/sessions/{host.code}"
    requests = [
        client.get(f"{url}/analytics", params={"question_id": host.trace_id}, headers=host.headers)
        for _ in range(60)
    ] + [
        client.get(f"{url}/labels/suggest", params={"question_id": host.trace_id, "q": f"{i}"})
        for i in range(30)
    ]
    responses = await asyncio.gather(*requests)
    assert [r.status_code for r in responses if r.status_code != 200] == []


async def test_resubmitting_deletes_the_replaced_answers(app, client):
    from sqlalchemy import func, select

    from app.models import AnswerRow, ResponseRow

    host = await create_host(client, settings={"allow_resubmit": True})
    token = await host.participant()
    first = await host.submit(["Call Dr Mueller", "x"], token=token, key="k1", role="Student")
    second = await host.submit(["a", "b"], token=token, key="k2")
    assert first.status_code == 201 and second.status_code == 201
    async with app.state.db.sessionmaker() as s:
        old_answers = (
            await s.execute(
                select(func.count())
                .select_from(AnswerRow)
                .where(AnswerRow.response_id == first.json()["response_id"])
            )
        ).scalar_one()
        responses = (await s.execute(select(func.count()).select_from(ResponseRow))).scalar_one()
        stored = (await s.execute(select(AnswerRow.value))).scalars().all()
    assert old_answers == 0, "the overwritten answers must not stay in the database"
    assert responses == 2
    assert "Mueller" not in str(stored)

    retry = await host.submit(["Call Dr Mueller", "x"], token=token, key="k1")
    assert retry.status_code == 200 and retry.json() == first.json()
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["submitted"] == 1


async def test_concurrent_resubmits_keep_exactly_one_current_response(app, client):
    from sqlalchemy import func, select

    from app.models import ResponseRow

    host = await create_host(client, settings={"allow_resubmit": True})
    token = await host.participant()
    assert (await host.submit(["first", "answer"], token=token, key="k0")).status_code == 201
    results = await asyncio.gather(
        *[host.submit([f"s{i}", "end"], token=token, key=f"k{i + 1}") for i in range(6)]
    )
    assert {r.status_code for r in results} <= {201, 409}
    assert any(r.status_code == 201 for r in results)
    async with app.state.db.sessionmaker() as s:
        current = (
            await s.execute(
                select(func.count())
                .select_from(ResponseRow)
                .where(ResponseRow.is_current.is_(True))
            )
        ).scalar_one()
    assert current == 1
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["submitted"] == 1


async def test_concurrent_alias_updates_do_not_conflict(client):
    host = await create_host(client)
    await host.submit(["a", "b"])
    body = {
        "question_id": host.trace_id,
        "aliases": [
            {"raw_key": "a", "canonical": "A", "hidden": False},
            {"raw_key": "b", "canonical": None, "hidden": True},
        ],
    }
    rs = await asyncio.gather(
        *[
            client.put(f"{API}/sessions/{host.code}/aliases", json=body, headers=host.headers)
            for _ in range(8)
        ]
    )
    assert [r.status_code for r in rs] == [200] * 8


async def test_alias_keys_that_grow_past_the_column_are_rejected(client):
    host = await create_host(client)
    r = await client.put(
        f"{API}/sessions/{host.code}/aliases",
        json={
            "question_id": host.trace_id,
            "aliases": [{"raw_key": "\ufdfa" * 30, "canonical": "x", "hidden": False}],
        },
        headers=host.headers,
    )
    assert r.status_code == 422 and r.json()["detail"] == "validation_error"


async def test_concurrent_close_and_pause_cannot_reopen_a_closed_session(client):
    host = await create_host(client)
    close, pause = await asyncio.gather(host.set_status("closed"), host.set_status("paused"))
    assert {close.status_code, pause.status_code} <= {200, 409}
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()

    assert admin["status"] == ("closed" if close.status_code == 200 else "paused")
    if admin["status"] == "closed":
        assert admin["closed_at"] is not None


async def test_submission_racing_with_close_is_not_accepted(client, monkeypatch):
    host = await create_host(client)
    token = await host.participant()
    original = svc.current_response
    entered, gate = asyncio.Event(), asyncio.Event()

    async def slow(db, participant_id):
        result = await original(db, participant_id)
        entered.set()
        await gate.wait()
        return result

    monkeypatch.setattr(svc, "current_response", slow)
    pending = asyncio.create_task(host.submit(["a", "b"], token=token))
    await asyncio.wait_for(entered.wait(), 5)
    assert (await host.set_status("closed")).status_code == 200
    gate.set()
    r = await pending
    assert r.status_code == 403 and r.json()["detail"] == "session_not_open"
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["submitted"] == 0


async def test_questions_are_not_replaced_when_the_session_opens_meanwhile(client, monkeypatch):
    host = await create_host(client, open_session=False)
    original = svc.bump_version
    entered, gate = asyncio.Event(), asyncio.Event()

    async def slow(db, session_id, **kwargs):
        entered.set()
        await gate.wait()
        return await original(db, session_id, **kwargs)

    monkeypatch.setattr(svc, "bump_version", slow)
    body = {"questions": [{"type": "trace", "prompt": "Replaced", "config": {}}]}
    pending = asyncio.create_task(
        client.put(f"{API}/sessions/{host.code}/questions", json=body, headers=host.headers)
    )
    await asyncio.wait_for(entered.wait(), 5)
    assert (await host.set_status("open")).status_code == 200
    gate.set()
    r = await pending
    assert r.status_code == 409 and r.json()["detail"] == "questions_locked"
    pub = (await client.get(f"{API}/sessions/{host.code}")).json()
    assert pub["questions"][0]["id"] == host.trace_id


async def test_retention_sweep_works_in_batches_and_spares_extended_sessions(app, client):
    from sqlalchemy import update

    from app.main import sweep_expired
    from app.models import SessionRow, utcnow

    hosts = [await create_host(client) for _ in range(5)]
    async with app.state.db.sessionmaker() as s:
        await s.execute(
            update(SessionRow)
            .where(SessionRow.code.in_([h.code for h in hosts[:4]]))
            .values(expires_at=utcnow() - timedelta(days=1))
        )
        await s.commit()
    assert await sweep_expired(app.state.db, app.state.hub, batch_size=3) == 4
    assert (await client.get(f"{API}/sessions/{hosts[0].code}")).status_code == 404
    assert (await client.get(f"{API}/sessions/{hosts[4].code}")).status_code == 200


async def test_retention_sweep_keeps_unclosed_sessions_that_are_still_in_use(app, client):
    """retention_days counts from creation for sessions that were never closed; a poll that
    is open and receiving answers must not be deleted underneath its host."""
    from sqlalchemy import update

    from app.main import sweep_expired
    from app.models import SessionRow, utcnow
    from app.schemas import utc_z

    active = await create_host(client, settings={"retention_days": 1})
    idle = await create_host(client, settings={"retention_days": 1})
    closed = await create_host(client, settings={"retention_days": 1})
    abandoned = await create_host(client, open_session=False)
    await active.submit(["a", "b"])
    await closed.submit(["a", "b"])
    await closed.set_status("closed")
    async with app.state.db.sessionmaker() as s:
        await s.execute(
            update(SessionRow)
            .where(SessionRow.code.in_([h.code for h in (active, idle, closed, abandoned)]))
            .values(expires_at=utcnow() - timedelta(hours=1))
        )
        await s.commit()
    assert await sweep_expired(app.state.db, app.state.hub) == 3
    assert (await client.get(f"{API}/sessions/{active.code}")).status_code == 200
    for gone in (idle, closed, abandoned):
        assert (await client.get(f"{API}/sessions/{gone.code}")).status_code == 404
    admin = (await client.get(f"{API}/sessions/{active.code}/admin", headers=active.headers)).json()
    assert admin["expires_at"] > utc_z(utcnow())
    assert await sweep_expired(app.state.db, app.state.hub) == 0


async def test_csv_keeps_negative_numbers_and_still_neutralises_text(client):
    qs = [
        {"type": "trace", "prompt": "T", "config": {"min_steps": 1}},
        {"type": "number", "prompt": "Delta", "required": False, "config": {}},
        {"type": "text", "prompt": "Note", "required": False, "config": {}},
    ]
    host = await create_host(client, questions=qs)
    token = await host.participant()
    answers = [
        {"question_id": host.trace_id, "value": {"steps": ["a"]}},
        {"question_id": host.q["Delta"]["id"], "value": {"value": -5}},
        {"question_id": host.q["Note"]["id"], "value": {"value": "-1+1"}},
    ]
    r = await client.post(
        f"{API}/sessions/{host.code}/responses",
        json={"answers": answers},
        headers={"X-Participant-Token": token},
    )
    assert r.status_code == 201
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "csv"}, headers=host.headers
    )
    row = next(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert row["Delta"] == "-5"
    assert row["Note"] == "'-1+1"


async def test_hidden_labels_are_left_out_of_every_export_format(client):
    host = await create_host(client)
    await host.submit(["Wake up", "Call Dr Mueller", "Coffee"])
    await host.submit(["Wake up", "call dr mueller!", "Coffee"])
    r = await client.put(
        f"{API}/sessions/{host.code}/aliases",
        json={
            "question_id": host.trace_id,
            "aliases": [
                {"raw_key": "call dr mueller", "canonical": None, "hidden": True},
                {"raw_key": "wake up", "canonical": "Get up", "hidden": False},
            ],
        },
        headers=host.headers,
    )
    assert r.status_code == 200
    for fmt in ("csv", "xes", "json"):
        r = await client.get(
            f"{API}/sessions/{host.code}/export", params={"format": fmt}, headers=host.headers
        )
        assert r.status_code == 200
        assert b"ueller" not in r.content, fmt
    data = json.loads(
        (
            await client.get(
                f"{API}/sessions/{host.code}/export",
                params={"format": "json"},
                headers=host.headers,
            )
        ).content
    )
    assert [a["raw_key"] for a in data["aliases"]] == ["wake up"]
    steps = [r["answers"][host.trace_id]["steps"] for r in data["responses"]]
    assert steps == [["Wake up", "Coffee"], ["Wake up", "Coffee"]]


async def test_export_timestamps_are_utc_with_z(client):
    host = await create_host(client)
    await host.submit(["a", "b"])
    pattern = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "csv"}, headers=host.headers
    )
    rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert all(pattern.match(x["submitted_at"]) for x in rows)
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "json"}, headers=host.headers
    )
    data = json.loads(r.content)
    assert pattern.match(data["responses"][0]["submitted_at"])
    assert pattern.match(data["session"]["created_at"]) and pattern.match(
        data["session"]["opened_at"]
    )


def test_database_errors_do_not_echo_bound_parameters(app):

    assert app.state.db.engine.sync_engine.hide_parameters is True


async def test_guessing_join_codes_is_throttled_per_client(app, client):
    app.state.settings.unknown_code_per_minute = 3
    host = await create_host(client)
    for _ in range(3):
        assert (await client.get(f"{API}/sessions/ZZZZ-99")).status_code == 404
    r = await client.get(f"{API}/sessions/ZZZZ-98")
    assert r.status_code == 429 and r.json()["detail"] == "rate_limited"

    assert (await client.get(f"{API}/sessions/{host.code}")).status_code == 200
    assert (await client.get(f"{API}/sessions/%00")).status_code == 429

    app.state.settings.trusted_proxy = True
    other = await client.get(f"{API}/sessions/ZZZZ-97", headers={"X-Forwarded-For": "198.51.100.7"})
    assert other.status_code == 404


async def test_healthz_reports_degraded_instead_of_hanging(app, client, monkeypatch):
    class Stuck:
        async def __aenter__(self):
            await asyncio.sleep(60)

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(app.state.db, "sessionmaker", lambda: Stuck())
    started = asyncio.get_running_loop().time()
    r = await client.get("/healthz")
    assert r.status_code == 503 and r.json() == {"status": "degraded", "db": False}
    assert asyncio.get_running_loop().time() - started < 10


async def test_session_creation_limit_ignores_forwarded_for_unless_trusted(app, client):
    app.state.settings.session_create_per_hour = 1
    body = {"title": "x", "questions": MORNING_QUESTIONS}
    ok = await client.post(f"{API}/sessions", json=body, headers={"X-Forwarded-For": "1.1.1.1"})
    assert ok.status_code == 201
    blocked = await client.post(
        f"{API}/sessions", json=body, headers={"X-Forwarded-For": "2.2.2.2"}
    )
    assert blocked.status_code == 429
    app.state.settings.trusted_proxy = True
    other = await client.post(f"{API}/sessions", json=body, headers={"X-Forwarded-For": "3.3.3.3"})
    assert other.status_code == 201


async def test_reserved_no_answer_option_is_rejected(client):
    body = {
        "title": "x",
        "questions": [
            {"type": "trace", "prompt": "t", "config": {}},
            {"type": "single_choice", "prompt": "c", "config": {"options": ["Yes", "(No Answer)"]}},
        ],
    }
    r = await client.post("/api/v1/sessions", json=body)
    assert r.status_code == 422 and r.json()["detail"] == "validation_error"


async def test_title_change_bumps_the_version_and_publishes_a_tick(client):
    from conftest import create_host

    host = await create_host(client)
    before = (await client.get(f"/api/v1/sessions/{host.code}/admin", headers=host.headers)).json()

    r = await client.patch(
        f"/api/v1/sessions/{host.code}", json={"title": before["title"]}, headers=host.headers
    )
    assert r.json()["version"] == before["version"]
    r = await client.patch(
        f"/api/v1/sessions/{host.code}", json={"title": "A new title"}, headers=host.headers
    )
    assert r.status_code == 200
    assert r.json()["title"] == "A new title"
    assert r.json()["version"] == before["version"] + 1


async def test_public_session_cache_is_dropped_by_every_admin_change(client):
    from conftest import create_host

    host = await create_host(client, open_session=False)
    url = f"/api/v1/sessions/{host.code}"
    first = (await client.get(url)).json()
    assert first["status"] == "draft"
    await host.set_status("open")
    assert (await client.get(url)).json()["status"] == "open"
    qid = first["questions"][0]["id"]
    r = await client.patch(
        f"{url}/questions/{qid}", json={"prompt": "Reworded", "help": "h"}, headers=host.headers
    )
    assert r.status_code == 200
    q = (await client.get(url)).json()["questions"][0]
    assert q["prompt"] == "Reworded" and q["help"] == "h"
    await client.patch(url, json={"title": "Other title"}, headers=host.headers)
    assert (await client.get(url)).json()["title"] == "Other title"
    await client.patch(url, json={"settings": {"results_public": True}}, headers=host.headers)
    assert (await client.get(url)).json()["settings"]["results_public"] is True
    await host.set_status("paused")
    assert (await client.get(url)).json()["status"] == "paused"
    assert (await client.delete(url, headers=host.headers)).status_code == 204
    assert (await client.get(url)).status_code == 404


async def test_public_session_cache_ignores_a_stale_load_that_finishes_after_a_write(app):
    hub = app.state.hub
    epoch = hub.session_epoch("ABCD-12")
    hub.session_drop("ABCD-12")
    hub.session_put("ABCD-12", object(), epoch)
    assert hub.session_get("ABCD-12") is None
    hub.session_put("ABCD-12", "fresh", hub.session_epoch("ABCD-12"))
    assert hub.session_get("ABCD-12") == "fresh"
    hub.forget("ABCD-12")
    assert hub.session_get("ABCD-12") is None
