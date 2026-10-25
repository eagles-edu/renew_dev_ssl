#!/usr/bin/env bash
set -u

ACME_BIN="${ACME_BIN:-/root/.acme.sh/acme.sh}"
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
VHOST_MANAGER_URL="${VHOST_MANAGER_URL:-http://127.0.0.1:4310}"
VHOST_MANAGER_HOST="${VHOST_MANAGER_HOST:-127.0.0.1:4310}"
CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
LOGGER_BIN="${LOGGER_BIN:-/usr/bin/logger}"
PENDING_DIR="${PENDING_DIR:-/var/lib/vhost-manager/curatormd-v2-pending-ssl-cron}"

mkdir -p -m 0700 "$PENDING_DIR" || exit 1
chmod 0700 "$PENDING_DIR" || exit 1

session_csrf() {
  local session_json
  session_json="$("$CURL_BIN" --fail --silent --show-error --max-time 5 \
    -H "Host: $VHOST_MANAGER_HOST" "$VHOST_MANAGER_URL/api/session" 2>/dev/null)" || return 1
  printf '%s' "$session_json" | "$PYTHON_BIN" -c \
    'import json,sys; print(json.load(sys.stdin)["csrf"])' 2>/dev/null
}

post_result() {
  local csrf="$1" payload_file="$2"
  "$CURL_BIN" --fail --silent --show-error --max-time 25 \
    -X POST -H "Host: $VHOST_MANAGER_HOST" \
    -H "Origin: http://$VHOST_MANAGER_HOST" \
    -H 'Content-Type: application/json' \
    -H "X-CSRF-Token: $csrf" --data-binary "@$payload_file" \
    "$VHOST_MANAGER_URL/api/ssl-cron-result" >/dev/null 2>&1
}

flush_pending() {
  local csrf file
  csrf="$(session_csrf)" || return 0
  for file in "$PENDING_DIR"/*.json; do
    [[ -f "$file" ]] || continue
    if post_result "$csrf" "$file"; then
      rm -f -- "$file"
    fi
  done
}

spool_result() {
  local operation_id="$1" exit_code="$2"
  "$PYTHON_BIN" -c 'import json,os,sys,tempfile; d=sys.argv[1]; name=sys.argv[2]+".json"; fd,tmp=tempfile.mkstemp(prefix=".pending-",dir=d); os.fchmod(fd,0o600); f=os.fdopen(fd,"w"); json.dump({"operationId":sys.argv[2],"exitCode":int(sys.argv[3])},f,separators=(",",":")); f.flush(); os.fsync(f.fileno()); f.close(); os.replace(tmp,os.path.join(d,name)); dirfd=os.open(d,os.O_RDONLY); os.fsync(dirfd); os.close(dirfd)' \
    "$PENDING_DIR" "$operation_id" "$exit_code"
}

flush_pending
operation_id="$(cat /proc/sys/kernel/random/uuid)" || exit 1
if [[ ! -x "$ACME_BIN" || ! -d "$ACME_HOME" ]]; then
  "$LOGGER_BIN" -t renew-ssl-acme-curator "ACME cron skipped: configured client or home is unavailable"
  exit 127
fi

"$ACME_BIN" --cron --home "$ACME_HOME" >/dev/null 2>&1
acme_status=$?
payload_file="$PENDING_DIR/$operation_id.json"
if ! spool_result "$operation_id" "$acme_status"; then
  "$LOGGER_BIN" -t renew-ssl-acme-curator "ACME run completed with exit $acme_status; could not persist Vhost receipt for $operation_id"
  exit "$acme_status"
fi
csrf="$(session_csrf)" || csrf=""
if [[ -n "$csrf" ]] && post_result "$csrf" "$payload_file"; then
  rm -f -- "$payload_file"
else
  "$LOGGER_BIN" -t renew-ssl-acme-curator "ACME run completed with exit $acme_status; Vhost receipt queued for retry: $operation_id"
fi

exit "$acme_status"
