#!/usr/bin/env bash

set -u
SRC="${1:?usage: $0 <deploy dir>}/backup/backup.sh"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/backups"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 (expected '$2', got '$3')"; fails=$((fails+1)); fi; }
SHELL_UNDER_TEST="$(command -v dash || command -v sh)"
export REAL_DATE="$(command -v date)"

cat > "$W/bin/date" <<'EOF'
#!/bin/sh
case "$*" in
  "-u +%H") echo "${FAKE_NOW%%:*}" ;;
  "-u +%M") t="${FAKE_NOW#*:}"; echo "${t%%:*}" ;;
  "-u +%S") echo "${FAKE_NOW##*:}" ;;
  *) exec "$REAL_DATE" "$@" ;;
esac
EOF

cat > "$W/bin/pg_dump" <<'EOF'
#!/bin/sh
[ "${FAKE_DUMP_FAIL:-0}" = 1 ] && { echo "pg_dump: boom" >&2; exit 1; }
for a in "$@"; do case "$a" in --file=*) f="${a#--file=}" ;; esac; done
umask > "$(dirname "$f")/../umask.txt"; echo "PGDMP fake dump" > "$f"
EOF
cat > "$W/bin/pg_restore" <<'EOF'
#!/bin/sh
[ "${FAKE_VERIFY_FAIL:-0}" = 1 ] && exit 1
exit 0
EOF
chmod +x "$W/bin/date" "$W/bin/pg_dump" "$W/bin/pg_restore"
export PATH="$W/bin:$PATH"

echo "== 0. syntax with $(basename "$SHELL_UNDER_TEST")"
"$SHELL_UNDER_TEST" -n "$SRC"; check "sh -n" 0 $?

echo "== 1. seconds_until (function extracted)"
sed -n '/^seconds_until()/,/^}/p' "$SRC" > "$W/su.sh"
su() { FAKE_NOW="$1" BACKUP_TIME="$2" "$SHELL_UNDER_TEST" -c ". '$W/su.sh'; seconds_until"; }
check "now 02:00:00 -> 02:30 = 1800" 1800 "$(su 02:00:00 02:30)"
check "now 02:30:00 -> 02:30 = 86400 (already past)" 86400 "$(su 02:30:00 02:30)"
check "now 02:29:59 -> 02:30 = 1" 1 "$(su 02:29:59 02:30)"
check "now 23:59:59 -> 00:00 = 1" 1 "$(su 23:59:59 00:00)"
check "now 00:00:00 -> 00:00 = 86400" 86400 "$(su 00:00:00 00:00)"
check "now 08:09:07 -> 09:08 (leading zeros) = 3533" 3533 "$(su 08:09:07 09:08)"
check "now 12:00:00 -> 08:05 next day = 72300" 72300 "$(su 12:00:00 08:05)"

echo "== 2. once: success, umask, prune"
export BACKUP_DIR="$W/backups" BACKUP_KEEP_DAYS=14 PGDATABASE=x
touch -d '20 days ago' "$W/backups/processpoll-20200101T000000Z.dump"
touch -d '3 days ago'  "$W/backups/processpoll-20200102T000000Z.dump"
touch -d '3 days ago'  "$W/backups/.processpoll-old.123.dump.tmp"
touch "$W/backups/unrelated.txt"; touch -d '30 days ago' "$W/backups/unrelated.txt"
"$SHELL_UNDER_TEST" "$SRC" once > "$W/out.txt" 2>&1; check "exit 0" 0 $?
n=$(ls "$W/backups"/processpoll-*.dump | wc -l | tr -d ' ')
check "new dump + recent one kept, 20-day-old pruned" 2 "$n"
check "stale tmp removed" 0 "$(ls -a "$W/backups" | grep -c '\.dump\.tmp')"
check "unrelated file untouched" 1 "$(ls "$W/backups" | grep -c unrelated.txt)"
check "umask seen by pg_dump is 0077 (dumps are mode 0600)" 0077 "$(cat "$W/umask.txt")"
grep -q pruned "$W/out.txt" && echo "  ok   prune logged" || { echo "  FAIL prune not logged"; fails=$((fails+1)); }

echo "== 3. failing pg_dump / failing verification leave no file and exit 1"
before=$(ls -a "$W/backups" | wc -l)
FAKE_DUMP_FAIL=1 "$SHELL_UNDER_TEST" "$SRC" once > "$W/out.txt" 2>&1; check "pg_dump failure exit 1" 1 $?
FAKE_VERIFY_FAIL=1 "$SHELL_UNDER_TEST" "$SRC" once > "$W/out.txt" 2>&1; check "verify failure exit 1" 1 $?
check "no leftovers" "$before" "$(ls -a "$W/backups" | wc -l)"

echo "== 4. usage error"
"$SHELL_UNDER_TEST" "$SRC" bogus > "$W/out.txt" 2>&1; check "bogus arg exit 2" 2 $?

echo; echo "FAILURES: $fails"; exit "$fails"
