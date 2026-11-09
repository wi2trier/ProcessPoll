"""Locust load test for ProcessPoll (see loadtest/README.md).

User classes
------------
ParticipantUser  fetch session -> join -> think (with LT_SUGGEST_CALLS autocomplete requests in
                 free mode) -> submit one synthetic response (Idempotency-Key header) -> stop.
                 Submissions are spread over LT_SUBMIT_WINDOW seconds.
DashboardUser    SSE stream with the display key + analytics fetch on every new
                 version (+ occasional group comparison). Measures tick latency.
ListenerUser     like DashboardUser, but for participants watching public
                 results (no key, throttled analytics fetches).
HostUser         exactly one; polls the admin endpoints like the host UI does.

The session is created and opened ONCE per test in the `test_start` listener
(or reused with LT_SESSION_CODE). In distributed mode the master creates it and
sends it to the workers.

Configuration is done through environment variables (they are inherited by
workers) - see the table in loadtest/README.md. Quick example::

    LT_DASHBOARDS=5 locust -f locustfile.py --host http://localhost:8080 \
        --headless -u 506 -r 100 -t 2m
    # 506 = 1 host + 5 dashboards + 500 participants
"""
from __future__ import annotations

import bisect
import itertools
import json
import logging
import os
import random
import time
from typing import Any

from locust import HttpUser, constant, events, task
from locust import log as locust_log
from locust.exception import StopUser
from locust.runners import MasterRunner, WorkerRunner

import gevent
import requests
from gevent.event import Event

import synthetic

log = logging.getLogger("processpoll.loadtest")
API = "/api/v1"
NAME_SUBMIT = "POST /sessions/[code]/responses"


def _env(name: str, default: Any, cast=str):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    if cast is bool:
        return raw.strip().lower() in ("1", "true", "yes", "on")
    return cast(raw)


SESSION_CODE = _env("LT_SESSION_CODE", "")
ADMIN_KEY = _env("LT_ADMIN_KEY", "")
DISPLAY_KEY = _env("LT_DISPLAY_KEY", "")
MODE = _env("LT_MODE", "free")
NOISE = _env("LT_NOISE", 0.25, float)
STUDENT_SHARE = _env("LT_STUDENT_SHARE", 0.7, float)
RESULTS_PUBLIC = _env("LT_RESULTS_PUBLIC", True, bool)
SUBMIT_WINDOW = _env("LT_SUBMIT_WINDOW", 30.0, float)
THINK_MIN = _env("LT_THINK_MIN", 1.0, float)
THINK_MAX = _env("LT_THINK_MAX", 4.0, float)
SUGGEST_CALLS = _env("LT_SUGGEST_CALLS", 4, int)
DASHBOARDS = _env("LT_DASHBOARDS", 5, int)
LISTENERS = _env("LT_LISTENERS", 0, int)
LISTENER_USE_KEY = _env("LT_LISTENER_USE_KEY", False, bool)
LISTENER_MIN_FETCH = _env("LT_LISTENER_MIN_FETCH", 2.0, float)
COMPARE_EVERY = _env("LT_DASHBOARD_COMPARE_EVERY", 5, int)
SSE_MAX_SECONDS = _env("LT_SSE_MAX_SECONDS", 0.0, float)
HOST_POLL_SECONDS = _env("LT_HOST_POLL_SECONDS", 5.0, float)
SEED = _env("LT_SEED", 1, int)
CLOSE_AT_END = _env("LT_CLOSE_AT_END", True, bool)
MAX_FAIL_RATIO = _env("LT_MAX_FAIL_RATIO", 0.01, float)
SUBMIT_P95_MS = _env("LT_SUBMIT_P95_MS", 0.0, float)


class Shared:
    def __init__(self) -> None:
        self.ready = Event()
        self.code = ""
        self.admin_key = ""
        self.display_key = ""
        self.trace_qid = ""
        self.group_qid = ""
        self.created_here = False
        self.baseline_submitted = 0
        self.submit_times: list[float] = []
        self.single_process = True
        self.counter = itertools.count()

    def apply(self, data: dict[str, Any]) -> None:
        self.code = data["code"]
        self.admin_key = data.get("admin_key", "")
        self.display_key = data.get("display_key", "")
        self.trace_qid = data["trace_qid"]
        self.group_qid = data.get("group_qid", "")
        self.baseline_submitted = int(data.get("baseline_submitted", 0))
        self.ready.set()

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code, "admin_key": self.admin_key, "display_key": self.display_key,
            "trace_qid": self.trace_qid, "group_qid": self.group_qid,
            "baseline_submitted": self.baseline_submitted,
        }


SHARED = Shared()


def _admin_headers() -> dict[str, str]:
    return {"X-Admin-Key": SHARED.admin_key} if SHARED.admin_key else {}


def _display_headers() -> dict[str, str]:
    if SHARED.display_key:
        return {"X-Display-Key": SHARED.display_key}
    return _admin_headers()


def _http(host: str, method: str, path: str, **kw) -> requests.Response:
    resp = requests.request(method, f"{host.rstrip('/')}{API}{path}", timeout=20, **kw)
    if resp.status_code >= 400:
        raise RuntimeError(f"{method} {path} -> HTTP {resp.status_code}: {resp.text[:300]}")
    return resp


def _bootstrap(host: str) -> None:
    if SESSION_CODE:
        code = SESSION_CODE.upper()
        session = _http(host, "GET", f"/sessions/{code}").json()
        info: dict[str, Any] = {"code": code, "admin_key": ADMIN_KEY, "display_key": DISPLAY_KEY}
        if ADMIN_KEY:
            admin = _http(host, "GET", f"/sessions/{code}/admin", headers={"X-Admin-Key": ADMIN_KEY}).json()
            info["display_key"] = DISPLAY_KEY or admin.get("display_key", "")
            info["baseline_submitted"] = admin.get("submitted", 0)
            if admin["status"] in ("draft", "paused"):
                _http(host, "PATCH", f"/sessions/{code}", json={"status": "open"}, headers={"X-Admin-Key": ADMIN_KEY})
        elif session["status"] != "open":
            raise RuntimeError(f"session {code} is '{session['status']}' and no LT_ADMIN_KEY was given to open it")
    else:
        payload = synthetic.session_payload(
            title=f"Loadtest {time.strftime('%Y-%m-%d %H:%M:%S')}",
            mode=MODE,
            results_public=RESULTS_PUBLIC,
            retention_days=1,
        )
        created = _http(host, "POST", "/sessions", json=payload).json()
        code = created["code"]
        _http(host, "PATCH", f"/sessions/{code}", json={"status": "open"}, headers={"X-Admin-Key": created["admin_key"]})
        session = created["session"]
        info = {"code": code, "admin_key": created["admin_key"], "display_key": created["display_key"], "baseline_submitted": 0}
        SHARED.created_here = True

    questions = session["questions"]
    trace_q = synthetic.trace_question(questions)
    if not trace_q:
        raise RuntimeError("the session has no trace question")
    group_q = synthetic.role_question(questions)
    info["trace_qid"] = trace_q["id"]
    info["group_qid"] = group_q["id"] if group_q else ""
    SHARED.apply(info)

    base = host.rstrip("/")
    log.info("session %s ready (created here: %s)", code, SHARED.created_here)
    log.info("join link   : %s/j/%s", base, code)
    log.info("host link   : %s/host/%s?key=%s", base, code, SHARED.admin_key)
    log.info("display link: %s/display/%s?key=%s", base, code, SHARED.display_key)
    try:
        with open(os.path.join(os.path.dirname(__file__), ".last-session.json"), "w", encoding="utf-8") as fh:
            json.dump({**SHARED.as_dict(), "host": base}, fh, indent=2)
    except OSError:
        pass


@events.init.add_listener
def _on_init(environment, **_kw) -> None:
    runner = environment.runner
    if isinstance(runner, WorkerRunner):
        SHARED.single_process = False

        def _on_session(msg, **_kwargs) -> None:
            SHARED.apply(msg.data)

        runner.register_message("processpoll_session", _on_session)
    elif isinstance(runner, MasterRunner):
        SHARED.single_process = False


@events.test_start.add_listener
def _on_test_start(environment, **_kw) -> None:
    runner = environment.runner
    if isinstance(runner, WorkerRunner):
        return
    if not environment.host:
        raise RuntimeError("--host is required, e.g. --host http://localhost:8080")
    SHARED.ready.clear()
    _bootstrap(environment.host)
    if isinstance(runner, MasterRunner):
        runner.send_message("processpoll_session", SHARED.as_dict())


@events.test_stop.add_listener
def _on_test_stop(environment, **_kw) -> None:
    if isinstance(environment.runner, WorkerRunner) or not SHARED.ready.is_set():
        return
    if SHARED.created_here and SHARED.admin_key and CLOSE_AT_END:
        try:
            _http(environment.host, "PATCH", f"/sessions/{SHARED.code}", json={"status": "closed"}, headers=_admin_headers())
            log.info("session %s closed", SHARED.code)
        except Exception as exc:
            log.warning("could not close session: %s", exc)


HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}


@events.quitting.add_listener
def _on_quitting(environment, **_kw) -> None:
    """Exit code: 0 ok, 1 too many failed requests or an interrupted stream, 2 submit p95 above the limit.

    Locust alone would exit with 1 after ANY failed request; this listener replaces that rule with
    LT_MAX_FAIL_RATIO, measured over the real HTTP rows only (the synthetic SSE/CACHE rows would dilute it)."""
    if isinstance(environment.runner, WorkerRunner):
        return
    stats = environment.stats
    http_requests = http_failures = interrupted = 0
    submit_failures = 0
    for (name, method), entry in stats.entries.items():
        if method in HTTP_METHODS:
            http_requests += entry.num_requests
            http_failures += entry.num_failures
            if name == NAME_SUBMIT:
                submit_failures += entry.num_failures
        elif name == "stream interrupted":
            interrupted += entry.num_requests
    ratio = http_failures / http_requests if http_requests else 0.0
    log.info("HTTP requests: %d, failed: %d (%.2f%%), failed submits: %d, interrupted streams: %d",
             http_requests, http_failures, ratio * 100, submit_failures, interrupted)
    code = 0
    if ratio > MAX_FAIL_RATIO:
        log.error("failure ratio %.2f%% above LT_MAX_FAIL_RATIO %.2f%%", ratio * 100, MAX_FAIL_RATIO * 100)
        code = 1
    if interrupted:
        log.error("%d SSE stream(s) were interrupted", interrupted)
        code = 1
    if SUBMIT_P95_MS:
        entry = stats.entries.get((NAME_SUBMIT, "POST"))
        if entry and entry.num_requests and entry.get_response_time_percentile(0.95) > SUBMIT_P95_MS:
            log.error("submit p95 %.0f ms above LT_SUBMIT_P95_MS %.0f", entry.get_response_time_percentile(0.95), SUBMIT_P95_MS)
            code = 2
    if getattr(locust_log, "unhandled_greenlet_exception", False):
        code = max(code, 2)
    environment.process_exit_code = code


def _wait_ready(timeout: float = 90.0) -> None:
    if not SHARED.ready.wait(timeout):
        log.error("no session available after %.0f s", timeout)
        raise StopUser()


def _fire(environment, kind: str, name: str, ms: float, exception: Exception | None = None) -> None:
    """Record a custom measurement as a row in the Locust statistics."""
    environment.events.request.fire(
        request_type=kind, name=name, response_time=ms, response_length=0, exception=exception, context={},
    )


def _suggests(trace_question: dict[str, Any]) -> bool:
    """The editor only requests autocomplete in free mode with suggest_existing enabled."""
    cfg = trace_question.get("config") or {}
    return cfg.get("mode") == "free" and bool(cfg.get("suggest_existing"))


class ParticipantUser(HttpUser):
    """One participant: join, read, think, submit once, leave."""

    weight = 100
    wait_time = constant(0)

    def on_start(self) -> None:
        _wait_ready()
        self.rng = random.Random(f"{SEED}:{next(SHARED.counter)}:{random.random()}")

    @task
    def participate(self) -> None:
        code = SHARED.code
        base = f"{API}/sessions/{code}"
        gevent.sleep(self.rng.uniform(0, SUBMIT_WINDOW))

        resp = self.client.get(base, name="GET /sessions/[code]")
        if resp.status_code != 200:
            raise StopUser()
        questions = resp.json()["questions"]

        resp = self.client.post(f"{base}/join", json={}, name="POST /sessions/[code]/join")
        if resp.status_code != 200 and resp.status_code != 201:
            raise StopUser()
        token = resp.json()["participant_token"]

        think = self.rng.uniform(THINK_MIN, THINK_MAX)
        trace_q = synthetic.trace_question(questions)
        calls = SUGGEST_CALLS if trace_q and _suggests(trace_q) else 0
        for _ in range(calls):
            gevent.sleep(think / (calls + 1))
            prefix = self.rng.choice(synthetic.POOL).lower()[: self.rng.randint(1, 4)]
            self.client.get(
                f"{base}/labels/suggest", params={"question_id": trace_q["id"], "q": prefix},
                name="GET /sessions/[code]/labels/suggest",
            )
        gevent.sleep(think / (calls + 1))
        answers = synthetic.generate_answers(
            self.rng, questions, noise=NOISE, role_weights={"Student": STUDENT_SHARE, "Lecturer": 1.0 - STUDENT_SHARE},
        )
        with self.client.post(
            f"{base}/responses",
            json={"answers": answers},
            headers={"X-Participant-Token": token, "Idempotency-Key": synthetic.new_idempotency_key()},
            name=NAME_SUBMIT,
            catch_response=True,
        ) as r:
            if r.status_code in (200, 201):
                r.success()
                if SHARED.single_process:
                    bisect.insort(SHARED.submit_times, time.time())
            else:
                r.failure(f"HTTP {r.status_code}: {r.text[:120]}")
        raise StopUser()


class StreamUser(HttpUser):
    """Base class: keeps an SSE connection and reacts to `tick` events."""

    abstract = True
    wait_time = constant(1)
    use_key = True
    min_fetch_interval = 0.0
    compare_every = 0

    def on_start(self) -> None:
        _wait_ready()
        self.rng = random.Random(f"{SEED}:{type(self).__name__}:{next(SHARED.counter)}")
        self.etag: str | None = None
        self.last_version = -1
        self.last_fetch = 0.0
        self.versions_seen = 0
        gevent.sleep(self.rng.uniform(0, 2))

    def _headers(self) -> dict[str, str]:
        return _display_headers() if self.use_key else {}

    @task
    def stream(self) -> None:
        url = f"{API}/sessions/{SHARED.code}/stream"
        headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache", **self._headers()}

        resp = self.client.get(url, headers=headers, stream=True, name="SSE connect", timeout=(10, 75))
        if resp.status_code != 200:
            resp.close()
            gevent.sleep(1 + self.rng.random() * 2)
            return
        opened = time.time()
        got_first = False
        try:
            for line in resp.iter_lines(decode_unicode=True):
                now = time.time()
                if line and line.startswith("data:"):
                    try:
                        payload = json.loads(line[5:].strip())
                    except ValueError:
                        continue
                    if not got_first:
                        got_first = True
                        _fire(self.environment, "SSE", "first tick after connect", (now - opened) * 1000)
                    self._on_tick(payload, now)
                if SSE_MAX_SECONDS and now - opened > SSE_MAX_SECONDS:
                    break
        except requests.exceptions.RequestException as exc:
            _fire(self.environment, "SSE", "stream interrupted", (time.time() - opened) * 1000, exc)
        finally:
            resp.close()


    def _on_tick(self, payload: dict[str, Any], received: float) -> None:
        version = int(payload.get("version", -1))
        if version == self.last_version:
            return
        self.last_version = version
        self.versions_seen += 1


        submitted = int(payload.get("submitted", 0)) - SHARED.baseline_submitted
        times = SHARED.submit_times
        if SHARED.single_process and 0 < submitted <= len(times):
            _fire(self.environment, "SSE", "submit -> tick (approx.)", max(0.0, (received - times[submitted - 1]) * 1000))

        self._fetch_analytics(received)
        if self.compare_every and SHARED.group_qid and self.versions_seen % self.compare_every == 0:
            self.client.get(
                f"{API}/sessions/{SHARED.code}/compare",
                params={"question_id": SHARED.trace_qid, "group_by": SHARED.group_qid},
                headers=self._headers(), name="GET /sessions/[code]/compare",
            )

    def _fetch_analytics(self, tick_received: float) -> None:
        if tick_received - self.last_fetch < self.min_fetch_interval:
            return
        self.last_fetch = tick_received
        headers = self._headers()
        if self.etag:
            headers["If-None-Match"] = self.etag
        resp = self.client.get(
            f"{API}/sessions/{SHARED.code}/analytics",
            params={"question_id": SHARED.trace_qid}, headers=headers, name="GET /sessions/[code]/analytics",
        )
        if resp.status_code == 304:
            _fire(self.environment, "CACHE", "analytics 304 (ETag hit)", 0)
        if resp.status_code in (200, 304):
            self.etag = resp.headers.get("ETag", self.etag)
            _fire(self.environment, "SSE", "tick -> analytics loaded", (time.time() - tick_received) * 1000)


class DashboardUser(StreamUser):
    """Host/beamer dashboard: display key, analytics on every new version."""

    abstract = DASHBOARDS <= 0
    fixed_count = max(DASHBOARDS, 0)
    use_key = True
    min_fetch_interval = 0.0
    compare_every = COMPARE_EVERY


class ListenerUser(StreamUser):
    """Participant watching public results: no key by default, throttled fetches."""

    abstract = LISTENERS <= 0
    fixed_count = max(LISTENERS, 0)
    use_key = LISTENER_USE_KEY
    min_fetch_interval = LISTENER_MIN_FETCH
    compare_every = 0

    def on_start(self) -> None:
        super().on_start()
        self.min_fetch_interval = LISTENER_MIN_FETCH * (0.8 + 0.4 * self.rng.random())


class HostUser(HttpUser):
    """The session owner: polls the admin view and the moderation list."""

    fixed_count = 1
    wait_time = constant(HOST_POLL_SECONDS)

    def on_start(self) -> None:
        _wait_ready()
        if not SHARED.admin_key:
            log.warning("no admin key available: HostUser idles")

    @task(10)
    def admin_view(self) -> None:
        if not SHARED.admin_key:
            raise StopUser()
        self.client.get(f"{API}/sessions/{SHARED.code}/admin", headers=_admin_headers(), name="GET /sessions/[code]/admin")

    @task(1)
    def labels(self) -> None:
        if SHARED.admin_key and SHARED.trace_qid:
            self.client.get(
                f"{API}/sessions/{SHARED.code}/labels", params={"question_id": SHARED.trace_qid},
                headers=_admin_headers(), name="GET /sessions/[code]/labels",
            )
