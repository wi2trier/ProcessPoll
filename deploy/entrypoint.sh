#!/bin/sh

set -eu

if [ "${PROCESSPOLL_RUN_MIGRATIONS:-true}" = "true" ]; then
  attempts=0
  max_attempts="${MIGRATION_MAX_ATTEMPTS:-10}"
  until alembic upgrade head; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$max_attempts" ]; then
      echo "entrypoint: alembic upgrade head failed after ${attempts} attempts" >&2
      exit 1
    fi
    echo "entrypoint: migration attempt ${attempts}/${max_attempts} failed, retrying in 3 s" >&2
    sleep 3
  done
fi

exec "$@"
