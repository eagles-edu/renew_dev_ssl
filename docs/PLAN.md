# Daily crawler IP exemptions for permanent bans

## Summary

Fetch Sefinek’s `all-crawlers-ips` list once daily and use it as the trusted crawler CIDR source. The feed groups search, SEO, and web-testing crawlers; Sefinek updates its lists every six hours. [Repository details](https://github.com/sefinek/trusted-ips-whitelist#-combined-ip-lists)

The exception will prevent permanent CrowdSec auto-bans for listed IPs. ModSecurity and Nginx rate limits stay active.

## Implementation

- Add a daily updater for `lists/all-crawlers-ips.txt`, scheduled for 03:00 host time. Parse and canonicalize IPv4/IPv6 entries, reject invalid or overly broad ranges, and retain the last known good list if download or validation fails. The feed is maintained by a third party, so the updater must not trust User-Agent strings as proof of identity. Google and Bing document IP-based crawler verification methods. [Google guidance](https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests), [Bing guidance](https://www.bing.com/webmasters/help/verify-bingbot-2195837f)
- Store one canonical local CIDR list. Generate an Nginx `geo` include from it, keyed on the recovered client IP after trusted OneShield proxy handling. Have the permanent-ban synchronizer read that same list and exclude matching CrowdSec HTTP and AppSec alerts.
- On successful updates, automatically remove matching IPs from the existing permanent-ban file, Nginx map, and nftables sets. If a later feed update drops an IP, normal permanent-ban policy may apply again from retained CrowdSec alerts.
- Validate the generated Nginx configuration before reload; reload only when the accepted list changes. Update the existing CrowdSec operations guide with install, status, and recovery steps.

## Tests and acceptance

- Cover valid and invalid CIDRs, IPv4/IPv6 matching, empty or malformed feeds, overly broad ranges, and failed downloads retaining the previous list.
- Verify listed IPs are excluded from new permanent bans and removed from existing durable/runtime bans; unlisted IPs remain eligible for bans.
- Confirm generated Nginx syntax passes before reload, ModSecurity remains enabled, and configured rate limits still apply.

## Assumptions

- The Sefinek `all-crawlers-ips` subset is the chosen source, with daily local refresh.
- The exemption applies only to permanent auto-bans. It does not bypass ModSecurity, request throttles, or other Nginx security rules.
- Existing matching bans are released automatically, as requested.
