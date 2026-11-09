# ProcessPoll

ProcessPoll is a web app for collecting and comparing how people carry out a process. A host creates a poll and shares its link or QR code. Participants put the steps in order on their phones; the results appear as a list of variants and a flow graph while people respond.

Polls can also include questions such as role or experience, which can be used to compare groups. Results can be exported as CSV, XES or JSON.

## Demo video

[![Watch the ProcessPoll demo](https://img.youtube.com/vi/-eYc4f9r74I/hqdefault.jpg)](https://www.youtube.com/watch?v=-eYc4f9r74I)

## Development

For local setup and commands, see the [backend README](backend/README.md) and [frontend README](frontend/README.md). The frontend expects the API at `http://localhost:8000` by default.

For a local instance that should clean up poll data, start the backend with `PROCESSPOLL_DEMO_MODE=true`. Demo mode expires poll data after seven days. In the Compose setup, it also disables database backups and removes existing backup dumps.

## Docker Compose

The Compose files live in `deploy/`. For a local build, copy `.env.example` to `.env`, then set `IMAGE_PREFIX=processpoll`, `IMAGE_TAG=local`, `SITE_ADDRESS=:80`, `HTTP_PORT=8080`, `HTTPS_PORT=8443` and a `POSTGRES_PASSWORD`. From `deploy/`, run:

```bash
docker compose -f compose.yml -f compose.build.yml up --build -d
```

The app will be available at <http://localhost:8080>. The production Compose file expects images from a container registry unless you include `compose.build.yml`.

## Repository

- `backend/` — FastAPI service, database models, migrations and tests
- `frontend/` — React app and browser tests
- `deploy/` — Dockerfiles, Compose files, Caddy configuration and operational scripts
- `loadtest/` — synthetic demo data and Locust scenarios

## License

ProcessPoll is licensed under the MIT License; see [LICENSE](LICENSE).
