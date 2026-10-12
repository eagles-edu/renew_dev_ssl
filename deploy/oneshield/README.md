# OneShield origin firewall

This nftables table restricts public TCP ports 80 and 443 on `eth0` and `eth1`
to iNET OneShield's published IPv4 and IPv6 ranges. It leaves other ports,
loopback/container traffic, and the existing CrowdSec and Vhost Manager tables
untouched. The two configured Let's Encrypt certificates use DNS validation,
so public HTTP-01 access is not required for renewal.

The ranges were verified from iNET's published list on 2026-10-11:
<https://developers.inet.vn/docs/oneportal/oneshield-danh-sach-ip>. iNET says
these ranges can change. When they do, update this file and
`/etc/nginx/snippets/oneshield-realip.conf` together, run `nginx -t`, then
reload this table with `systemctl reload renew-ssl-oneshield-origin-firewall`.
Recheck the public site through OneShield after every change.

Install or refresh from the repository root:

```sh
sudo install -D -m 0644 deploy/oneshield/origin-firewall.nft \
  /etc/nftables.d/oneshield-origin-firewall.nft
sudo install -m 0644 deploy/oneshield/renew-ssl-oneshield-origin-firewall.service \
  /etc/systemd/system/renew-ssl-oneshield-origin-firewall.service
sudo nft -c -f /etc/nftables.d/oneshield-origin-firewall.nft
sudo systemctl daemon-reload
sudo systemctl enable --now renew-ssl-oneshield-origin-firewall.service
```

The unit re-applies the table at boot before Nginx starts. It does not alter
the system-wide `nftables.service` or flush the host ruleset.
