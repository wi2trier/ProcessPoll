#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG=""
FORCE=0
ROLLBACK=0
SKIP_BACKUP=0
QUIET=0

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)         [ $# -ge 2 ] || { echo "--tag needs a value" >&2; exit 2; }; TAG="$2"; shift 2 ;;
    --force)       FORCE=1; shift ;;
    --rollback)    ROLLBACK=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --quiet)       QUIET=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log()  { if [ "$QUIET" -eq 0 ]; then printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; fi; }
warn() { printf '%s WARN %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die()  { printf '%s ERROR %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit "${2:-1}"; }

if [ -n "$TAG" ] && ! printf '%s' "$TAG" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  die "invalid tag '$TAG' (allowed: letters, digits, . _ -)" 2
fi
if [ "$ROLLBACK" -eq 1 ] && [ -n "$TAG" ]; then die "--rollback and --tag cannot be combined" 2; fi

env_get() {
  local key="$1" default="${2:-}" v=""
  if [ -f .env ]; then
    v="$(grep -E "^[[:space:]]*${key}=" .env | tail -n1 | cut -d= -f2- || true)"
    v="${v%$'\r'}"
    case "$v" in
      \"*\") v="${v#\"}"; v="${v%\"}" ;;
      \'*\') v="${v#\'}"; v="${v%\'}" ;;
      *)     v="${v%%[[:space:]]\#*}"; v="${v%"${v##*[![:space:]]}"}" ;;
    esac
  fi
  printf '%s' "${v:-$default}"
}

[ -f .env ] || die "no .env in $SCRIPT_DIR (copy .env.example and edit it)" 4
command -v docker >/dev/null 2>&1 || die "docker not found" 4
docker compose version >/dev/null 2>&1 || die "docker compose plugin not found" 4
command -v flock >/dev/null 2>&1 || die "flock not found (package util-linux)" 4

PREFIX="$(env_get IMAGE_PREFIX)"
[ -n "$PREFIX" ] || die "IMAGE_PREFIX is not set in .env" 4
CURRENT_TAG="$(env_get IMAGE_TAG stable)"
TARGET_TAG="${TAG:-$CURRENT_TAG}"
HEALTH_TIMEOUT="$(env_get HEALTH_TIMEOUT 180)"
HEALTHCHECK_URL="$(env_get HEALTHCHECK_URL)"
REGISTRY="${PREFIX%%/*}"
REGISTRY_USER="$(env_get REGISTRY_USER)"
REGISTRY_TOKEN_FILE="$(env_get REGISTRY_TOKEN_FILE /etc/processpoll/registry-token)"
case "$HEALTH_TIMEOUT" in ''|*[!0-9]*) die "HEALTH_TIMEOUT must be a number of seconds, got '$HEALTH_TIMEOUT'" 4 ;; esac
if [ -n "$HEALTHCHECK_URL" ] && ! command -v curl >/dev/null 2>&1; then

  die "HEALTHCHECK_URL is set but curl is not installed" 4
fi

SERVICES=(backend proxy)
STATE_DIR="$SCRIPT_DIR/.deploy"
mkdir -p "$STATE_DIR"
touch "$STATE_DIR/bad_ids"

exec 9>"$SCRIPT_DIR/.deploy.lock"
if ! flock -n 9; then
  warn "another deployment is running, exiting"
  exit 3
fi

compose() { docker compose -f compose.yml "$@"; }

image_ref() { printf '%s/%s:%s' "$PREFIX" "$1" "$2"; }

running_image_id() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null | head -n1 || true)"
  if [ -n "$cid" ]; then
    docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true
  fi
}

local_image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

health_of() {
  local cid
  cid="$(compose ps -q "$1" 2>/dev/null | head -n1 || true)"
  if [ -z "$cid" ]; then echo none; return; fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo none
}

wait_healthy() {
  local deadline=$(( $(date +%s) + $1 )) svc st all_ok
  while [ "$(date +%s)" -lt "$deadline" ]; do
    all_ok=1
    for svc in postgres "${SERVICES[@]}"; do
      st="$(health_of "$svc")"
      case "$st" in healthy|running) ;; *) all_ok=0 ;; esac
    done
    if [ "$all_ok" -eq 1 ]; then
      if [ -n "$HEALTHCHECK_URL" ]; then
        if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 10 -o /dev/null "$HEALTHCHECK_URL"; then
          return 0
        fi
      else
        return 0
      fi
    fi
    sleep 3
  done
  for svc in postgres "${SERVICES[@]}"; do warn "service $svc: $(health_of "$svc")"; done
  return 1
}

registry_login() {
  if [ -n "$REGISTRY_USER" ] && [ -r "$REGISTRY_TOKEN_FILE" ]; then
    log "logging in to $REGISTRY as $REGISTRY_USER"
    docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin < "$REGISTRY_TOKEN_FILE" >/dev/null \
      || warn "registry login failed (continuing; pull may fail for private images)"
  elif [ -n "$REGISTRY_USER" ]; then
    warn "REGISTRY_USER is set but token file $REGISTRY_TOKEN_FILE is not readable"
  fi
}

set_env_tag() {
  local tag="$1" tmp
  tmp="$(mktemp "$SCRIPT_DIR/.env.XXXXXX")"
  if grep -qE '^[[:space:]]*IMAGE_TAG=' .env; then
    sed -E "s|^[[:space:]]*IMAGE_TAG=.*|IMAGE_TAG=${tag}|" .env > "$tmp"
  else
    cp .env "$tmp"; printf 'IMAGE_TAG=%s\n' "$tag" >> "$tmp"
  fi
  chmod --reference=.env "$tmp" 2>/dev/null || true
  mv "$tmp" .env
}

record_bad_ids() {
  local svc id
  for svc in "${SERVICES[@]}"; do
    id="$(local_image_id "$(image_ref "$svc" "$TARGET_TAG")")"
    if [ -n "$id" ] && [ "$id" != "${OLD_ID[$svc]:-}" ]; then echo "$id" >> "$STATE_DIR/bad_ids"; fi
  done
}

if [ "$ROLLBACK" -eq 1 ]; then
  for svc in "${SERVICES[@]}"; do
    docker image inspect "$(image_ref "$svc" previous)" >/dev/null 2>&1 \
      || die "no previous image for $svc (nothing to roll back to)"
  done
  log "rolling back to the previous images"

  for svc in "${SERVICES[@]}"; do
    id="$(running_image_id "$svc")"; if [ -n "$id" ]; then echo "$id" >> "$STATE_DIR/bad_ids"; fi
  done
  IMAGE_TAG=previous compose up -d --remove-orphans --no-build --pull never
  if wait_healthy "$HEALTH_TIMEOUT"; then
    log "rollback complete; the rolled-back images are marked bad and will not be redeployed automatically."
    log "IMAGE_TAG in .env is still '$CURRENT_TAG': a plain 'docker compose up -d' would start those images again."
    log "pin the version you want with: $0 --tag <tag>"
    exit 0
  fi
  die "rollback did not become healthy - inspect: docker compose logs --tail=200"
fi

log "target tag: $TARGET_TAG (prefix: $PREFIX)"
registry_login

declare -A OLD_ID NEW_ID
for svc in "${SERVICES[@]}"; do OLD_ID[$svc]="$(running_image_id "$svc")"; done

export IMAGE_TAG="$TARGET_TAG"
log "pulling images"
pull_opts=()
if [ "$QUIET" -eq 1 ]; then pull_opts=(--quiet); fi
compose pull "${pull_opts[@]}" "${SERVICES[@]}" || die "pull failed (registry unreachable or login required?)"

changed=0
for svc in "${SERVICES[@]}"; do
  NEW_ID[$svc]="$(local_image_id "$(image_ref "$svc" "$TARGET_TAG")")"
  [ -n "${NEW_ID[$svc]}" ] || die "image for $svc not found locally after pull"
  if [ "${NEW_ID[$svc]}" != "${OLD_ID[$svc]}" ]; then changed=1; fi
done

if [ "$FORCE" -eq 0 ]; then
  for svc in "${SERVICES[@]}"; do
    if [ "${NEW_ID[$svc]}" != "${OLD_ID[$svc]}" ] && grep -qxF "${NEW_ID[$svc]}" "$STATE_DIR/bad_ids"; then
      if [ -n "$TAG" ]; then
        die "$svc image ${NEW_ID[$svc]} of tag $TAG previously failed to start (use --force to retry)"
      fi
      warn "$svc image ${NEW_ID[$svc]} previously failed to start; not deploying it (use --force to retry)"
      exit 0
    fi
  done
fi

all_running=1
for svc in postgres "${SERVICES[@]}"; do
  case "$(health_of "$svc")" in healthy|running) ;; *) all_running=0 ;; esac
done

if [ "$changed" -eq 0 ] && [ "$FORCE" -eq 0 ] && [ "$all_running" -eq 1 ] && [ "$TARGET_TAG" = "$CURRENT_TAG" ]; then
  log "already up to date ($TARGET_TAG), nothing to do"
  exit 0
fi

if [ "$changed" -eq 1 ]; then
  for svc in "${SERVICES[@]}"; do
    if [ -n "${OLD_ID[$svc]}" ]; then
      docker tag "${OLD_ID[$svc]}" "$(image_ref "$svc" previous)"
    fi
  done
fi

if [ "$SKIP_BACKUP" -eq 0 ] && [ "$changed" -eq 1 ] && [ "$(health_of backup)" != "none" ]; then
  log "creating a pre-update database backup"
  compose exec -T backup /bin/sh /usr/local/bin/backup.sh once \
    || warn "pre-update backup failed (continuing)"
fi

log "starting stack with $TARGET_TAG"
if compose up -d --remove-orphans --no-build --pull never && wait_healthy "$HEALTH_TIMEOUT"; then
  if [ -n "$TAG" ] && [ "$TAG" != "$CURRENT_TAG" ]; then
    set_env_tag "$TAG"
    log "IMAGE_TAG in .env set to $TAG"
  fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET_TAG" > "$STATE_DIR/last_success"
  docker image prune -f >/dev/null 2>&1 || true
  log "deployment of $TARGET_TAG successful"
  exit 0
fi

warn "deployment of $TARGET_TAG did not become healthy"
compose logs --tail=60 backend proxy 2>&1 | sed 's/^/    /' >&2 || true
record_bad_ids

have_previous=1
for svc in "${SERVICES[@]}"; do
  docker image inspect "$(image_ref "$svc" previous)" >/dev/null 2>&1 || have_previous=0
done

if [ "$have_previous" -eq 1 ] && [ "$changed" -eq 1 ]; then
  warn "rolling back to the previous images"
  IMAGE_TAG=previous compose up -d --remove-orphans --no-build --pull never || true
  if wait_healthy "$HEALTH_TIMEOUT"; then
    warn "rollback successful; the failed images are marked bad (see $STATE_DIR/bad_ids)"
  else
    warn "rollback did NOT become healthy either - manual intervention required"
  fi
else
  warn "no previous images available (first deployment?) - cannot roll back"
fi
exit 1
