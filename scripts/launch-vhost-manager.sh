#!/usr/bin/env bash
set -euo pipefail

APP_URL="http://127.0.0.1:4310"
SERVICE="renew-dev-ssl-vhost-manager.service"

show_error() {
  /usr/bin/zenity --error --title="Vhost Manager" --text="$1" 2>/dev/null || \
    /usr/bin/notify-send "Vhost Manager" "$1" 2>/dev/null || true
}

if ! /usr/bin/curl --fail --silent --max-time 1 --output /dev/null "${APP_URL}/api/status"; then
  if ! /usr/bin/sudo -n /usr/bin/systemctl start "$SERVICE"; then
    show_error "Could not start the root Vhost Manager service. Check sudo authorization and systemd logs."
    exit 1
  fi
fi

for _ in {1..40}; do
  if /usr/bin/curl --fail --silent --max-time 1 --output /dev/null "${APP_URL}/api/status"; then
    /usr/bin/xdg-open "$APP_URL" >/dev/null 2>&1 &
    exit 0
  fi
  /usr/bin/sleep 0.25
done

show_error "The Vhost Manager did not become ready. Inspect it with: sudo journalctl -u ${SERVICE}"
exit 1
