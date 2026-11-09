#!/usr/bin/env bash

set -euo pipefail

if [ $# -lt 1 ] || [ "${1#-}" != "$1" ]; then
  echo "usage: $0 <image-tag> [--force] [--skip-backup] [--quiet]" >&2
  exit 2
fi

TAG="$1"
shift
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pull-and-restart.sh" --tag "$TAG" "$@"
