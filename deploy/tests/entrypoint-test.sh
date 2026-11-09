#!/usr/bin/env bash

set -u
SRC="${1:?usage: $0 <deploy dir>}/entrypoint.sh"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin"
SH="$(command -v dash || command -v sh)"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 (expected '$2', got '$3')"; fails=$((fails+1)); fi; }
cat > "$W/bin/alembic" <<'EOF'
#!/bin/sh
n=$(cat "$W/count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$W/count"
echo "alembic $* (call $n)" >> "$W/calls"
[ "$n" -le "${FAIL_TIMES:-0}" ] && exit 1
exit 0
EOF
cat > "$W/bin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x "$W/bin/alembic" "$W/bin/sleep"
export PATH="$W/bin:$PATH" W
"$SH" -n "$SRC"; check "sh -n" 0 $?
reset() { rm -f "$W/count" "$W/calls"; }

reset; FAIL_TIMES=0 "$SH" "$SRC" sh -c 'echo CMD-RAN' > "$W/out" 2>&1; check "success first try, command exec'd" "CMD-RAN" "$(tail -1 "$W/out")"
check "alembic called once" 1 "$(wc -l < "$W/calls" | tr -d ' ')"
reset; FAIL_TIMES=3 "$SH" "$SRC" sh -c 'echo CMD-RAN' > "$W/out" 2>&1; check "retries then runs command" "CMD-RAN" "$(tail -1 "$W/out")"
check "alembic called 4x" 4 "$(wc -l < "$W/calls" | tr -d ' ')"
reset; FAIL_TIMES=99 MIGRATION_MAX_ATTEMPTS=3 "$SH" "$SRC" sh -c 'echo CMD-RAN' > "$W/out" 2>&1; rc=$?; check "gives up after 3 attempts, exit 1" 1 $rc
check "command not started" 0 "$(grep -c CMD-RAN "$W/out")"
check "alembic called 3x" 3 "$(wc -l < "$W/calls" | tr -d ' ')"
reset; PROCESSPOLL_RUN_MIGRATIONS=false "$SH" "$SRC" sh -c 'echo CMD-RAN' > "$W/out" 2>&1; check "migrations skipped" 0 "$(ls "$W/calls" 2>/dev/null | wc -l | tr -d ' ')"
reset; FAIL_TIMES=0 "$SH" "$SRC" sh -c 'exit 7'; check "exit status of the exec'd command is propagated (PID 1 semantics)" 7 $?
echo "FAILURES: $fails"; exit "$fails"
