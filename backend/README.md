# Backend

The backend is a FastAPI service. It stores polls and responses, serves the API used by the frontend, and computes the result views and exports.

## Run locally

From this directory, create and activate a virtual environment, then install the development dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Start the server:

```bash
export PROCESSPOLL_DATABASE_URL=sqlite+aiosqlite:///./processpoll.db
uvicorn app.main:app --reload --port 8000
```

SQLite is the default for local development, and its tables are created when the app starts. The API health check is at `/healthz`; in development, the interactive API docs are at `/docs`.

For PostgreSQL, set `PROCESSPOLL_DATABASE_URL` to a `postgresql+asyncpg://` URL and run `alembic upgrade head` before starting the app. The container entrypoint runs this migration command automatically.

## Tests and checks

```bash
pytest
ruff check .
ruff format --check .
pyright
```

Tests use a temporary SQLite database by default. To run them against PostgreSQL, set `PROCESSPOLL_TEST_DATABASE_URL` to a disposable test database. The test setup drops its existing tables, so do not point it at a database with data you need.

## How it is organized

- `app/routes.py` defines the HTTP endpoints.
- `app/schemas.py` and `app/validation.py` validate requests and answers.
- `app/analytics/` contains the analysis functions.
- `app/analytics_service.py` prepares stored responses for analysis.
- `app/export.py` creates CSV, XES and JSON exports.
- `app/live.py` handles live updates and the in-process analytics cache.
- `alembic/` contains the database migrations.
- `tests/` contains the backend test suite.

The live update hub and analytics cache are in memory, so run one Uvicorn worker per instance.
