#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install -D -o root -g root -m 0755 \
  "${deploy_dir}/expire_manual_dns_logs.py" \
  /usr/local/libexec/expire-manual-dns-logs
install -D -o root -g root -m 0644 \
  "${deploy_dir}/expire-manual-dns-logs.service" \
  /etc/systemd/system/expire-manual-dns-logs.service
install -D -o root -g root -m 0644 \
  "${deploy_dir}/expire-manual-dns-logs.timer" \
  /etc/systemd/system/expire-manual-dns-logs.timer
systemd-analyze verify \
  /etc/systemd/system/expire-manual-dns-logs.service \
  /etc/systemd/system/expire-manual-dns-logs.timer
systemctl daemon-reload
systemctl enable --now expire-manual-dns-logs.timer
systemctl start expire-manual-dns-logs.service
