# CrowdSec SSH and Nginx acquisition

CrowdSec must read the SSH systemd journal for SSH authentication failures to reach the enabled SSH scenarios. The local rule blocks an IP after five parsed SSH authentication failures in the dashboard's 24-hour window. Its one-year CrowdSec decision is a fallback; a companion systemd service copies matching alerts into `/var/lib/crowdsec/permanent-ssh-bans.txt` and a no-timeout nftables set, so these SSH brute-force bans persist across CrowdSec decision expiry and reboot. Other IP and range decisions retain their four-hour duration.

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
