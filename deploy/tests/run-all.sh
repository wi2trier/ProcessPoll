#!/usr/bin/env bash

set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
chmod +x "$HERE"/bin/* 2>/dev/null || true
rc=0
for t in pull-and-restart backup entrypoint; do
  echo "##### $t"
  bash "$HERE/$t-test.sh" "$DEPLOY" || rc=1
done
echo
if [ "$rc" -eq 0 ]; then echo "ALL SCRIPT TESTS PASSED"; else echo "SCRIPT TESTS FAILED"; fi
exit "$rc"
