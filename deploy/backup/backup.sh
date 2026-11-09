#!/bin/sh

set -eu
umask 077

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BACKUP_TIME="${BACKUP_TIME:-02:30}"

log() {
  printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

clear_demo_dumps() {
  mkdir -p "$BACKUP_DIR"
  rm -f "$BACKUP_DIR"/processpoll-*.dump "$BACKUP_DIR"/.processpoll-*.dump.tmp
}

do_prune() {

  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'processpoll-*.dump' \
    -mtime +"$BACKUP_KEEP_DAYS" -print -delete | while read -r f; do
      log "pruned $f"
    done

  find "$BACKUP_DIR" -maxdepth 1 -type f -name '.processpoll-*.dump.tmp' -mtime +1 -delete
}

do_once() {
  if [ "${PROCESSPOLL_DEMO_MODE:-false}" = "true" ]; then
    clear_demo_dumps
    log "demo mode: backups disabled"
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="$BACKUP_DIR/.processpoll-$ts.$$.dump.tmp"
  final="$BACKUP_DIR/processpoll-$ts.dump"

  log "dumping database '${PGDATABASE:-?}' on '${PGHOST:-local socket}'"
  if ! pg_dump --format=custom --compress=6 --no-owner --no-acl --file="$tmp"; then
    rm -f "$tmp"
    log "ERROR: pg_dump failed"
    return 1
  fi
  if ! pg_restore --list "$tmp" >/dev/null; then
    rm -f "$tmp"
    log "ERROR: dump verification (pg_restore --list) failed"
    return 1
  fi
  mv "$tmp" "$final"
  size="$(wc -c < "$final" | tr -d ' ')"
  log "wrote $final (${size} bytes)"
  do_prune
}

seconds_until() {

  target_h="${BACKUP_TIME%%:*}"
  target_m="${BACKUP_TIME##*:}"
  target_h="${target_h#0}"; target_m="${target_m#0}"
  now_h="$(date -u +%H)"; now_m="$(date -u +%M)"; now_s="$(date -u +%S)"
  now_h="${now_h#0}"; now_m="${now_m#0}"; now_s="${now_s#0}"
  target=$(( ${target_h:-0} * 3600 + ${target_m:-0} * 60 ))
  now=$(( ${now_h:-0} * 3600 + ${now_m:-0} * 60 + ${now_s:-0} ))
  diff=$(( target - now ))
  if [ "$diff" -le 0 ]; then
    diff=$(( diff + 86400 ))
  fi
  echo "$diff"
}

do_loop() {
  if [ "${PROCESSPOLL_DEMO_MODE:-false}" = "true" ]; then
    log "demo mode: removing local database dumps; backups disabled"
    while true; do
      clear_demo_dumps
      sleep 86400
    done
  fi
  log "loop started: daily at ${BACKUP_TIME} UTC, keeping ${BACKUP_KEEP_DAYS} days in ${BACKUP_DIR}"
  while true; do
    wait_s="$(seconds_until)"
    log "next run in ${wait_s} s"
    sleep "$wait_s"

    do_once || log "run failed, will retry at the next scheduled time"

    sleep 61
  done
}

case "${1:-loop}" in
  once)  do_once ;;
  loop)  do_loop ;;
  prune)
    if [ "${PROCESSPOLL_DEMO_MODE:-false}" = "true" ]; then clear_demo_dumps; else do_prune; fi
    ;;
  *)
    echo "usage: $0 [once|loop|prune]" >&2
    exit 2
    ;;
esac
