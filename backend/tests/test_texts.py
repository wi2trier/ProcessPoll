"""Session description and question label (presentation name vs. participant question)."""

from __future__ import annotations

import csv
import io

from conftest import create_host

API = "/api/v1"


def _body(**extra):
    body = {
        "title": "Poll",
        "questions": [
            {
                "type": "trace",
                "prompt": "Describe your morning routine.",
                "label": "Morning routine",
            },
            {
                "type": "single_choice",
                "prompt": "What is your current role?",
                "label": "Role",
                "required": False,
                "config": {"options": ["Student", "Lecturer"]},
            },
        ],
    }
    body.update(extra)
    return body


async def test_description_and_labels_roundtrip_and_defaults(client):
    r = await client.post(
        f"{API}/sessions", json=_body(description="  A short intro\n\nfor everybody.  ")
    )
    assert r.status_code == 201, r.text
    s = r.json()["session"]
    assert s["description"] == "A short intro\n\nfor everybody."
    assert [q["label"] for q in s["questions"]] == ["Morning routine", "Role"]
    pub = (await client.get(f"{API}/sessions/{s['code']}")).json()
    assert pub["description"] == s["description"]
    assert pub["questions"][1]["prompt"] == "What is your current role?"
    assert pub["questions"][1]["label"] == "Role"

    plain = await client.post(
        f"{API}/sessions",
        json={"title": "x", "questions": [{"type": "trace", "prompt": "t", "config": {}}]},
    )
    assert plain.json()["session"]["description"] is None
    assert plain.json()["session"]["questions"][0]["label"] is None


async def test_blank_description_and_label_are_stored_as_null(client):
    body = _body(description="   ")
    body["questions"][1]["label"] = "  \u200b "
    s = (await client.post(f"{API}/sessions", json=body)).json()["session"]
    assert s["description"] is None
    assert s["questions"][1]["label"] is None


async def test_length_limits(client):
    assert (
        await client.post(f"{API}/sessions", json=_body(description="x" * 1001))
    ).status_code == 422
    body = _body()
    body["questions"][1]["label"] = "x" * 81
    assert (await client.post(f"{API}/sessions", json=body)).status_code == 422
    ok = _body(description="x" * 1000)
    ok["questions"][1]["label"] = "y" * 80
    assert (await client.post(f"{API}/sessions", json=ok)).status_code == 201


async def test_patch_description_and_label_bump_version_and_clear(client):
    host = await create_host(client, questions=_body()["questions"])
    url = f"{API}/sessions/{host.code}"
    v0 = (await client.get(f"{url}/admin", headers=host.headers)).json()["version"]
    r = await client.patch(url, json={"description": "Welcome!"}, headers=host.headers)
    assert r.json()["description"] == "Welcome!" and r.json()["version"] == v0 + 1

    r = await client.patch(url, json={"description": "Welcome!"}, headers=host.headers)
    assert r.json()["version"] == v0 + 1

    r = await client.patch(url, json={"title": "Morning poll"}, headers=host.headers)
    assert r.json()["description"] == "Welcome!"

    assert (await client.get(url)).json()["description"] == "Welcome!"

    r = await client.patch(url, json={"description": None}, headers=host.headers)
    assert r.json()["description"] is None and r.json()["version"] == v0 + 2
    assert (await client.get(url)).json()["description"] is None

    role = host.q["What is your current role?"]
    r = await client.patch(
        f"{url}/questions/{role['id']}", json={"label": "Position"}, headers=host.headers
    )
    assert r.status_code == 200
    assert next(q for q in r.json()["questions"] if q["id"] == role["id"])["label"] == "Position"
    assert r.json()["version"] == v0 + 3
    assert (await client.get(url)).json()["questions"][1]["label"] == "Position"

    r = await client.patch(
        f"{url}/questions/{role['id']}", json={"help": "pick one"}, headers=host.headers
    )
    assert r.json()["version"] == v0 + 3
    r = await client.patch(
        f"{url}/questions/{role['id']}", json={"label": ""}, headers=host.headers
    )
    assert next(q for q in r.json()["questions"] if q["id"] == role["id"])["label"] is None


async def test_patching_texts_needs_the_admin_key(client):
    host = await create_host(client, questions=_body()["questions"])
    url = f"{API}/sessions/{host.code}"
    qid = host.session["questions"][0]["id"]
    assert (await client.patch(url, json={"description": "x"})).status_code == 401
    assert (await client.patch(f"{url}/questions/{qid}", json={"label": "x"})).status_code == 401


async def test_compare_group_by_carries_label_and_prompt(client):
    host = await create_host(client, questions=_body()["questions"], settings={"k_min": 1})
    role_id = host.q["What is your current role?"]["id"]
    for role in ("Student", "Lecturer"):
        token = await host.participant()
        await client.post(
            f"{API}/sessions/{host.code}/responses",
            json={
                "answers": [
                    {"question_id": host.trace_id, "value": {"steps": ["a", "b"]}},
                    {"question_id": role_id, "value": {"value": role}},
                ]
            },
            headers={"X-Participant-Token": token},
        )
    r = await client.get(
        f"{API}/sessions/{host.code}/compare",
        params={"question_id": host.trace_id, "group_by": role_id},
        headers=host.headers,
    )
    assert r.json()["group_by"] == {
        "question_id": role_id,
        "prompt": "What is your current role?",
        "label": "Role",
    }


async def test_exports_use_the_label_as_column_name_and_include_the_texts(client):
    host = await create_host(client, questions=_body()["questions"])
    role_id = host.q["What is your current role?"]["id"]
    token = await host.participant()
    await client.post(
        f"{API}/sessions/{host.code}/responses",
        json={
            "answers": [
                {"question_id": host.trace_id, "value": {"steps": ["a", "b"]}},
                {"question_id": role_id, "value": {"value": "Student"}},
            ]
        },
        headers={"X-Participant-Token": token},
    )
    csv_bytes = (
        await client.get(
            f"{API}/sessions/{host.code}/export", params={"format": "csv"}, headers=host.headers
        )
    ).content
    rows = list(csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig"))))
    assert rows[0]["Role"] == "Student" and "What is your current role?" not in rows[0]
    xes = (
        await client.get(
            f"{API}/sessions/{host.code}/export", params={"format": "xes"}, headers=host.headers
        )
    ).text
    assert 'key="Role" value="Student"' in xes
    dump = (
        await client.get(
            f"{API}/sessions/{host.code}/export", params={"format": "json"}, headers=host.headers
        )
    ).json()
    assert dump["session"]["description"] is None
    assert [q["label"] for q in dump["questions"]] == ["Morning routine", "Role"]
    assert dump["questions"][1]["prompt"] == "What is your current role?"

    plain = await create_host(client)
    assert plain.session["questions"][1]["label"] is None
    token = await plain.participant()
    await client.post(
        f"{API}/sessions/{plain.code}/responses",
        json={
            "answers": [
                {"question_id": plain.trace_id, "value": {"steps": ["a", "b"]}},
                {"question_id": plain.q["Role"]["id"], "value": {"value": "Student"}},
            ]
        },
        headers={"X-Participant-Token": token},
    )
    rows = list(
        csv.DictReader(
            io.StringIO(
                (
                    await client.get(
                        f"{API}/sessions/{plain.code}/export",
                        params={"format": "csv"},
                        headers=plain.headers,
                    )
                ).content.decode("utf-8-sig")
            )
        )
    )
    assert rows[0]["Role"] == "Student"
