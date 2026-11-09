"""CPU-bound work off the event loop.

The analytics are pure Python. Run in threads they still share the GIL with the event loop: under
load (live dashboards + a burst of submissions) the loop thread then waits for the GIL on almost
every await, which multiplied the latency of the write path by 20-50x in the load test. A small
pool of worker *processes* has its own GIL, so the web process stays responsive.

``PROCESSPOLL_COMPUTE_PROCESSES=0`` (default for dev/tests) keeps the thread fallback.
Only picklable, module-level pure functions may be submitted.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from importlib import import_module
from typing import Any, TypeVar

log = logging.getLogger("processpoll.compute")

T = TypeVar("T")
_pool: ProcessPoolExecutor | None = None
_processes = 0


def _warm() -> bool:
    """Import everything the jobs need so the first real request does not pay for it."""
    import_module("scipy.stats")
    import_module("app.analytics")
    import_module("app.normalize")
    return True


def start(processes: int) -> None:
    """Create the pool (idempotent). ``processes <= 0`` selects the thread fallback."""
    global _pool, _processes
    if processes <= 0 or _pool is not None:
        return
    _processes = processes
    _pool = ProcessPoolExecutor(
        max_workers=processes, mp_context=multiprocessing.get_context("spawn")
    )
    for _ in range(processes):
        _pool.submit(_warm)
    log.info("compute pool started with %d process(es)", processes)


def shutdown() -> None:
    global _pool
    pool, _pool = _pool, None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)


def enabled() -> bool:
    return _pool is not None


async def run(fn: Any, *args: Any, **kwargs: Any) -> Any:
    """Run ``fn(*args, **kwargs)`` in the process pool, or in a thread without a pool.

    A broken pool (a worker was killed, e.g. by the OOM killer) is replaced and the call falls
    back to a thread, so one dead worker never turns into a failed request."""
    pool = _pool
    if pool is None:
        return await asyncio.to_thread(fn, *args, **kwargs)
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(pool, functools.partial(fn, *args, **kwargs))
    except BrokenProcessPool:
        log.warning("compute pool broke, restarting it and falling back to a thread")
        _restart(pool)
        return await asyncio.to_thread(fn, *args, **kwargs)


def _restart(broken: ProcessPoolExecutor) -> None:
    global _pool
    if _pool is broken:
        _pool = None
        broken.shutdown(wait=False, cancel_futures=True)
        start(_processes)
