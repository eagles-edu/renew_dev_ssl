# CrowdSec SSH and Nginx acquisition

SSH is disabled on this host; do not enable it as part of web attack response. The older SSH journal scenario and its persistent set are separate from the web policy below.

## Permanent web attack bans

Every unsimulated, IP-scoped CrowdSec HTTP security alert with remediation enabled is a permanent ban. This includes reconnaissance/probing, login brute force, backdoor scans, and other installed `crowdsecurity/http-*` scenarios. Every CrowdSec AppSec virtual-patch (`crowdsecurity/vpatch-*`) exploit alert also becomes a permanent ban. The synchronizer checks alerts every 30 seconds and stores each source in `/var/lib/crowdsec/permanent-web-attack-bans.txt`, a no-timeout nftables set, and an Nginx IP map. Nginx enforces the map using the client address after trusted OneShield `X-Forwarded-For` processing, so requests through the proxy are blocked by client IP. The direct-origin nftables set also covers traffic that bypasses OneShield.

Never ban an address inside the trusted OneShield ranges: WAF events can report the proxy address instead of the original client. Those ranges are read from the same Nginx trust snippet by the synchronizer. If the snippet is missing or has no trusted ranges, the synchronizer fails closed and does not add detections.

Verified crawler networks from Sefinek's `all-crawlers-ips.txt` feed are also excluded from permanent bans. A daily updater stores accepted CIDRs in `/var/lib/crowdsec/trusted-crawler-cidrs.txt`, generates an Nginx `geo` include, validates and reloads Nginx when the list changes, then runs the ban synchronizer. ModSecurity and Nginx request-rate limits remain enabled. This is a permanent-ban exception only; it does not trust crawler User-Agent strings or bypass request inspection.

The feed is third-party curated. Its parser rejects malformed entries, non-global networks, ranges broader than IPv4 `/8` or IPv6 `/16`, and lists with fewer than 500 networks. A failed download, parse, or Nginx validation retains the last accepted list. Existing permanent bans matching accepted crawler networks are removed from durable state, Nginx, and nftables. If an address later leaves the feed, a retained qualifying CrowdSec alert can make it eligible for a permanent ban again.

Install or update the web policy as root. Preserve the runtime ban list if it already exists:

```bash
sudo install -o root -g root -m 0644 deploy/nginx/oneshield-realip.conf /etc/nginx/snippets/oneshield-realip.conf
sudo install -o root -g root -m 0644 deploy/nginx/geoip-country-map.conf /etc/nginx/snippets/geoip-country-map.conf
sudo install -o root -g root -m 0644 deploy/nginx/geoip-country-block.conf /etc/nginx/snippets/geoip-country-block.conf
if ! sudo test -e /var/lib/crowdsec/permanent-web-attack-bans.txt; then sudo install -o root -g root -m 0600 deploy/crowdsec/permanent-web-attack-bans.txt /var/lib/crowdsec/permanent-web-attack-bans.txt; fi
if ! sudo test -e /var/lib/crowdsec/permanent-web-attack-map.conf; then sudo install -o root -g root -m 0640 /dev/null /var/lib/crowdsec/permanent-web-attack-map.conf; fi
if ! sudo test -e /var/lib/crowdsec/trusted-crawler-cidrs.txt; then sudo install -o root -g root -m 0644 /dev/null /var/lib/crowdsec/trusted-crawler-cidrs.txt; fi
if ! sudo test -e /var/lib/crowdsec/trusted-crawler-map.conf; then sudo install -o root -g root -m 0644 /dev/null /var/lib/crowdsec/trusted-crawler-map.conf; fi
sudo install -o root -g root -m 0755 deploy/crowdsec/permanent-web-attack-bans.py /usr/local/sbin/renew-ssl-permanent-web-attack-bans.py
sudo install -o root -g root -m 0644 deploy/crowdsec/renew-permanent-web-attack-bans.service /etc/systemd/system/renew-permanent-web-attack-bans.service
sudo install -o root -g root -m 0644 deploy/crowdsec/renew-permanent-web-attack-bans.timer /etc/systemd/system/renew-permanent-web-attack-bans.timer
sudo install -o root -g root -m 0755 deploy/crowdsec/update-trusted-crawler-ranges.py /usr/local/sbin/renew-ssl-update-trusted-crawler-ranges.py
sudo install -o root -g root -m 0644 deploy/crowdsec/update-trusted-crawler-ranges.service /etc/systemd/system/update-trusted-crawler-ranges.service
sudo install -o root -g root -m 0644 deploy/crowdsec/update-trusted-crawler-ranges.timer /etc/systemd/system/update-trusted-crawler-ranges.timer
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl start update-trusted-crawler-ranges.service
sudo systemctl enable --now renew-permanent-web-attack-bans.timer update-trusted-crawler-ranges.timer
```

The crawler updater is scheduled daily at 03:00 host time. Run it manually after an upstream or Nginx configuration incident; it retains the previous trusted list if it cannot safely install a new one.

Verify the permanent path and dashboard:

```bash
sudo systemctl is-active crowdsec-firewall-bouncer.service renew-permanent-web-attack-bans.timer
sudo cat /var/lib/crowdsec/permanent-web-attack-bans.txt
sudo nft list table inet renew_web_permanent
sudo nginx -T 2>/dev/null | rg 'permanent_web_attack_ban|real_ip_recursive on'
sudo systemctl is-active update-trusted-crawler-ranges.timer
sudo systemctl list-timers update-trusted-crawler-ranges.timer
sudo wc -l /var/lib/crowdsec/trusted-crawler-cidrs.txt
sudo journalctl -u update-trusted-crawler-ranges.service -n 50 --no-pager
curl -fsS http://127.0.0.1:4310/api/security
```

To intentionally release a web source, add its exact IP to `/var/lib/crowdsec/permanent-web-attack-releases.txt`. The next sync removes it from persistent state, both nftables sets, and the Nginx map despite its historical CrowdSec alert. Remove it from the release file only if the permanent ban should apply again. Remove its current CrowdSec decision separately if that temporary decision is still active.

Install or update the checked-in sources as root, preserving the host's existing configuration before replacing it:

```bash
sudo install -o root -g root -m 0640 deploy/crowdsec/sshd-journald.yaml /etc/crowdsec/acquis.d/sshd-journald.yaml
sudo install -o root -g root -m 0640 deploy/crowdsec/nginx-access.yaml /etc/crowdsec/acquis.d/nginx-access.yaml
sudo install -o root -g root -m 0640 deploy/crowdsec/appsec.yaml /etc/crowdsec/acquis.d/appsec.yaml
sudo install -o root -g root -m 0640 deploy/crowdsec/ssh-five-failures-24h.yaml /etc/crowdsec/scenarios/local-ssh-slow-bruteforce.yaml
sudo install -o root -g root -m 0640 deploy/crowdsec/profiles.yaml /etc/crowdsec/profiles.yaml
sudo install -o root -g root -m 0755 deploy/crowdsec/permanent-ssh-bans.py /usr/local/sbin/renew-ssl-permanent-ssh-bans.py
sudo install -o root -g root -m 0600 deploy/crowdsec/permanent-ssh-bans.txt /var/lib/crowdsec/permanent-ssh-bans.txt
sudo install -o root -g root -m 0644 deploy/crowdsec/renew-permanent-ssh-bans.service /etc/systemd/system/renew-permanent-ssh-bans.service
sudo install -o root -g root -m 0644 deploy/crowdsec/renew-permanent-ssh-bans.timer /etc/systemd/system/renew-permanent-ssh-bans.timer
sudo /usr/bin/crowdsec -c /etc/crowdsec/config.yaml -t
sudo systemctl restart crowdsec.service
sudo systemctl daemon-reload
sudo systemctl enable --now renew-permanent-ssh-bans.service renew-permanent-ssh-bans.timer
```

Check the live ingestion, decisions, and bouncer:

```bash
sudo cscli metrics show acquisition
sudo cscli metrics show scenarios
sudo cscli decisions list
sudo systemctl is-active crowdsec.service crowdsec-firewall-bouncer.service
sudo systemctl is-active renew-permanent-ssh-bans.timer
nft list table inet renew_ssh_permanent
```

The permanent set blocks matching sources on inbound and forwarded traffic. To release an IP, remove it from the persistent list and both nftables sets, then remove its CrowdSec decision if still active. Do not delete only the CrowdSec decision; the persistent set is intentionally independent.

The Nginx source covers access logs under `/var/log/nginx/` whose names include `access` and end in `.log`. Keep the AppSec source in its own acquisition file so it does not obscure the Nginx file source.
