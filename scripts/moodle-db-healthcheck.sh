#!/usr/bin/env bash

set -euo pipefail

DEFAULT_CONFIG="/home/moodle.eagles.edu.vn/app/config.php"
CFG_PATH="${1:-$DEFAULT_CONFIG}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    die "Run this check as root so it can read Moodle's config.php and connect to MariaDB."
  fi
}

cfg_value() {
  local key="$1"
  sed -nE "s/^\\\$CFG->${key}[[:space:]]*=[[:space:]]*'([^']*)'.*/\\1/p" "$CFG_PATH" | head -n 1
}

require_root
[ -r "$CFG_PATH" ] || die "Cannot read Moodle config file: $CFG_PATH"

dbtype="$(cfg_value dbtype)"
dbhost="$(cfg_value dbhost)"
dbname="$(cfg_value dbname)"
dbuser="$(cfg_value dbuser)"
dbpass="$(cfg_value dbpass)"
wwwroot="$(cfg_value wwwroot)"

[ -n "$dbtype" ] || die "Could not parse dbtype from $CFG_PATH"
[ -n "$dbhost" ] || die "Could not parse dbhost from $CFG_PATH"
[ -n "$dbname" ] || die "Could not parse dbname from $CFG_PATH"
[ -n "$dbuser" ] || die "Could not parse dbuser from $CFG_PATH"
[ -n "$dbpass" ] || die "Could not parse dbpass from $CFG_PATH"

case "$dbtype" in
  mariadb|mysqli|mysql)
    ;;
  *)
    die "Unsupported Moodle dbtype '$dbtype' in $CFG_PATH"
    ;;
esac

tmp_cnf="$(mktemp)"
cleanup() {
  rm -f "$tmp_cnf"
}
trap cleanup EXIT

{
  echo "[client]"
  echo "host=${dbhost}"
  echo "user=${dbuser}"
  echo "password=${dbpass}"
  echo "database=${dbname}"
  echo "connect-timeout=5"
} >"$tmp_cnf"
chmod 600 "$tmp_cnf"

protocol_args=()
case "$dbhost" in
  127.0.0.1|localhost)
    protocol_args+=(--protocol=tcp)
    ;;
esac

mysql --defaults-extra-file="$tmp_cnf" "${protocol_args[@]}" --batch --skip-column-names -e "SELECT 1;" >/dev/null

threads_connected="$(
  mysql --defaults-extra-file="$tmp_cnf" "${protocol_args[@]}" --batch --skip-column-names \
    -e "SHOW GLOBAL STATUS LIKE 'Threads_connected';" | awk '{print $2}' | tail -n 1
)"
threads_running="$(
  mysql --defaults-extra-file="$tmp_cnf" "${protocol_args[@]}" --batch --skip-column-names \
    -e "SHOW GLOBAL STATUS LIKE 'Threads_running';" | awk '{print $2}' | tail -n 1
)"

echo "OK: Moodle DB reachable for ${wwwroot:-unknown}"
echo "DB: ${dbtype} @ ${dbhost} / ${dbname}"
echo "Threads_connected=${threads_connected:-unknown} Threads_running=${threads_running:-unknown}"
