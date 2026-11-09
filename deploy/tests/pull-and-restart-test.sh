#!/usr/bin/env bash

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:?usage: $0 <deploy dir>}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/deploy"
export FAKE="$W/fake"; mkdir -p "$FAKE"/{running,images,registry,health,badimg}
export PATH="$HERE/bin:$PATH"
echo sha256:bk > "$FAKE/running/backup"; echo running > "$FAKE/health/backup"
cp "$SRC/pull-and-restart.sh" "$SRC/deploy.sh" "$W/deploy/"
touch "$W/deploy/compose.yml"
cd "$W/deploy" || exit 1
fails=0
check() {
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 (expected '$2', got '$3')"; fails=$((fails+1)); fi
}
write_env() { printf 'IMAGE_PREFIX=reg.example.org/example-org/pt\nIMAGE_TAG=%s\nHEALTH_TIMEOUT=4\n%s' "$1" "${2:-}" > .env; }
reg() { echo "$3" > "$FAKE/registry/$(printf '%s' "reg.example.org/example-org/pt/$1:$2" | tr '/:' '__')"; }
state() { echo "$FAKE/running/$1"; }
run() { ./pull-and-restart.sh "$@" > "$W/out.txt" 2> "$W/err.txt"; echo $?; }
show() { sed 's/^/      | /' "$W/out.txt" "$W/err.txt" | head -"${1:-12}"; }

echo "== 1. first deployment of tag 1.0.0 (nothing running)"
write_env stable
reg backend 1.0.0 sha256:b100; reg proxy 1.0.0 sha256:p100
rc=$(run --tag 1.0.0); show 6
check "exit 0" 0 "$rc"
check "backend running v1" sha256:b100 "$(cat "$(state backend)")"
check ".env IMAGE_TAG persisted" "IMAGE_TAG=1.0.0" "$(grep ^IMAGE_TAG= .env)"
check "last_success written" 1 "$(grep -c 1.0.0 .deploy/last_success)"
check "no previous tag yet" 0 "$(ls "$FAKE/images" | grep -c previous)"

echo "== 2. same tag again -> nothing to do"
rc=$(run --quiet); check "exit 0" 0 "$rc"
check "no restart (up not called again)" 1 "$(grep -c ' up ' "$FAKE/calls.log")"

echo "== 3. healthy update to 1.1.0 (pre-update backup, :previous tagged)"
reg backend 1.1.0 sha256:b110; reg proxy 1.1.0 sha256:p110
rc=$(run --tag 1.1.0); show 8
check "exit 0" 0 "$rc"
check "backend running v1.1" sha256:b110 "$(cat "$(state backend)")"
check ":previous = old backend" sha256:b100 "$(cat "$FAKE/images/reg.example.org_example-org_pt_backend_previous")"
check "pre-update backup ran for the first deployment and for this update" 2 "$(wc -l < "$FAKE/backup_calls.log" | tr -d ' ')"
check ".env IMAGE_TAG=1.1.0" "IMAGE_TAG=1.1.0" "$(grep ^IMAGE_TAG= .env)"

echo "== 4. broken update to 1.2.0 -> automatic rollback, exit 1, marked bad"
reg backend 1.2.0 sha256:b120; reg proxy 1.2.0 sha256:p120; touch "$FAKE/badimg/sha256:b120"
rc=$(run --tag 1.2.0); show 14
check "exit 1" 1 "$rc"
check "rolled back to v1.1 (previous)" sha256:b110 "$(cat "$(state backend)")"
check "rolled back proxy" sha256:p110 "$(cat "$(state proxy)")"
check ".env tag NOT changed to broken" "IMAGE_TAG=1.1.0" "$(grep ^IMAGE_TAG= .env)"
check "bad ids recorded" 1 "$(grep -c sha256:b120 .deploy/bad_ids)"
check "healthy running ids not marked bad" 0 "$(grep -c sha256:b110 .deploy/bad_ids)"

echo "== 5. timer follows tag 'stable' that now points at the broken release -> skipped, exit 0"
write_env stable; reg backend stable sha256:b120; reg proxy stable sha256:p120
rc=$(run --quiet); show 4
check "exit 0 (quiet skip)" 0 "$rc"
check "still on v1.1" sha256:b110 "$(cat "$(state backend)")"
rc=$(run --tag stable); check "explicit --tag of a bad image fails (exit 1)" 1 "$rc"

echo "== 6. --force retries the bad image (fails again, rolls back)"
rc=$(run --tag stable --force); check "exit 1" 1 "$rc"
check "back on v1.1" sha256:b110 "$(cat "$(state backend)")"

echo "== 7. manual --rollback"
write_env 1.1.0; reg backend 1.3.0 sha256:b130; reg proxy 1.3.0 sha256:p130
rc=$(run --tag 1.3.0); check "update to 1.3.0 ok" 0 "$rc"
rc=$(run --rollback); show 6; check "rollback exit 0" 0 "$rc"
check "back on v1.1 images" sha256:b110 "$(cat "$(state backend)")"
check "v1.3 marked bad" 1 "$(grep -c sha256:b130 .deploy/bad_ids)"

echo "== 8. argument / config errors"
rc=$(run --tag 'bad;tag'); check "invalid tag exit 2" 2 "$rc"
rc=$(run --tag); check "--tag without value exit 2" 2 "$rc"
rc=$(run --bogus); check "unknown option exit 2" 2 "$rc"
rc=$(run --rollback --tag 1.0.0); check "--rollback + --tag exit 2" 2 "$rc"
touch "$FAKE/lock_held"; rc=$(run); check "lock held -> exit 3" 3 "$rc"; rm "$FAKE/lock_held"
write_env 1.1.0 'HEALTH_TIMEOUT=abc
'; rc=$(run); check "non-numeric HEALTH_TIMEOUT exit 4" 4 "$rc"
write_env 1.1.0 'HEALTHCHECK_URL=http://example.invalid/healthz
'
if command -v curl >/dev/null 2>&1; then
  echo "  skip HEALTHCHECK_URL without curl (curl is installed here)"
else
  rc=$(run); check "HEALTHCHECK_URL without curl exit 4" 4 "$rc"
fi
rm .env; rc=$(run); check "missing .env exit 4" 4 "$rc"

echo "== 9. .env parsing (CRLF, quotes, trailing comment)"
printf 'IMAGE_PREFIX="reg.example.org/example-org/pt"\r\nIMAGE_TAG=1.1.0 # pinned\r\nHEALTH_TIMEOUT=4\r\n' > .env
rc=$(run); show 6; check "pull+noop exit 0 with CRLF/quotes/comment" 0 "$rc"

echo "== 10. pull failure"
write_env 1.1.0; rc=$(FAKE_PULL_FAIL=1 run); check "pull failure exit 1" 1 "$rc"

echo "== 11. registry token never appears on a command line"
printf 'SECRETTOKEN' > "$W/token"
write_env 1.1.0 "REGISTRY_USER=deploy
REGISTRY_TOKEN_FILE=$W/token
"
rc=$(run --force); check "exit 0" 0 "$rc"
check "token not in calls.log" 0 "$(grep -c SECRETTOKEN "$FAKE/calls.log")"
check "token delivered on stdin" 11 "$(wc -c < "$FAKE/login_stdin" | tr -d ' ')"

echo "== 12. first deployment fails -> no previous images, exit 1"
rm -rf "$FAKE/running" "$FAKE/images" "$FAKE/health"; mkdir -p "$FAKE"/{running,images,health}; rm -rf .deploy
write_env 2.0.0; reg backend 2.0.0 sha256:b200; reg proxy 2.0.0 sha256:p200; touch "$FAKE/badimg/sha256:b200"
rc=$(run); show 8; check "exit 1" 1 "$rc"

echo; echo "FAILURES: $fails"; exit "$fails"
