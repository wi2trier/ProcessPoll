"""In-process live hub: coalesced tick notifications for SSE listeners plus an analytics cache.

The hub is process-local, so the app must run with one Uvicorn worker.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable, Hashable
from typing import Any

SESSION_CACHE_TTL_SECONDS = 5.0


class Busy(Exception):
    """Too many read-model computations are queued; the caller should retry shortly."""


class LiveHub:
    def __init__(
        self,
        cache_size: int = 256,
        *,
        compute_slots: int = 3,
        queue_limit: int = 64,
        cache_per_session: int = 32,
        compute_timeout: float = 60.0,
    ) -> None:
        self._state: dict[str, dict[str, Any]] = {}
        self._gen: dict[str, int] = {}
        self._waiters: dict[str, set[asyncio.Future[None]]] = {}
        self._cache: OrderedDict[Hashable, Any] = OrderedDict()
        self._cache_size = cache_size
        self._cache_per_session = cache_per_session
        self._inflight: dict[Hashable, asyncio.Future[Any]] = {}

        self._slots = asyncio.Semaphore(compute_slots)
        self._queue_limit = queue_limit
        self._compute_timeout = compute_timeout
        self._queued = 0
        self._publish_locks: dict[str, list[Any]] = {}

        self.compute_seconds = 0.0

        self._sessions: dict[str, tuple[float, Any]] = {}
        self._session_epoch: dict[str, int] = {}

    def session_epoch(self, code: str) -> int:
        return self._session_epoch.get(code, 0)

    def session_get(self, code: str) -> Any | None:
        entry = self._sessions.get(code)
        if entry is None:
            return None
        if time.monotonic() - entry[0] > SESSION_CACHE_TTL_SECONDS:
            self._sessions.pop(code, None)
            return None
        return entry[1]

    def session_put(self, code: str, row: Any, epoch: int) -> None:
        """Store ``row`` unless the session changed since ``epoch`` was read: a slow load must
        not resurrect a stale row after a write has dropped the entry."""
        if epoch != self.session_epoch(code):
            return
        if len(self._sessions) >= 1024:
            self._sessions.pop(next(iter(self._sessions)), None)
        self._sessions[code] = (time.monotonic(), row)

    def session_drop(self, code: str) -> None:
        self._sessions.pop(code, None)
        self._session_epoch[code] = self.session_epoch(code) + 1

    def state(self, code: str) -> dict[str, Any] | None:
        return self._state.get(code)

    def generation(self, code: str) -> int:
        return self._gen.get(code, 0)

    def publish(self, code: str, state: dict[str, Any]) -> None:
        """Store the latest session counters and wake all listeners."""
        self._state[code] = dict(state)
        self._gen[code] = self._gen.get(code, 0) + 1
        self._wake(code)

    @contextlib.asynccontextmanager
    async def publishing(self, code: str) -> AsyncIterator[None]:
        """Serialise "read counters, then publish" per session.

        Without it a slow reader could publish an older snapshot after a newer one and leave
        the dashboards with stale counters until the next change."""
        entry = self._publish_locks.get(code)
        if entry is None:
            entry = self._publish_locks[code] = [asyncio.Lock(), 0]
        entry[1] += 1
        try:
            async with entry[0]:
                yield
        finally:
            entry[1] -= 1
            if entry[1] == 0 and self._publish_locks.get(code) is entry:
                del self._publish_locks[code]

    def forget(self, code: str) -> None:
        self.session_drop(code)
        self._session_epoch.pop(code, None)
        self._state.pop(code, None)
        self._gen[code] = self._gen.get(code, 0) + 1
        self._wake(code)
        self._gen.pop(code, None)
        for key in [k for k in self._cache if isinstance(k, tuple) and k and k[0] == code]:
            self._cache.pop(key, None)

    def _wake(self, code: str) -> None:
        for fut in self._waiters.get(code, set()):
            if not fut.done():
                fut.set_result(None)

    async def wait_for_change(self, code: str, last_gen: int, timeout: float) -> int:
        """Wait until the generation of ``code`` differs from ``last_gen`` (or timeout).

        Returns the current generation. Race-free: the generation is compared before waiting."""
        if self._gen.get(code, 0) != last_gen:
            return self._gen.get(code, 0)
        fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._waiters.setdefault(code, set()).add(fut)
        try:
            await asyncio.wait_for(fut, timeout)
        except TimeoutError:
            pass
        finally:
            waiters = self._waiters.get(code)
            if waiters is not None:
                waiters.discard(fut)
                if not waiters:
                    self._waiters.pop(code, None)
        return self._gen.get(code, 0)

    async def single_flight(self, key: Hashable, producer: Callable[[], Awaitable[Any]]) -> Any:
        """Run ``producer`` once per key at a time; concurrent callers share the result.

        The work runs in its own task, so a caller that disconnects does not cancel it for
        the others. At most ``compute_slots`` producers run concurrently; beyond
        ``queue_limit`` waiting ones new work is refused with :class:`Busy`. A producer that
        runs longer than ``compute_timeout`` seconds is cancelled (``TimeoutError``)."""
        task = self._inflight.get(key)
        if task is None:
            if self._queued >= self._queue_limit:
                raise Busy
            self._queued += 1
            task = asyncio.ensure_future(self._limited(producer))
            self._inflight[key] = task
            task.add_done_callback(lambda t: self._finished(key, t))
        return await asyncio.shield(task)

    async def _limited(self, producer: Callable[[], Awaitable[Any]]) -> Any:
        async with self._slots:
            return await asyncio.wait_for(producer(), self._compute_timeout)

    def _finished(self, key: Hashable, task: asyncio.Future[Any]) -> None:
        self._queued -= 1
        self._inflight.pop(key, None)
        if not task.cancelled():
            task.exception()

    def record_compute(self, seconds: float) -> None:
        self.compute_seconds = (
            seconds if self.compute_seconds == 0 else 0.7 * self.compute_seconds + 0.3 * seconds
        )

    def cache_get(self, key: Hashable) -> Any | None:
        value = self._cache.get(key)
        if value is not None:
            self._cache.move_to_end(key)
        return value

    def cache_put(self, key: Hashable, value: Any) -> None:
        self._cache[key] = value
        self._cache.move_to_end(key)
        if isinstance(key, tuple) and key:
            mine = [k for k in self._cache if isinstance(k, tuple) and k and k[0] == key[0]]
            for old in mine[: max(0, len(mine) - self._cache_per_session)]:
                self._cache.pop(old, None)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)
