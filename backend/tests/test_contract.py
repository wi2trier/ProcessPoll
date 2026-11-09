"""Check that API responses match the declared models and OpenAPI schema."""

from __future__ import annotations

from conftest import MORNING_QUESTIONS, create_host

from app.schemas import (
    AdminSessionOut,
    AliasesSaved,
    AnalyticsOut,
    CompareOut,
    ErrorOut,
    JoinOut,
    LabelsOut,
    MetaOut,
    PublicSessionOut,
    ResponseCreated,
    SessionCreated,
    SuggestOut,
)

API = "/api/v1"


async def populated(client):
    host = await create_host(client, settings={"k_min": 2})
    for steps, role in (
        (["Wake up", "Shower", "Coffee", "Leave"], "Student"),
        (["Wake up", "Shower", "Coffee", "Leave"], "Student"),
        (["Wake up", "Coffee", "Leave"], "Lecturer"),
        (["Wake up", "Coffee", "Leave"], "Lecturer"),
        (["Coffee", "Wake up", "Coffee", "Leave"], None),
    ):
        assert (await host.submit(steps, role=role)).status_code == 201
    return host


async def test_analytics_and_compare_payloads_match_the_documented_models(client):
    host = await populated(client)
    url = f"{API}/sessions/{host.code}"
    role = host.q["Role"]["id"]
    full = await client.get(
        f"{url}/analytics", params={"question_id": host.trace_id}, headers=host.headers
    )
    AnalyticsOut.model_validate(full.json())
    filtered = await client.get(
        f"{url}/analytics",
        params={
            "question_id": host.trace_id,
            "filter_question_id": role,
            "filter_value": "Student",
        },
        headers=host.headers,
    )
    assert AnalyticsOut.model_validate(filtered.json()).filter is not None
    empty = await client.get(
        f"{url}/analytics",
        params={"question_id": host.trace_id, "filter_question_id": role, "filter_value": "Dean"},
        headers=host.headers,
    )
    AnalyticsOut.model_validate(empty.json())
    suppressed = await client.get(
        f"{url}/analytics",
        params={
            "question_id": host.trace_id,
            "filter_question_id": role,
            "filter_value": "(no answer)",
            "key": host.display_key,
        },
    )
    assert AnalyticsOut.model_validate(suppressed.json()).suppressed is True
    compare = await client.get(
        f"{url}/compare",
        params={"question_id": host.trace_id, "group_by": role},
        headers=host.headers,
    )
    parsed = CompareOut.model_validate(compare.json())
    assert [g.value for g in parsed.groups] == ["Lecturer", "Student"]
    assert parsed.hidden_groups[0].value == "(no answer)"
    assert parsed.diff_edges and parsed.pairwise

    await client.patch(f"{url}", json={"settings": {"k_min": 50}}, headers=host.headers)
    compare = await client.get(
        f"{url}/compare",
        params={"question_id": host.trace_id, "group_by": role},
        headers=host.headers,
    )
    assert CompareOut.model_validate(compare.json()).groups == []


async def test_other_payloads_match_the_documented_models(client):
    host = await populated(client)
    url = f"{API}/sessions/{host.code}"
    created = await client.post(
        f"{API}/sessions", json={"title": "x", "questions": MORNING_QUESTIONS}
    )
    SessionCreated.model_validate(created.json())
    PublicSessionOut.model_validate((await client.get(url)).json())
    AdminSessionOut.model_validate((await client.get(f"{url}/admin", headers=host.headers)).json())
    MetaOut.model_validate((await client.get(f"{API}/meta")).json())
    JoinOut.model_validate((await client.post(f"{url}/join", json={})).json())
    labels = await client.get(
        f"{url}/labels", params={"question_id": host.trace_id}, headers=host.headers
    )
    parsed = LabelsOut.model_validate(labels.json())
    assert parsed.labels and parsed.question_id == host.trace_id
    saved = await client.put(
        f"{url}/aliases",
        json={"question_id": host.trace_id, "aliases": []},
        headers=host.headers,
    )
    AliasesSaved.model_validate(saved.json())
    suggest = await client.get(f"{url}/labels/suggest", params={"question_id": host.trace_id})
    SuggestOut.model_validate(suggest.json())
    token = await host.participant()
    first = await host.submit(["a", "b"], token=token, key="k")
    ResponseCreated.model_validate(first.json())
    assert first.status_code == 201
    replay = await host.submit(["a", "b"], token=token, key="k")
    assert replay.status_code == 200 and replay.json() == first.json()


async def test_error_payloads_follow_the_documented_shape(client):
    host = await populated(client)
    url = f"{API}/sessions/{host.code}"
    token = await host.participant()
    big = await client.post(f"{url}/join", content=b"x" * 70_000)
    cases = {
        "invalid_key": await client.get(f"{url}/admin"),
        "not_found": await client.get(f"{API}/sessions/ZZZZ-99"),
        "invalid_token": await client.post(f"{url}/responses", json={"answers": []}),
        "already_submitted": await host.submit(["a", "b"], token=await _submitted_token(host)),
        "validation_error": await client.post(
            f"{url}/responses",
            json={"answers": [{"question_id": host.trace_id, "value": {"steps": ["x"]}}]},
            headers={"X-Participant-Token": token},
        ),
        "payload_too_large": big,
        "method_not_allowed": await client.put(f"{API}/meta"),
    }
    for code, response in cases.items():
        body = ErrorOut.model_validate(response.json())
        assert body.detail == code, (code, response.text)
    assert cases["validation_error"].json()["errors"][0]["question_id"] == host.trace_id

    bad = await client.post(f"{API}/sessions", json={"title": "x", "questions": []})
    assert ErrorOut.model_validate(bad.json()).errors[0].field == "questions"


async def _submitted_token(host) -> str:
    token = await host.participant()
    assert (await host.submit(["a", "b"], token=token)).status_code == 201
    return token


async def test_openapi_describes_the_real_error_and_result_shapes(client):
    spec = (await client.get("/openapi.json")).json()
    schemas = spec["components"]["schemas"]
    assert "HTTPValidationError" not in schemas
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            r422 = op["responses"].get("422")
            if r422:
                ref = r422["content"]["application/json"]["schema"]["$ref"]
                assert ref.endswith("/ErrorOut"), (method, path)
    get = spec["paths"]["/api/v1/sessions/{code}/analytics"]["get"]["responses"]
    assert get["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/AnalyticsOut")
    assert "304" in get and "401" in get and "503" in get
    compare = spec["paths"]["/api/v1/sessions/{code}/compare"]["get"]["responses"]
    assert compare["200"]["content"]["application/json"]["schema"]["$ref"].endswith("/CompareOut")
    export = spec["paths"]["/api/v1/sessions/{code}/export"]["get"]["responses"]["200"]
    assert set(export["content"]) == {"text/csv", "application/xml", "application/json"}
    assert "200" in spec["paths"]["/api/v1/sessions/{code}/responses"]["post"]["responses"]
