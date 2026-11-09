from __future__ import annotations

from conftest import create_host


async def test_metrics_endpoint_counts_requests_by_route_template(client):
    host = await create_host(client)
    await host.submit(["a", "b"])
    await client.get("/api/v1/sessions/NOPE-00")
    text = (await client.get("/metrics")).text
    assert 'route="/api/v1/sessions/{code}/responses",status="2xx"} 1' in text
    assert 'route="/api/v1/sessions/{code}",status="4xx"} 1' in text
    assert "processpoll_http_request_duration_seconds_bucket" in text and "+Inf" in text
    assert "processpoll_sse_listeners 0" in text

    assert "/metrics" not in (await client.get("/openapi.json")).text
