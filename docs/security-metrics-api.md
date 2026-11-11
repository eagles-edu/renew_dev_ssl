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
    "serverErrors": 0,
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
- `serverErrors` counts origin Nginx responses with HTTP status 500 through 599 in the trailing 24-hour window. It is separate from attack signals and denial counts.
- `activeBlocks` counts unique IPs with an active CrowdSec IP-scope decision or a local permanent-ban entry. It does not estimate packets dropped by the firewall.
- Permanent SSH brute-force IPs from `/var/lib/crowdsec/permanent-ssh-bans.txt` and permanent web attack IPs from `/var/lib/crowdsec/permanent-web-attack-bans.txt` are included in `activeBlocks` and marked `permanent` in `topSources`; web bans remain enforced after CrowdSec decisions expire.
- `sources.web.permanentBanCount` reports the number of persisted web attack IPs. CrowdSec HTTP security alerts and AppSec virtual-patch exploit alerts are synchronized to nftables and Nginx; trusted OneShield proxy ranges are excluded.
- `topSources` contains IPs associated with attack signals or active decisions, with request counts, last-seen time, and country from Nginx logs, CrowdSec decisions, or the local GeoIP country database.
- `countries` groups logged country data and locally resolved countries for attack sources. The endpoint performs no external IP lookups. Without the local database, unknown countries remain explicit.

The endpoint reads Nginx access logs and CrowdSec decisions using fixed local paths and fixed commands. GeoIP lookups use `/usr/bin/geoiplookup` with `/usr/share/GeoIP/GeoIP.dat` for IPv4 and `/usr/share/GeoIP/GeoIPv6.dat` for IPv6; they run on the server and are cached by source IP. The endpoint never returns raw log lines or request query strings.

## Dashboard time series and breakdowns

### Problem statement

Zero activity is hard to interpret without source freshness, and the dashboard does not expose the time-series and country breakdowns needed to review origin activity.

### Success statement

An operator can tell a genuine quiet period from stale or unavailable telemetry, review origin blocks and traffic in three tabs, adjust chart ranges, and identify known countries with flags, names, and ISO codes. Values identify their source and timezone; unavailable history and country data remain explicit.

### Deferred follow-up

Plan OneShield edge analytics after the origin freshness, blocks, charts, and country/attack breakdown work is complete and verified. Keep edge and origin counts separate, and give the edge integration its own problem and success statements before implementation.

- `sources.nginx.lastEventAt` and `sources.ssh.lastEventAt` report the latest parsed event timestamp; `available` only means the source can be read. The UI displays availability and event freshness separately in UTC+7.
- `summary.successfulLogins` counts accepted SSH password and public-key logins from `ssh.service` journal entries in the last 24 hours.
- `hourly` contains UTC-hour buckets with requests, normal requests, attack signals, denials, server errors, SSH failures, SSH successes, attack-type counts, and active-block snapshots. The dashboard persists up to 168 hours in its private local state file. History starts when this collection is enabled; missing earlier buckets are not reconstructed.
- `countries` ranks countries found in retained Nginx log country fields and locally resolves the 2,000 highest-request source IPs for retained normal-traffic attribution. `retainedNormalRequests` supports the normal-traffic country table, and `lifetimeAttackSignals` supports attack-source ranking. Country flags are shown only for valid ISO alpha-2 codes.
- `attackTypes` counts retained-log matches for exploit paths, scanner user agents, and unusual HTTP methods. These are classified signals, not confirmed malicious activity. Counts cover retained logs available to the dashboard.
- Block timestamps use decision creation time when CrowdSec supplies it. Permanent IP-only ban files have no per-entry timestamp, so the UI identifies those as active at the current snapshot rather than inventing a ban time.

These are origin and host metrics. OneShield edge requests, WAF blocks, rate-limit events, and edge HTTP 5xx responses are not included unless a verified OneShield export is connected. Keep edge status and origin status separate; an edge 502 is an availability failure and does not by itself establish an attack or an origin Nginx 5xx.
