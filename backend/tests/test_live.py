from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from conftest import make_test_settings

from app.live import LiveHub
from app.main import create_app


async def test_hub_wakes_waiters_and_is_race_free():
    hub = LiveHub()
    gen = hub.generation("X")
    waiter = asyncio.create_task(hub.wait_for_change("X", gen, timeout=2))
    await asyncio.sleep(0.01)
    hub.publish("X", {"version": 1})
    assert await waiter == gen + 1

    hub.publish("X", {"version": 2})
    assert await asyncio.wait_for(hub.wait_for_change("X", gen + 1, timeout=2), 0.5) == gen + 2

    assert await hub.wait_for_change("X", gen + 2, timeout=0.05) == gen + 2
    assert not hub._waiters


async def test_hub_cache_is_lru_and_forget_clears_session_entries():
    hub = LiveHub(cache_size=2)
    hub.cache_put(("A", 1), "a1")
    hub.cache_put(("B", 1), "b1")
    assert hub.cache_get(("A", 1)) == "a1"
    hub.cache_put(("C", 1), "c1")
    assert hub.cache_get(("B", 1)) is None and hub.cache_get(("A", 1)) == "a1"
    hub.forget("A")
    assert hub.cache_get(("A", 1)) is None


async def test_single_flight_runs_producer_once_and_shares_errors():
    hub = LiveHub()
    calls = 0

    async def producer():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return calls

    results = await asyncio.gather(*[hub.single_flight("k", producer) for _ in range(10)])
    assert results == [1] * 10 and calls == 1
    assert await hub.single_flight("k", producer) == 2

    async def boom():
        await asyncio.sleep(0.01)
        raise ValueError("nope")

    outcomes = await asyncio.gather(
        *[hub.single_flight("e", boom) for _ in range(3)], return_exceptions=True
    )
    assert all(isinstance(o, ValueError) for o in outcomes)
    assert not hub._inflight


async def test_cancelled_caller_does_not_cancel_shared_work():
    hub = LiveHub()
    done = asyncio.Event()

    async def producer():
        await asyncio.sleep(0.05)
        done.set()
        return "ok"

    first = asyncio.create_task(hub.single_flight("k", producer))
    second = asyncio.create_task(hub.single_flight("k", producer))
    await asyncio.sleep(0.01)
    first.cancel()
    assert await second == "ok" and done.is_set()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def live_server(tmp_path):
    """Real uvicorn server in a thread (httpx's ASGI transport cannot stream SSE)."""
    port = _free_port()
    settings = make_test_settings(f"sqlite+aiosqlite:///{tmp_path / 'live.db'}")
    config = uvicorn.Config(create_app(settings), host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        assert time.time() < deadline, "server did not start"
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)


async def read_ticks(response: httpx.Response, ticks: list[dict], stop: asyncio.Event) -> None:
    event = None
    async for line in response.aiter_lines():
        if line.startswith("event:"):
            event = line.split(":", 1)[1].strip()
        elif line.startswith("data:") and event == "tick":
            ticks.append(json.loads(line.split(":", 1)[1]))
            stop.set()
        elif line == "":
            event = None


async def test_sse_stream_pushes_ticks_on_new_responses(live_server):
    body = {
        "title": "SSE",
        "questions": [{"type": "trace", "prompt": "T", "config": {"min_steps": 1}}],
    }
    async with httpx.AsyncClient(base_url=live_server, timeout=10) as c:
        created = (await c.post("/api/v1/sessions", json=body)).json()
        code, key = created["code"], created["admin_key"]
        qid = created["session"]["questions"][0]["id"]
        await c.patch(
            f"/api/v1/sessions/{code}", json={"status": "open"}, headers={"X-Admin-Key": key}
        )

        assert (await c.get(f"/api/v1/sessions/{code}/stream")).status_code == 401

        ticks: list[dict] = []
        got = asyncio.Event()
        async with c.stream("GET", f"/api/v1/sessions/{code}/stream", params={"key": key}) as resp:
            assert resp.status_code == 200
            assert resp.headers["content-type"].startswith("text/event-stream")
            assert resp.headers["x-accel-buffering"] == "no"
            reader = asyncio.create_task(read_ticks(resp, ticks, got))
            await asyncio.wait_for(got.wait(), 5)
            assert ticks[0] == {"version": 0, "joined": 0, "submitted": 0, "status": "open"}
            got.clear()
            token = (await c.post(f"/api/v1/sessions/{code}/join", json={})).json()[
                "participant_token"
            ]
            r = await c.post(
                f"/api/v1/sessions/{code}/responses",
                json={"answers": [{"question_id": qid, "value": {"steps": ["a", "b"]}}]},
                headers={"X-Participant-Token": token},
            )
            assert r.status_code == 201
            deadline = time.time() + 5
            while not (ticks[-1]["submitted"] == 1 and ticks[-1]["joined"] == 1):
                assert time.time() < deadline, ticks
                got.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(got.wait(), 1)
            assert ticks[-1]["version"] >= 1 and ticks[-1]["status"] == "open"

            await c.patch(
                f"/api/v1/sessions/{code}", json={"status": "paused"}, headers={"X-Admin-Key": key}
            )
            deadline = time.time() + 5
            while ticks[-1]["status"] != "paused":
                assert time.time() < deadline, ticks
                got.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(got.wait(), 1)
            reader.cancel()


async def test_sse_stream_ends_when_session_is_deleted(live_server):
    body = {"title": "x", "questions": [{"type": "trace", "prompt": "T", "config": {}}]}
    async with httpx.AsyncClient(base_url=live_server, timeout=10) as c:
        created = (await c.post("/api/v1/sessions", json=body)).json()
        code, key = created["code"], created["admin_key"]
        async with c.stream("GET", f"/api/v1/sessions/{code}/stream", params={"key": key}) as resp:
            lines = resp.aiter_lines()
            await asyncio.wait_for(anext(lines), 5)
            await c.delete(f"/api/v1/sessions/{code}", headers={"X-Admin-Key": key})

            async def drain() -> None:
                async for _ in lines:
                    pass

            await asyncio.wait_for(drain(), 5)
