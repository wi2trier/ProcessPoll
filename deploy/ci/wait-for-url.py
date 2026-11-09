#!/usr/bin/env python3
"""Wait until a URL answers with HTTP 2xx (used by CI before running e2e tests).

Usage: wait-for-url.py URL [--timeout 60]
Exit code 0 when reachable, 1 on timeout.
"""
import argparse
import sys
import time
import urllib.error
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()

    deadline = time.monotonic() + args.timeout
    last_error = "no attempt"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(args.url, timeout=3) as response:
                if 200 <= response.status < 300:
                    print(f"{args.url} is up (HTTP {response.status})")
                    return 0
                last_error = f"HTTP {response.status}"
        except (urllib.error.URLError, OSError) as exc:
            last_error = str(exc)
        time.sleep(1)
    print(f"timeout waiting for {args.url}: {last_error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
