"""Run the migrations and the test suite against a throw-away embedded PostgreSQL.

Needs `pip install pgserver` (dev convenience for machines without Docker; CI uses a postgres
service container instead). Usage:  python scripts/test_postgres.py [pytest args]
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pgserver

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="processpoll_pg_")
    server = pgserver.get_server(data_dir, cleanup_mode="delete")
    uri = server.get_uri().replace("postgresql://", "postgresql+asyncpg://", 1)
    print("embedded postgres:", uri)
    env = {**os.environ, "PROCESSPOLL_DATABASE_URL": uri, "PROCESSPOLL_TEST_DATABASE_URL": uri}
    steps = [
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        [sys.executable, "-m", "alembic", "check"],
        [sys.executable, "-m", "alembic", "downgrade", "base"],
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        [sys.executable, "-m", "pytest", "-q", "-W", "ignore", *sys.argv[1:]],
    ]
    try:
        for cmd in steps:
            print("$", " ".join(cmd[2:]))
            code = subprocess.call(cmd, cwd=ROOT, env=env)
            if code != 0:
                return code
    finally:
        server.cleanup()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
