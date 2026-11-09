# Frontend

The frontend is a React and TypeScript app built with Vite. It needs the ProcessPoll API running locally while you work on it.

## Start the app

```bash
npm ci
npm run dev
```

Open <http://localhost:5173>. Vite forwards `/api` and `/healthz` to `http://localhost:8000`. To use a backend at another address, set `VITE_API_TARGET` before starting Vite.

## Useful commands

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

`npm test` runs the unit and component tests with Vitest. `npm run build` checks the app types and writes the production files to `dist/`.

## Browser tests

Start the backend, then run:

```bash
npm run e2e
```

Playwright builds the frontend and serves it locally for the test run. To use an already running app instead, set `PLAYWRIGHT_BASE_URL`; the app you point to must have its API available on the same origin. The tests create polls, so a disposable local or test instance is best. If the backend's session creation limit is reached, increase `PROCESSPOLL_SESSION_CREATE_PER_HOUR` on that test server.

## Code map

- `src/pages/` contains the join, participant, host, display and information pages.
- `src/components/` contains the poll builder, trace editor, results views and shared UI.
- `src/api/` contains the API client, types and data hooks.
- `src/lib/` contains the smaller helpers used by the app.
- `src/i18n/` contains the English and German text.
- `e2e/` contains the Playwright tests.
