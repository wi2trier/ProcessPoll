"""SSE listeners must not leak (futures, counters, DB connections) when clients vanish."""

from __future__ import annotations

import asyncio
import socket
import threading
import time

import httpx
import uvicorn
from conftest import make_test_settings

from app.live import LiveHub
from app.main import create_app

API = "/api/v1"


async def test_cancelled_waiters_leave_nothing_behind():
    hub = LiveHub()
    waiters = [asyncio.create_task(hub.wait_for_change("X", 0, timeout=30)) for _ in range(50)]
    await asyncio.sleep(0.01)
    assert sum(len(v) for v in hub._waiters.values()) == 50
    for w in waiters:
        w.cancel()
    await asyncio.gather(*waiters, return_exceptions=True)
    assert not hub._waiters
    hub.publish("X", {"version": 1})
    hub.forget("X")
    assert not hub._state and not hub._gen and not hub._publish_locks


async def test_abruptly_closed_streams_release_listeners_and_connections(tmp_path):
    settings = make_test_settings(
        f"sqlite+aiosqlite:///{tmp_path / 'sse.db'}", heartbeat_seconds=0.2
    )
    app = create_app(settings)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while not server.started:
        assert time.time() < deadline, "server did not start"
        time.sleep(0.05)
    sockets: list[socket.socket] = []
    try:
        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=10) as c:
            body = {"title": "x", "questions": [{"type": "trace", "prompt": "T", "config": {}}]}
            created = (await c.post(f"{API}/sessions", json=body)).json()
            code, key = created["code"], created["admin_key"]
            for _ in range(60):
                s = socket.create_connection(("127.0.0.1", port))
                request = f"GET {API}/sessions/{code}/stream?key={key} HTTP/1.1\r\nHost: x\r\n\r\n"
                s.sendall(request.encode())
                sockets.append(s)
            for _ in range(300):
                if app.state.metrics.sse_listeners == 60:
                    break
                await asyncio.sleep(0.05)
            assert app.state.metrics.sse_listeners == 60
            for s in sockets:
                s.close()
            for _ in range(300):
                if app.state.metrics.sse_listeners == 0:
                    break
                await asyncio.sleep(0.05)
            assert app.state.metrics.sse_listeners == 0
            assert not app.state.hub._waiters

            assert app.state.db.engine.pool.checkedout() == 0
            assert (await c.get(f"{API}/sessions/{code}")).status_code == 200
    finally:
        for s in sockets:
            s.close()
        server.should_exit = True
        thread.join(timeout=10)
