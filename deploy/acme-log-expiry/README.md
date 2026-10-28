# Manual DNS log expiry

This host-owned cleanup removes only regular files directly under `/var/log`
whose names match `acme-dns-manual-*.log`. It never reads log contents and
does not send them to Curator. The manual renewal script's own redaction remains
in place; expiry is a separate retention control.

The root service runs at 00:00, 06:00, 12:00, and 18:00 with up to fifteen
minutes of randomized spread. It removes files older than 65 hours and 44
minutes, leaving enough margin for the six-hour schedule to enforce the
approved 72-hour maximum during normal timer operation. The service writes only
the number of removed files to the journal.

Install and enable the timer with:

```sh
sudo bash deploy/acme-log-expiry/install.sh
```

Check the service and next run with:

```sh
systemctl status expire-manual-dns-logs.timer
systemctl list-timers expire-manual-dns-logs.timer
journalctl -u expire-manual-dns-logs.service
```

To disable and remove the installed policy:

```sh
sudo systemctl disable --now expire-manual-dns-logs.timer
sudo rm /etc/systemd/system/expire-manual-dns-logs.timer \
  /etc/systemd/system/expire-manual-dns-logs.service \
  /usr/local/libexec/expire-manual-dns-logs
sudo systemctl daemon-reload
```
