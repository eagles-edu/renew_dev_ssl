# Local Security Metrics API

## Contract

`GET /api/security` returns a read-only, loopback-only snapshot for the last 24 hours. The response is cached for up to 30 seconds.

```json
{
  "generatedAt": "2026-10-09T00:00:00.000Z",
  "windowHours": 24,
  "summary": {
    "requests": 0,
    "attackSignals": 0,
    "deniedRequests": 0,
    "failedLogins": 0,
    "activeBlocks": 0,
    "uniqueAttackIps": 0
  },
  "sources": {
    "nginx": {
      "available": true,
      "filesRead": 1,
      "acquisitionConfiguredInCrowdSec": true
    },
    "ssh": { "available": true, "acquisitionConfiguredInCrowdSec": true },
    "crowdsec": { "available": true, "active": true, "bouncerActive": true },
    "geoip": {
      "available": true,
      "reason": null
    }
  },
  "topSources": [],
  "countries": []
}
```

## Counting rules

- `requests` counts parsed Nginx access-log entries within the trailing 24-hour window.
- `attackSignals` counts requests matching common exploit or scanner indicators; it is a signal count, not a confirmed compromise count.
- `failedLogins` counts SSH `Failed password` and `Failed publickey` journal entries within the trailing 24-hour window.
- `sources.ssh.available` reports whether the local SSH journal could be read; `acquisitionConfiguredInCrowdSec` reports whether CrowdSec has the corresponding source configured.
- `deniedRequests` counts Nginx responses with status 401, 403, 429, or 444.
- `activeBlocks` counts unique IPs with an active CrowdSec IP-scope decision. It does not estimate packets dropped by the firewall.
- Permanent SSH brute-force IPs from `/var/lib/crowdsec/permanent-ssh-bans.txt` are also included in `activeBlocks` and marked `permanent` in `topSources`; they remain blocked after CrowdSec decisions expire.
- `topSources` contains IPs associated with attack signals or active decisions, with request counts, last-seen time, and country from Nginx logs, CrowdSec decisions, or the local GeoIP country database.
- `countries` groups logged country data and locally resolved countries for attack sources. The endpoint performs no external IP lookups. Without the local database, unknown countries remain explicit.

The endpoint reads Nginx access logs and CrowdSec decisions using fixed local paths and fixed commands. GeoIP lookups use `/usr/bin/geoiplookup` with `/usr/share/GeoIP/GeoIP.dat` for IPv4 and `/usr/share/GeoIP/GeoIPv6.dat` for IPv6; they run on the server and are cached by source IP. The endpoint never returns raw log lines or request query strings.
