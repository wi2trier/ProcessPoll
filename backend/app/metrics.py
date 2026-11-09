"""Tiny dependency-free Prometheus-style metrics (text exposition format).

Exposed at ``/metrics`` on the backend only; the reverse proxy does not forward that path.
"""

from __future__ import annotations

import time
from collections import defaultdict

BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)
KNOWN_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})


class Metrics:
    def __init__(self) -> None:
        self.requests: dict[tuple[str, str, str], int] = defaultdict(int)
        self.bucket_counts: dict[tuple[str, str], list[int]] = defaultdict(
            lambda: [0] * (len(BUCKETS) + 1)
        )
        self.duration_sum: dict[tuple[str, str], float] = defaultdict(float)
        self.sse_listeners = 0
        self.started = time.time()

    def observe(self, method: str, route: str, status: int, seconds: float) -> None:
        if method not in KNOWN_METHODS:
            method = "OTHER"
        self.requests[(method, route, f"{status // 100}xx")] += 1
        key = (method, route)
        self.duration_sum[key] += seconds
        counts = self.bucket_counts[key]
        for i, bound in enumerate(BUCKETS):
            if seconds <= bound:
                counts[i] += 1
                break
        else:
            counts[-1] += 1

    def render(self, extra_gauges: dict[str, float] | None = None) -> str:
        lines = [
            "# TYPE processpoll_http_requests_total counter",
        ]
        for (method, route, status), n in sorted(self.requests.items()):
            lines.append(
                f'processpoll_http_requests_total{{method="{method}",route="{route}",status="{status}"}} {n}'
            )
        lines.append("# TYPE processpoll_http_request_duration_seconds histogram")
        for (method, route), counts in sorted(self.bucket_counts.items()):
            cumulative = 0
            labels = f'method="{method}",route="{route}"'
            for bound, c in zip(BUCKETS, counts, strict=False):
                cumulative += c
                lines.append(
                    f'processpoll_http_request_duration_seconds_bucket{{{labels},le="{bound}"}} {cumulative}'
                )
            cumulative += counts[-1]
            lines.append(
                f'processpoll_http_request_duration_seconds_bucket{{{labels},le="+Inf"}} {cumulative}'
            )
            lines.append(
                f"processpoll_http_request_duration_seconds_sum{{{labels}}} {self.duration_sum[(method, route)]:.6f}"
            )
            lines.append(
                f"processpoll_http_request_duration_seconds_count{{{labels}}} {cumulative}"
            )
        lines.append("# TYPE processpoll_sse_listeners gauge")
        lines.append(f"processpoll_sse_listeners {self.sse_listeners}")
        lines.append("# TYPE processpoll_uptime_seconds gauge")
        lines.append(f"processpoll_uptime_seconds {time.time() - self.started:.0f}")
        for name, value in (extra_gauges or {}).items():
            lines.append(f"# TYPE {name} gauge")
            lines.append(f"{name} {value}")
        return "\n".join(lines) + "\n"
