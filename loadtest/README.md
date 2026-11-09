# Demo data and load tests

This directory has two ways to send synthetic responses to ProcessPoll:

- `simulate.py` creates a poll and submits a chosen number of responses. It is useful for a demo or a quick manual check.
- `locustfile.py` runs a load test with participant, host, dashboard and results-listener users.

Both use `synthetic.py` to generate a sample morning routine and participant answers. The values are fictional.

## Install

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Fill a poll with demo responses

Run this against a local app or another instance you control:

```bash
python simulate.py --base-url http://localhost:8080 --n 150 --seed 42
```

The base URL should serve `/api`; with the local Vite server, use `http://localhost:5173`. The script creates and opens a poll by default, then prints its join, host and display links. Keep the host and display keys private. Use `--mode select_sort` for a fixed activity list, `--spread 20` to stagger submissions over 20 seconds, and `--close` to close the poll when finished.

To add responses to an existing poll, pass its code and admin key:

```bash
python simulate.py --session-code MORN-24 --admin-key YOUR_KEY --n 50
```

Run `python simulate.py --help` for the full option list. The script returns a non-zero exit code if any submissions fail.

## Run a Locust test

Use a test instance with PostgreSQL and the reverse proxy, as in `deploy/compose.yml`. SQLite on a development machine will not give useful capacity measurements. Start with a small run:

```bash
LT_DASHBOARDS=5 locust -f locustfile.py --host http://localhost:8080 \
  --headless -u 106 -r 50 -t 90s
```

Locust creates and opens a poll when the run starts, then closes it at the end. By default, `-u` is split between one host, five dashboards and participants; `-u 106` is about 100 participants. Set `LT_LISTENERS` to add participants who watch public results. The generated session has a one-day retention period unless the server is in demo mode.

The default participant scenario makes four autocomplete requests while entering a trace. Set `LT_SUGGEST_CALLS=0` to turn those requests off. Other useful settings are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LT_DASHBOARDS` | `5` | Number of live dashboards |
| `LT_LISTENERS` | `0` | Number of public results viewers |
| `LT_SUBMIT_WINDOW` | `30` | Seconds over which participants start submitting |
| `LT_MODE` | `free` | Trace question mode: `free` or `select_sort` |
| `LT_MAX_FAIL_RATIO` | `0.01` | Maximum allowed failed HTTP request ratio |
| `LT_SUBMIT_P95_MS` | `0` | Optional submit latency limit; `0` disables it |

The remaining settings are available when reusing a poll or tuning a scenario:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LT_SESSION_CODE` | empty | Reuse a poll instead of creating one |
| `LT_ADMIN_KEY` | empty | Admin key used to open or close a reused poll |
| `LT_DISPLAY_KEY` | empty | Display key for a reused poll |
| `LT_NOISE` | `0.25` | Variation in free-text activity labels |
| `LT_STUDENT_SHARE` | `0.7` | Share of generated student participants; the rest are lecturers |
| `LT_RESULTS_PUBLIC` | `true` | Make results available to listeners without a display key |
| `LT_SEED` | `1` | Seed for generated participants |
| `LT_THINK_MIN` | `1` | Minimum seconds between joining and submitting |
| `LT_THINK_MAX` | `4` | Maximum seconds between joining and submitting |
| `LT_DASHBOARD_COMPARE_EVERY` | `5` | Fetch group comparisons every Nth update; `0` disables them |
| `LT_LISTENER_MIN_FETCH` | `2.0` | Minimum seconds between listener analytics requests |
| `LT_LISTENER_USE_KEY` | `false` | Send the display key with listener requests |
| `LT_SSE_MAX_SECONDS` | `0` | Reconnect SSE after this many seconds; `0` keeps the stream open |
| `LT_HOST_POLL_SECONDS` | `5` | Host dashboard polling interval |
| `LT_CLOSE_AT_END` | `true` | Close the poll after the run |

Locust reports request latency and failures in its terminal output. Add `--csv results/run --html results/run.html` to save a report. Only run these scenarios against a system you operate: they create polls and responses.
