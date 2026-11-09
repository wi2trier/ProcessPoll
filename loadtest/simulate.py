#!/usr/bin/env python3
"""Fill a ProcessPoll demo session with synthetic participants.

Creates a "morning routine" session (trace question + role + experience), opens
it and submits N participants with realistic label variance (typos, casing,
synonyms such as "check mail" / "read emails") and group-dependent behaviour
(students vs. lecturers differ e.g. in breakfast/coffee/e-mail habits).

Examples::

    # 150 participants against a local dev setup (frontend dev server proxying /api)
    python simulate.py --base-url http://localhost:8080 --n 150 --seed 42

    # select & sort mode, results visible for participants, spread over 20 s
    python simulate.py --n 80 --mode select_sort --results-public --spread 20

    # add more participants to an existing session
    python simulate.py --n 50 --session-code MORN-24 --admin-key <key>

Prints the join code and the host/display links. Only needs ``httpx``.
Deterministic for a given ``--seed`` (labels and attributes, not timing).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import sys
import time
from typing import Any

import httpx

import synthetic


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:8080", help="origin serving /api (proxy or backend), default %(default)s")
    p.add_argument("--n", type=int, default=100, help="number of synthetic participants (default %(default)s)")
    p.add_argument("--seed", type=int, default=42, help="random seed (default %(default)s)")
    p.add_argument("--mode", choices=["free", "select_sort"], default="free", help="trace question mode (default %(default)s)")
    p.add_argument("--noise", type=float, default=0.25, help="label noise 0..1 in free mode (default %(default)s)")
    p.add_argument("--student-share", type=float, default=0.7, help="share of students vs lecturers (default %(default)s)")
    p.add_argument("--title", default="Morning routine (demo)")
    p.add_argument("--results-public", action="store_true", help="let participants see results")
    p.add_argument("--allow-resubmit", action="store_true")
    p.add_argument("--k-min", type=int, default=5)
    p.add_argument("--concurrency", type=int, default=25, help="parallel requests (default %(default)s)")
    p.add_argument("--spread", type=float, default=0.0, help="spread submissions randomly over this many seconds (default 0 = as fast as possible)")
    p.add_argument("--session-code", help="reuse an existing session instead of creating one")
    p.add_argument("--admin-key", help="admin key of the existing session (needed with --session-code unless --no-open)")
    p.add_argument("--no-open", action="store_true", help="do not open the session (leave it in draft)")
    p.add_argument("--close", action="store_true", help="close the session after the run")
    p.add_argument("--json", action="store_true", help="print a machine-readable summary as the last line")
    p.add_argument("--timeout", type=float, default=15.0, help="HTTP timeout in seconds")
    return p.parse_args(argv)


class Api:
    def __init__(self, base_url: str, timeout: float, limit: int) -> None:
        self.base = base_url.rstrip("/")
        self.client = httpx.AsyncClient(
            base_url=f"{self.base}/api/v1",
            timeout=timeout,
            limits=httpx.Limits(max_connections=limit, max_keepalive_connections=limit),
        )

    async def close(self) -> None:
        await self.client.aclose()

    @staticmethod
    def _check(resp: httpx.Response, what: str) -> dict[str, Any]:
        if resp.status_code >= 400:
            raise SystemExit(f"{what} failed: HTTP {resp.status_code} {resp.text[:300]}")
        return resp.json()

    async def create_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._check(await self.client.post("/sessions", json=payload), "create session")

    async def set_status(self, code: str, admin_key: str, status: str) -> dict[str, Any]:
        resp = await self.client.patch(f"/sessions/{code}", json={"status": status}, headers={"X-Admin-Key": admin_key})
        return self._check(resp, f"set status {status}")

    async def get_session(self, code: str) -> dict[str, Any]:
        return self._check(await self.client.get(f"/sessions/{code}"), "fetch session")


async def submit_participant(api: Api, code: str, questions: list[dict[str, Any]], rng: random.Random, args: argparse.Namespace,
                             delay: float, sem: asyncio.Semaphore) -> dict[str, Any]:
    """join -> submit with idempotency key; retries 429/5xx/network errors with the SAME key."""
    await asyncio.sleep(delay)
    role_weights = {"Student": args.student_share, "Lecturer": 1.0 - args.student_share}
    answers = synthetic.generate_answers(rng, questions, noise=args.noise, role_weights=role_weights)
    key = synthetic.new_idempotency_key()
    result: dict[str, Any] = {"ok": False, "status": None, "latency": None, "attempts": 0}
    async with sem:
        t0 = time.perf_counter()
        token = None
        for attempt in range(1, 7):
            result["attempts"] = attempt
            try:
                if token is None:
                    jr = await api.client.post(f"/sessions/{code}/join", json={})
                    if jr.status_code == 429 or jr.status_code >= 500:
                        raise httpx.HTTPError(f"join {jr.status_code}")
                    jr.raise_for_status()
                    token = jr.json()["participant_token"]
                resp = await api.client.post(
                    f"/sessions/{code}/responses",
                    json={"answers": answers},
                    headers={"X-Participant-Token": token, "Idempotency-Key": key},
                )
                result["status"] = resp.status_code
                if resp.status_code in (200, 201):
                    result["ok"] = True
                    break
                if resp.status_code == 429 or resp.status_code >= 500:
                    await asyncio.sleep(min(5.0, 0.3 * 2 ** attempt) * (0.5 + random.random()))
                    continue
                result["error"] = resp.text[:200]
                break
            except httpx.HTTPError as exc:
                result["error"] = str(exc)
                await asyncio.sleep(min(5.0, 0.3 * 2 ** attempt))
        result["latency"] = time.perf_counter() - t0
    return result


async def main_async(args: argparse.Namespace) -> int:
    api = Api(args.base_url, args.timeout, args.concurrency)
    try:
        created = args.session_code is None
        if created:
            payload = synthetic.session_payload(
                title=args.title, mode=args.mode, results_public=args.results_public,
                allow_resubmit=args.allow_resubmit, k_min=args.k_min,
            )
            data = await api.create_session(payload)
            code, admin_key, display_key = data["code"], data["admin_key"], data["display_key"]
        else:
            code = args.session_code.upper()
            admin_key = args.admin_key or ""
            display_key = None
        if not args.no_open and admin_key:
            session = await api.set_status(code, admin_key, "open")
            display_key = display_key or session.get("display_key")
        elif not args.no_open and not admin_key:
            print("note: no --admin-key given, assuming the session is already open", file=sys.stderr)

        public = await api.get_session(code)
        questions = public["questions"]
        if public["status"] != "open" and not args.no_open:
            print(f"warning: session status is '{public['status']}', submissions will be rejected", file=sys.stderr)

        base = args.base_url.rstrip("/")
        print("=" * 72)
        print(f"Join code    : {code}")
        print(f"Join link    : {base}/j/{code}")
        if admin_key:
            print(f"Host link    : {base}/host/{code}?key={admin_key}")
            print(f"Admin key    : {admin_key}")
        if display_key:
            print(f"Display link : {base}/display/{code}?key={display_key}")
            print(f"Display key  : {display_key}")
        print("=" * 72)
        print(f"Submitting {args.n} synthetic participants (mode={args.mode}, noise={args.noise}, seed={args.seed}) ...")

        sem = asyncio.Semaphore(args.concurrency)
        t_start = time.perf_counter()
        tasks = []
        for i in range(args.n):
            rng = random.Random(f"{args.seed}:{i}")
            delay = random.Random(f"{args.seed}:delay:{i}").uniform(0, args.spread) if args.spread > 0 else 0.0
            tasks.append(submit_participant(api, code, questions, rng, args, delay, sem))
        results = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - t_start

        ok = [r for r in results if r["ok"]]
        failed = [r for r in results if not r["ok"]]
        lat = sorted(r["latency"] for r in ok)

        def pct(q: float) -> float:
            return lat[min(len(lat) - 1, int(q * len(lat)))] * 1000 if lat else float("nan")

        print(f"done in {elapsed:.1f} s: {len(ok)} ok, {len(failed)} failed "
              f"({sum(r['attempts'] > 1 for r in results)} needed a retry)")
        if lat:
            print(f"join+submit latency ms: p50={pct(0.50):.0f} p95={pct(0.95):.0f} p99={pct(0.99):.0f} "
                  f"mean={statistics.fmean(lat) * 1000:.0f}")
        for r in failed[:5]:
            print(f"  failure: status={r['status']} {r.get('error', '')}", file=sys.stderr)

        if args.close and admin_key:
            await api.set_status(code, admin_key, "closed")
            print("session closed")

        if args.json:
            print(json.dumps({"code": code, "admin_key": admin_key, "display_key": display_key,
                              "ok": len(ok), "failed": len(failed), "elapsed_s": round(elapsed, 2)}))
        return 0 if not failed else 1
    finally:
        await api.close()


def main() -> int:
    args = parse_args()
    if args.n < 1:
        print("--n must be >= 1", file=sys.stderr)
        return 2
    if not 0.0 <= args.student_share <= 1.0:
        print("--student-share must be between 0 and 1", file=sys.stderr)
        return 2
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
