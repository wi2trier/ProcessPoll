from __future__ import annotations

import asyncio

from conftest import MORNING_QUESTIONS, create_host

API = "/api/v1"


async def test_healthz_and_meta(client):
    r = await client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok", "db": True}
    assert (await client.get(f"{API}/meta")).json()["version"]


async def test_create_session_returns_keys_and_defaults(client):
    host = await create_host(client, open_session=False)
    s = host.session
    assert s["status"] == "draft" and s["joined"] == 0 and s["submitted"] == 0
    assert len(host.code) == 7 and host.code[4] == "-"
    assert len(host.admin_key) >= 40 and host.admin_key != host.display_key
    assert s["settings"] == {
        "results_public": False,
        "allow_resubmit": False,
        "retention_days": 90,
        "k_min": 5,
    }
    trace = s["questions"][0]
    assert trace["config"]["allow_repeats"] is True and trace["config"]["max_label_length"] == 80
    assert [q["position"] for q in s["questions"]] == [0, 1, 2]
    assert s["expires_at"] is not None

    pub = (await client.get(f"{API}/sessions/{host.code.lower()}")).json()
    assert set(pub) == {"code", "title", "description", "status", "questions", "settings"}
    assert set(pub["settings"]) == {"results_public", "allow_resubmit"}


async def test_timestamps_are_utc_with_z(client):
    import re

    host = await create_host(client)
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    pattern = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
    for field in ("created_at", "opened_at", "expires_at"):
        assert pattern.match(admin[field]), (field, admin[field])
    assert admin["closed_at"] is None
    assert pattern.match(host.session["created_at"])
    closed = (await host.set_status("closed")).json()
    assert pattern.match(closed["closed_at"])


async def test_unknown_session_is_404(client):
    r = await client.get(f"{API}/sessions/ZZZZ-99")
    assert r.status_code == 404 and r.json()["detail"] == "not_found"


async def test_create_validation_errors(client):
    bad = [
        {"title": "x", "questions": []},
        {"title": "x", "questions": [{"type": "text", "prompt": "only text", "config": {}}]},
        {
            "title": "x",
            "questions": [
                {
                    "type": "trace",
                    "prompt": "t",
                    "config": {"mode": "select_sort", "activities": ["a"]},
                }
            ],
        },
        {
            "title": "x",
            "questions": [
                {"type": "trace", "prompt": "t", "config": {"min_steps": 5, "max_steps": 2}}
            ],
        },
        {
            "title": "x",
            "questions": [
                {"type": "trace", "prompt": "t"},
                {"type": "single_choice", "prompt": "c", "config": {"options": ["a"]}},
            ],
        },
    ]
    for body in bad:
        r = await client.post(f"{API}/sessions", json=body)
        assert r.status_code == 422, body
        assert r.json()["detail"] == "validation_error"


async def test_admin_endpoints_need_the_key(client):
    host = await create_host(client)
    assert (await client.get(f"{API}/sessions/{host.code}/admin")).status_code == 401
    r = await client.get(f"{API}/sessions/{host.code}/admin", headers={"X-Admin-Key": "nope"})
    assert r.status_code == 401 and r.json()["detail"] == "invalid_key"
    ok = await client.get(f"{API}/sessions/{host.code}/admin", params={"key": host.admin_key})
    assert ok.status_code == 200 and ok.json()["display_key"] == host.display_key

    r = await client.get(f"{API}/sessions/{host.code}/admin", params={"key": host.display_key})
    assert r.status_code == 401
    r = await client.patch(
        f"{API}/sessions/{host.code}",
        json={"status": "closed"},
        headers={"X-Display-Key": host.display_key},
    )
    assert r.status_code == 401


async def test_status_transitions(client):
    host = await create_host(client, open_session=False)
    assert (await host.set_status("paused")).status_code == 409
    assert (await host.set_status("closed")).status_code == 409
    assert (await host.set_status("open")).json()["opened_at"] is not None
    assert (await host.set_status("paused")).json()["status"] == "paused"
    assert (await host.set_status("open")).json()["status"] == "open"
    closed = (await host.set_status("closed")).json()
    assert closed["closed_at"] is not None and closed["expires_at"] > closed["closed_at"]
    r = await host.set_status("open")
    assert r.status_code == 409 and r.json()["detail"] == "invalid_transition"


async def test_questions_locked_after_open_but_text_editable(client):
    host = await create_host(client, open_session=False)
    r = await client.put(
        f"{API}/sessions/{host.code}/questions",
        json={"questions": [{"type": "trace", "prompt": "New prompt", "config": {}}]},
        headers=host.headers,
    )
    assert r.status_code == 200 and len(r.json()["questions"]) == 1
    await host.set_status("open")
    r = await client.put(
        f"{API}/sessions/{host.code}/questions",
        json={"questions": [{"type": "trace", "prompt": "Other", "config": {}}]},
        headers=host.headers,
    )
    assert r.status_code == 409 and r.json()["detail"] == "questions_locked"
    qid = (await client.get(f"{API}/sessions/{host.code}")).json()["questions"][0]["id"]
    r = await client.patch(
        f"{API}/sessions/{host.code}/questions/{qid}",
        json={"prompt": "Reworded", "help": "Some hint"},
        headers=host.headers,
    )
    q = r.json()["questions"][0]
    assert q["prompt"] == "Reworded" and q["help"] == "Some hint"


async def test_settings_patch_recomputes_expiry(client):
    host = await create_host(client, open_session=False)
    r = await client.patch(
        f"{API}/sessions/{host.code}",
        json={"settings": {"retention_days": 7, "results_public": True}},
        headers=host.headers,
    )
    body = r.json()
    assert body["settings"]["retention_days"] == 7 and body["settings"]["results_public"] is True
    assert body["settings"]["k_min"] == 5
    r = await client.patch(
        f"{API}/sessions/{host.code}", json={"settings": {"k_min": 0}}, headers=host.headers
    )
    assert r.status_code == 422


async def test_join_counts_and_is_idempotent_with_token(client):
    host = await create_host(client)
    r1 = await client.post(f"{API}/sessions/{host.code}/join", json={})
    token = r1.json()["participant_token"]
    assert r1.json()["has_submitted"] is False
    r2 = await client.post(f"{API}/sessions/{host.code}/join", json={"token": token})
    assert r2.json()["participant_token"] == token
    r3 = await client.post(f"{API}/sessions/{host.code}/join", json={"token": "garbage"})
    assert r3.json()["participant_token"] != token
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["joined"] == 2

    assert (await client.post(f"{API}/sessions/{host.code}/join")).status_code == 200


async def test_submit_flow_and_counters(client):
    host = await create_host(client)
    r = await host.submit(["Wake up", "Shower", "Coffee"], role="Student", key="k1")
    assert r.status_code == 201 and r.json()["response_id"]
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["submitted"] == 1 and admin["joined"] == 1 and admin["version"] >= 1


async def test_submit_requires_open_session_and_token(client):
    host = await create_host(client, open_session=False)
    token = await host.participant()
    r = await host.submit(["a", "b"], token=token)
    assert r.status_code == 403 and r.json()["detail"] == "session_not_open"
    await host.set_status("open")
    assert (await host.submit(["a", "b"], token=token)).status_code == 201
    r = await client.post(f"{API}/sessions/{host.code}/responses", json={"answers": []})
    assert r.status_code == 401 and r.json()["detail"] == "invalid_token"
    r = await client.post(
        f"{API}/sessions/{host.code}/responses",
        json={"answers": []},
        headers={"X-Participant-Token": "bogus"},
    )
    assert r.status_code == 401
    await host.set_status("paused")
    assert (await host.submit(["a", "b"])).status_code == 403
    await host.set_status("closed")
    r = await client.post(f"{API}/sessions/{host.code}/join", json={})
    assert r.status_code == 403 and r.json()["detail"] == "session_not_open"

    r = await client.post(f"{API}/sessions/{host.code}/join", json={"token": token})
    assert r.status_code == 200 and r.json()["has_submitted"] is True


async def test_double_submission_and_idempotency(client):
    host = await create_host(client)
    token = await host.participant()
    first = await host.submit(["a", "b"], token=token, key="same")
    assert first.status_code == 201
    replay = await host.submit(["a", "b"], token=token, key="same")
    assert replay.status_code == 200 and replay.json() == first.json()
    other_key = await host.submit(["x", "y"], token=token, key="different")
    assert other_key.status_code == 409 and other_key.json()["detail"] == "already_submitted"

    r = await host.submit(["a", "b"], key="same")
    assert r.status_code == 409 and r.json()["detail"] == "idempotency_conflict"
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["submitted"] == 1


async def test_resubmit_replaces_when_allowed(client):
    host = await create_host(client, settings={"allow_resubmit": True})
    token = await host.participant()
    assert (await host.submit(["a", "b"], token=token)).status_code == 201
    assert (await host.submit(["c", "d", "e"], token=token)).status_code == 201
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["submitted"] == 1
    a = (
        await client.get(
            f"{API}/sessions/{host.code}/analytics",
            params={"question_id": host.trace_id},
            headers=host.headers,
        )
    ).json()
    assert a["n"] == 1 and a["variants"][0]["steps"] == ["c", "d", "e"]


async def test_concurrent_double_submit_creates_one_response(client):
    host = await create_host(client)
    token = await host.participant()
    results = await asyncio.gather(
        *[host.submit([f"s{i}", "end"], token=token, key=f"k{i}") for i in range(5)]
    )
    codes = sorted(r.status_code for r in results)
    assert codes.count(201) == 1 and codes.count(409) == 4
    admin = (await client.get(f"{API}/sessions/{host.code}/admin", headers=host.headers)).json()
    assert admin["submitted"] == 1


async def test_answer_validation(client):
    qs = [
        {
            "type": "trace",
            "prompt": "Trace",
            "config": {
                "min_steps": 2,
                "max_steps": 4,
                "allow_repeats": False,
                "max_label_length": 10,
            },
        },
        {"type": "single_choice", "prompt": "Role", "config": {"options": ["Student", "Lecturer"]}},
        {
            "type": "multiple_choice",
            "prompt": "Tools",
            "required": False,
            "config": {"options": ["A", "B", "C"], "max_selected": 2},
        },
        {
            "type": "number",
            "prompt": "Years",
            "required": False,
            "config": {"min": 0, "max": 50, "integer": True, "bins": [5, 10]},
        },
        {"type": "text", "prompt": "Comment", "required": False, "config": {"max_length": 20}},
    ]
    host = await create_host(client, questions=qs)
    ids = {q["prompt"]: q["id"] for q in host.session["questions"]}

    async def go(answers):
        token = await host.participant()
        return await client.post(
            f"{API}/sessions/{host.code}/responses",
            json={"answers": answers},
            headers={"X-Participant-Token": token},
        )

    def a(name, value):
        return {"question_id": ids[name], "value": value}

    good = [a("Trace", {"steps": ["Wake up", "Coffee"]}), a("Role", {"value": "student"})]
    assert (await go(good)).status_code == 201

    cases = {
        "missing required trace": [a("Role", {"value": "Student"})],
        "too few steps": [a("Trace", {"steps": ["only"]}), a("Role", {"value": "Student"})],
        "too many steps": [
            a("Trace", {"steps": ["a", "b", "c", "d", "e"]}),
            a("Role", {"value": "Student"}),
        ],
        "repeat not allowed": [
            a("Trace", {"steps": ["Coffee", "coffee!"]}),
            a("Role", {"value": "Student"}),
        ],
        "label too long": [
            a("Trace", {"steps": ["x" * 11, "y"]}),
            a("Role", {"value": "Student"}),
        ],
        "empty label": [a("Trace", {"steps": ["a", "  "]}), a("Role", {"value": "Student"})],
        "bad option": [a("Trace", {"steps": ["a", "b"]}), a("Role", {"value": "Dean"})],
        "too many selected": [
            a("Trace", {"steps": ["a", "b"]}),
            a("Role", {"value": "Student"}),
            a("Tools", {"values": ["A", "B", "C"]}),
        ],
        "float for integer": [
            a("Trace", {"steps": ["a", "b"]}),
            a("Role", {"value": "Student"}),
            a("Years", {"value": 2.5}),
        ],
        "number out of range": [
            a("Trace", {"steps": ["a", "b"]}),
            a("Role", {"value": "Student"}),
            a("Years", {"value": 99}),
        ],
        "bool is not a number": [
            a("Trace", {"steps": ["a", "b"]}),
            a("Role", {"value": "Student"}),
            a("Years", {"value": True}),
        ],
        "text too long": [
            a("Trace", {"steps": ["a", "b"]}),
            a("Role", {"value": "Student"}),
            a("Comment", {"value": "x" * 21}),
        ],
        "unknown question": [
            a("Trace", {"steps": ["a", "b"]}),
            a("Role", {"value": "Student"}),
            {"question_id": "nope", "value": {"value": "x"}},
        ],
        "steps not strings": [a("Trace", {"steps": [1, 2]}), a("Role", {"value": "Student"})],
    }
    for name, answers in cases.items():
        r = await go(answers)
        assert r.status_code == 422, name
        body = r.json()
        assert body["detail"] == "validation_error" and body["errors"], name
    r = await go(cases["too few steps"])
    assert r.json()["errors"][0]["question_id"] == ids["Trace"]

    ok = [a("Trace", {"steps": ["a", "b"]}), a("Role", {"value": "Student"}), a("Years", None)]
    assert (await go(ok)).status_code == 201


async def test_select_sort_validation(client):
    qs = [
        {
            "type": "trace",
            "prompt": "Sort",
            "config": {
                "mode": "select_sort",
                "activities": ["Wake up", "Shower", "Coffee"],
                "allow_repeats": False,
                "allow_skip": False,
                "min_steps": 1,
            },
        }
    ]
    host = await create_host(client, questions=qs)
    token = await host.participant()
    tid = host.trace_id

    async def go(steps):
        return await client.post(
            f"{API}/sessions/{host.code}/responses",
            json={"answers": [{"question_id": tid, "value": {"steps": steps}}]},
            headers={"X-Participant-Token": token},
        )

    assert (await go(["Wake up", "Shower"])).status_code == 422
    assert (await go(["Wake up", "Shower", "Coffee", "Tea"])).status_code == 422
    assert (await go(["Wake up", "Shower", "Shower", "Coffee"])).status_code == 422
    assert (await go(["coffee", "WAKE UP", "shower"])).status_code == 201
    a = (
        await client.get(
            f"{API}/sessions/{host.code}/analytics",
            params={"question_id": tid},
            headers=host.headers,
        )
    ).json()
    assert a["variants"][0]["steps"] == ["Coffee", "Wake up", "Shower"]


async def test_payload_too_large(client):
    host = await create_host(client)
    r = await client.post(
        f"{API}/sessions/{host.code}/responses",
        content=b"x" * 70_000,
        headers={"Content-Type": "application/json", "X-Participant-Token": "t"},
    )
    assert r.status_code == 413


async def test_delete_session_removes_everything(client):
    host = await create_host(client)
    await host.submit(["a", "b"])
    assert (await client.delete(f"{API}/sessions/{host.code}", headers={})).status_code == 401
    assert (
        await client.delete(f"{API}/sessions/{host.code}", headers=host.headers)
    ).status_code == 204
    assert (await client.get(f"{API}/sessions/{host.code}")).status_code == 404


async def test_create_session_rate_limit(app, client):
    app.state.settings.session_create_per_hour = 2
    body = {"title": "x", "questions": MORNING_QUESTIONS}
    assert (await client.post(f"{API}/sessions", json=body)).status_code == 201
    assert (await client.post(f"{API}/sessions", json=body)).status_code == 201
    r = await client.post(f"{API}/sessions", json=body)
    assert r.status_code == 429 and r.json()["detail"] == "rate_limited"


async def test_retention_sweep_deletes_expired_sessions(app, client):
    from datetime import timedelta

    from sqlalchemy import update

    from app.main import sweep_expired
    from app.models import SessionRow, utcnow

    old = await create_host(client)
    keep = await create_host(client)
    async with app.state.db.sessionmaker() as s:
        await s.execute(
            update(SessionRow)
            .where(SessionRow.code == old.code)
            .values(expires_at=utcnow() - timedelta(days=1))
        )
        await s.commit()
    assert await sweep_expired(app.state.db, app.state.hub) == 1
    assert (await client.get(f"{API}/sessions/{old.code}")).status_code == 404
    assert (await client.get(f"{API}/sessions/{keep.code}")).status_code == 200
