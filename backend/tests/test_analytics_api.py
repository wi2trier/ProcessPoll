from __future__ import annotations

import csv
import io
import xml.etree.ElementTree as ET

from conftest import create_host

API = "/api/v1"

STUDENT = ["Wake up", "Shower", "Coffee", "Leave"]
LECTURER = ["Wake up", "Coffee", "Leave"]


async def fill(host, students=8, lecturers=8):
    for _ in range(students):
        assert (
            await host.submit(STUDENT, role="Student", experience="Beginner")
        ).status_code == 201
    for _ in range(lecturers):
        assert (
            await host.submit(LECTURER, role="Lecturer", experience="Expert")
        ).status_code == 201


async def analytics(client, host, **params):
    params = {"question_id": host.trace_id, **params}
    return await client.get(
        f"{API}/sessions/{host.code}/analytics", params=params, headers=host.headers
    )


async def test_analytics_basic_and_etag(client):
    host = await create_host(client)
    await fill(host, 3, 2)
    r = await analytics(client, host)
    assert r.status_code == 200
    a = r.json()
    assert a["n"] == 5 and a["kpis"]["n_variants"] == 2 and a["filter"] is None
    assert [v["count"] for v in a["variants"]] == [3, 2]
    assert a["version"] >= 5
    etag = r.headers["etag"]
    cached = await client.get(
        f"{API}/sessions/{host.code}/analytics",
        params={"question_id": host.trace_id},
        headers={**host.headers, "If-None-Match": etag},
    )
    assert cached.status_code == 304
    await host.submit(LECTURER, role="Lecturer")
    changed = await client.get(
        f"{API}/sessions/{host.code}/analytics",
        params={"question_id": host.trace_id},
        headers={**host.headers, "If-None-Match": etag},
    )
    assert changed.status_code == 200 and changed.json()["n"] == 6


async def test_analytics_empty_session(client):
    host = await create_host(client)
    a = (await analytics(client, host)).json()
    assert a["n"] == 0 and a["variants"] == [] and a["dfg"]["edges"] == []


async def test_analytics_filter(client):
    host = await create_host(client)
    await fill(host, 4, 2)
    r = await analytics(
        client, host, filter_question_id=host.q["Role"]["id"], filter_value="Student"
    )
    a = r.json()
    assert a["n"] == 4 and a["variants"][0]["steps"] == STUDENT
    assert a["filter"] == {"question_id": host.q["Role"]["id"], "value": "Student"}
    r = await analytics(client, host, filter_question_id=host.q["Role"]["id"])
    assert r.status_code == 422


async def test_analytics_errors(client):
    host = await create_host(client)
    r = await analytics(client, host, question_id=host.q["Role"]["id"])
    assert r.status_code == 422 and r.json()["detail"] == "not_a_trace_question"
    r = await analytics(client, host, question_id="missing")
    assert r.status_code == 404
    r = await client.get(f"{API}/sessions/{host.code}/analytics")
    assert r.status_code == 422


async def test_access_levels_for_analytics(client):
    host = await create_host(client)
    await fill(host, 1, 0)
    url = f"{API}/sessions/{host.code}/analytics"
    params = {"question_id": host.trace_id}
    assert (await client.get(url, params=params)).status_code == 401
    assert (await client.get(url, params={**params, "key": "wrong"})).status_code == 401
    assert (await client.get(url, params={**params, "key": host.display_key})).status_code == 200
    assert (
        await client.get(url, headers={"X-Display-Key": host.display_key}, params=params)
    ).status_code == 200

    await client.patch(
        f"{API}/sessions/{host.code}",
        json={"settings": {"results_public": True}},
        headers=host.headers,
    )
    assert (await client.get(url, params=params)).status_code == 200

    assert (await client.get(f"{API}/sessions/{host.code}/export")).status_code == 401
    assert (
        await client.get(
            f"{API}/sessions/{host.code}/labels", params={"question_id": host.trace_id}
        )
    ).status_code == 401


async def test_compare_groups(client):
    host = await create_host(client)
    await fill(host, 8, 8)
    await host.submit(["Wake up", "Leave"], role=None)
    r = await client.get(
        f"{API}/sessions/{host.code}/compare",
        params={"question_id": host.trace_id, "group_by": host.q["Role"]["id"]},
        headers=host.headers,
    )
    assert r.status_code == 200
    c = r.json()
    assert c["group_by"]["prompt"] == "Role"
    assert [g["value"] for g in c["groups"]] == ["Lecturer", "Student"]
    assert all(g["n"] == 8 and g["analytics"]["n"] == 8 for g in c["groups"])
    assert c["hidden_groups"] == [{"value": "(no answer)", "n": 1}]
    assert "small_groups" in c["warnings"]
    assert c["pairwise"][0]["js_edges"] > 0
    shower = next(e for e in c["diff_edges"] if (e["source"], e["target"]) == ("Wake up", "Shower"))
    assert shower["shares"] == {"Lecturer": 0.0, "Student": 1.0} and shower["delta"] == 1.0
    assert shower["p_value"] < 0.01


async def test_compare_uses_k_min_setting_and_rejects_bad_group_by(client):
    host = await create_host(client, settings={"k_min": 9})
    await fill(host, 8, 8)
    r = await client.get(
        f"{API}/sessions/{host.code}/compare",
        params={"question_id": host.trace_id, "group_by": host.q["Role"]["id"]},
        headers=host.headers,
    )
    c = r.json()
    assert c["groups"] == [] and len(c["hidden_groups"]) == 2
    r = await client.get(
        f"{API}/sessions/{host.code}/compare",
        params={"question_id": host.trace_id, "group_by": host.trace_id},
        headers=host.headers,
    )
    assert r.status_code == 422 and r.json()["detail"] == "group_by_unsupported"


async def test_compare_number_bins_and_multiple_choice(client):
    qs = [
        {"type": "trace", "prompt": "T", "config": {"min_steps": 1}},
        {
            "type": "number",
            "prompt": "Years",
            "required": False,
            "config": {"integer": True, "bins": [5, 10]},
        },
        {
            "type": "multiple_choice",
            "prompt": "Tools",
            "required": False,
            "config": {"options": ["A", "B"]},
        },
        {"type": "number", "prompt": "NoBins", "required": False, "config": {}},
    ]
    host = await create_host(client, questions=qs, settings={"k_min": 1})
    ids = {q["prompt"]: q["id"] for q in host.session["questions"]}

    async def submit(steps, years, tools):
        token = await host.participant()
        answers = [
            {"question_id": ids["T"], "value": {"steps": steps}},
            {"question_id": ids["Years"], "value": {"value": years}},
            {"question_id": ids["Tools"], "value": {"values": tools}},
            {"question_id": ids["NoBins"], "value": {"value": 1}},
        ]
        r = await client.post(
            f"{API}/sessions/{host.code}/responses",
            json={"answers": answers},
            headers={"X-Participant-Token": token},
        )
        assert r.status_code == 201, r.text

    await submit(["a"], 2, ["A"])
    await submit(["a"], 7, ["A", "B"])
    await submit(["b"], 12, ["B"])

    def compare(group_by):
        return client.get(
            f"{API}/sessions/{host.code}/compare",
            params={"question_id": ids["T"], "group_by": ids[group_by]},
            headers=host.headers,
        )

    c = (await compare("Years")).json()
    assert {g["value"] for g in c["groups"]} == {"< 5", "5–10", "≥ 10"}
    c = (await compare("Tools")).json()
    sizes = {g["value"]: g["n"] for g in c["groups"]}
    assert sizes == {"A": 2, "B": 2}
    r = await compare("NoBins")
    assert r.status_code == 422 and r.json()["detail"] == "bins_required"


async def test_label_moderation_changes_analytics_and_export(client):
    host = await create_host(client)
    for steps in (
        ["Check mail", "Coffee"],
        ["check email", "Coffee"],
        ["Check mails", "Coffee", "um"],
        ["Read emails", "Coffee"],
    ):
        assert (await host.submit(steps)).status_code == 201
    url = f"{API}/sessions/{host.code}/labels"
    labels = (
        await client.get(url, params={"question_id": host.trace_id}, headers=host.headers)
    ).json()
    rows = {r["raw_key"]: r for r in labels["labels"]}
    assert rows["coffee"]["count"] == 4 and rows["coffee"]["display"] == "Coffee"

    cluster = next(s for s in labels["suggestions"] if "check mail" in s["raw_keys"])
    assert set(cluster["raw_keys"]) == {"check mail", "check email", "check mails"}
    assert "read emails" not in cluster["raw_keys"]
    before = (await analytics(client, host)).json()
    assert before["kpis"]["n_variants"] == 4
    aliases = [
        {"raw_key": k, "canonical": "Check email", "hidden": False}
        for k in ("check mail", "check email", "check mails", "read emails")
    ] + [{"raw_key": "um", "canonical": None, "hidden": True}]
    r = await client.put(
        f"{API}/sessions/{host.code}/aliases",
        json={"question_id": host.trace_id, "aliases": aliases},
        headers=host.headers,
    )
    assert (
        r.status_code == 200 and r.json()["ok"] is True and r.json()["version"] > before["version"]
    )
    after = (await analytics(client, host)).json()
    assert after["n"] == 4 and after["kpis"]["n_variants"] == 1
    assert after["variants"][0]["steps"] == ["Check email", "Coffee"]

    labels = (
        await client.get(url, params={"question_id": host.trace_id}, headers=host.headers)
    ).json()
    row = next(r for r in labels["labels"] if r["raw_key"] == "um")
    assert row["hidden"] is True

    exp = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "csv"}, headers=host.headers
    )
    rows = list(csv.DictReader(io.StringIO(exp.content.decode("utf-8-sig"))))
    assert {r["activity"] for r in rows} == {"Check email", "Coffee"}
    assert "Read emails" in {r["activity_raw"] for r in rows}

    await client.put(
        f"{API}/sessions/{host.code}/aliases",
        json={"question_id": host.trace_id, "aliases": []},
        headers=host.headers,
    )
    assert (await analytics(client, host)).json()["kpis"]["n_variants"] == 4


async def test_suggest_endpoint_is_public_but_respects_config(client):
    host = await create_host(client)
    await host.submit(["Check mail", "Coffee"])
    await host.submit(["check mail", "Coffee"])
    await host.submit(["Shower", "Coffee"])
    r = await client.get(
        f"{API}/sessions/{host.code}/labels/suggest",
        params={"question_id": host.trace_id, "q": "ch"},
    )
    assert r.json() == {"labels": ["Check mail"]}
    r = await client.get(
        f"{API}/sessions/{host.code}/labels/suggest", params={"question_id": host.trace_id}
    )
    assert r.json()["labels"][0] == "Coffee"

    assert set(r.json()) == {"labels"}
    off = await create_host(
        client,
        questions=[{"type": "trace", "prompt": "T", "config": {"suggest_existing": False}}],
    )
    await off.submit(["a", "b"])
    r = await client.get(
        f"{API}/sessions/{off.code}/labels/suggest", params={"question_id": off.trace_id}
    )
    assert r.json() == {"labels": []}


async def test_export_csv_with_attributes_and_injection_protection(client):
    host = await create_host(client)
    await host.submit(["=HYPERLINK(1)", "+cmd", "ok"], role="Student", experience="Expert")
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "csv"}, headers=host.headers
    )
    assert r.status_code == 200 and r.content.startswith(b"\xef\xbb\xbf")
    assert (
        "attachment" in r.headers["content-disposition"]
        and host.code in r.headers["content-disposition"]
    )
    rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert [x["position"] for x in rows] == ["1", "2", "3"]
    assert rows[0]["activity"] == "'=HYPERLINK(1)" and rows[1]["activity"] == "'+cmd"
    assert rows[0]["Role"] == "Student" and rows[0]["Experience"] == "Expert"
    assert len({x["case_id"] for x in rows}) == 1 and rows[0]["case_id"].startswith("case_")


async def test_export_xes_is_wellformed_and_marks_synthetic_time(client):
    host = await create_host(client)
    await host.submit(["Wake up", "Coffee & <tea>", "Leave"], role="Student")
    await host.submit(["Wake up", "Leave"], role="Lecturer")
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "xes"}, headers=host.headers
    )
    assert r.status_code == 200
    ns = {"x": "http://www.xes-standard.org/"}
    root = ET.fromstring(r.content)
    assert root.tag == "{http://www.xes-standard.org/}log"
    flag = root.find("x:boolean[@key='processpoll:synthetic_timestamps']", ns)
    assert flag is not None and flag.get("value") == "true"
    traces = root.findall("x:trace", ns)
    assert len(traces) == 2
    first = traces[0]
    assert first.find("x:string[@key='Role']", ns).get("value") == "Student"
    names = [
        e.find("x:string[@key='concept:name']", ns).get("value")
        for e in first.findall("x:event", ns)
    ]
    assert names == ["Wake up", "Coffee & <tea>", "Leave"]
    stamps = [
        e.find("x:date[@key='time:timestamp']", ns).get("value")
        for e in first.findall("x:event", ns)
    ]
    assert stamps == sorted(stamps) and len(set(stamps)) == 3
    assert root.find("x:classifier", ns).get("keys") == "concept:name"


async def test_export_json_dump(client):
    host = await create_host(client)
    await host.submit(["a", "b"], role="Student")
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "json"}, headers=host.headers
    )
    data = r.json()
    assert data["format"] == "processpoll-session-v1" and data["session"]["code"] == host.code
    assert len(data["questions"]) == 3 and len(data["responses"]) == 1
    answers = data["responses"][0]["answers"]
    assert answers[host.trace_id]["steps"] == ["a", "b"]
    r = await client.get(
        f"{API}/sessions/{host.code}/export", params={"format": "pdf"}, headers=host.headers
    )
    assert r.status_code == 422


async def test_export_selects_trace_question(client):
    qs = [
        {"type": "trace", "prompt": "First", "config": {"min_steps": 1}},
        {"type": "trace", "prompt": "Second", "config": {"min_steps": 1}},
    ]
    host = await create_host(client, questions=qs)
    ids = {q["prompt"]: q["id"] for q in host.session["questions"]}
    token = await host.participant()
    await client.post(
        f"{API}/sessions/{host.code}/responses",
        json={
            "answers": [
                {"question_id": ids["First"], "value": {"steps": ["x"]}},
                {"question_id": ids["Second"], "value": {"steps": ["y", "z"]}},
            ]
        },
        headers={"X-Participant-Token": token},
    )
    r = await client.get(
        f"{API}/sessions/{host.code}/export",
        params={"format": "csv", "question_id": ids["Second"]},
        headers=host.headers,
    )
    rows = list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert [x["activity"] for x in rows] == ["y", "z"]

    assert "First" not in rows[0]
