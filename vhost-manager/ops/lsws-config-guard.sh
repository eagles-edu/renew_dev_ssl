#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG=${LSWS_GUARD_CONFIG:-/usr/local/lsws/conf/httpd_config.conf}
BACKUP=${LSWS_GUARD_BACKUP:-/usr/local/lsws/conf/httpd_config.conf.known-good}
ARCHIVE_DIR=${LSWS_GUARD_ARCHIVE_DIR:-/usr/local/lsws/conf/guard-recovery}
LSWS_BIN=${LSWS_GUARD_BINARY:-/usr/local/lsws/bin/openlitespeed}

log() {
  logger -t lsws-config-guard -- "$*" || true
}

valid_shape() {
  [[ -s "$1" ]] &&
    grep -Eiq '^[[:space:]]*errorlog[[:space:]]+' "$1" &&
    grep -Eiq '^[[:space:]]*listener[[:space:]]+' "$1"
}

validate_active() {
  valid_shape "$CONFIG" && "$LSWS_BIN" -t >/dev/null 2>&1
}

save_known_good() {
  local temp
  temp=$(mktemp "${BACKUP}.tmp.XXXXXX")
  trap 'rm -f -- "$temp"' RETURN
  cp -a -- "$CONFIG" "$temp"
  mv -fT -- "$temp" "$BACKUP"
  trap - RETURN
}

restore_known_good() {
  local temp
  temp=$(mktemp "${CONFIG}.restore.XXXXXX")
  trap 'rm -f -- "$temp"' RETURN
  cp -a -- "$BACKUP" "$temp"
  mv -fT -- "$temp" "$CONFIG"
  trap - RETURN
}

if validate_active; then
  save_known_good
  log "validated and snapshotted $CONFIG"
  exit 0
fi

log "invalid OpenLiteSpeed config detected at $CONFIG"
if [[ ! -s "$BACKUP" ]]; then
  log "no known-good snapshot at $BACKUP; refusing automatic replacement"
  exit 1
fi

mkdir -p -- "$ARCHIVE_DIR"
chmod 0700 "$ARCHIVE_DIR"
if [[ -e "$CONFIG" ]]; then
  stamp=$(date '+%Y%m%dT%H%M%S%z')
  cp -a -- "$CONFIG" "$ARCHIVE_DIR/httpd_config.conf.invalid.$stamp"
fi

restore_known_good
if ! validate_active; then
  log "restored snapshot failed validation; leaving it in place for diagnosis"
  exit 1
fi

log "restored validated snapshot from $BACKUP to $CONFIG"
