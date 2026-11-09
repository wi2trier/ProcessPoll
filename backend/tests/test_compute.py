"""The compute module: process pool (own GIL) with a thread fallback."""

from __future__ import annotations

import os
import signal

import pytest

from app import compute
from app.analytics import analyze

TRACES = [["A", "B", "C"]] * 4 + [["A", "C"]] * 3 + [["A", "B", "B", "C"]] * 2 + [["B", "C"]]


@pytest.fixture
def pool():
    compute.start(1)
    yield
    compute.shutdown()


async def test_without_a_pool_the_work_runs_in_a_thread():
    assert not compute.enabled()
    assert await compute.run(analyze, TRACES, min_support=2) == analyze(TRACES, min_support=2)


async def test_process_pool_gives_the_same_result_as_direct_calls(pool):
    assert compute.enabled()
    expected = analyze(TRACES, min_support=2, theta=0.6)
    got = await compute.run(analyze, TRACES, min_support=2, theta=0.6)
    assert got == expected

    import asyncio

    results = await asyncio.gather(*[compute.run(analyze, TRACES) for _ in range(6)])
    assert all(r == analyze(TRACES) for r in results)


async def test_a_killed_worker_does_not_fail_the_request(pool):
    await compute.run(analyze, TRACES)
    workers = list(compute._pool._processes.values())
    assert workers
    for proc in workers:
        os.kill(proc.pid, signal.SIGTERM)
        proc.join(timeout=10)

    assert await compute.run(analyze, TRACES, min_support=2) == analyze(TRACES, min_support=2)
    assert compute.enabled()
    assert await compute.run(analyze, TRACES) == analyze(TRACES)


def test_start_is_idempotent_and_zero_means_threads():
    compute.start(0)
    assert not compute.enabled()
    compute.start(1)
    first = compute._pool
    compute.start(2)
    assert compute._pool is first
    compute.shutdown()
    assert not compute.enabled()
