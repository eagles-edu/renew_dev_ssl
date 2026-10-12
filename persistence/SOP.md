# Standard operating procedures

## Start a coding session

Use `hermes -p renew-ssl-coding` for agent-driven coding and keep the Codex app-server runtime selected.
Read `persistence/AGENTS.md` and search the four persistence files before non-trivial work.

## CuratorMD

Use the absolute project root with CuratorMD status, snapshot, search, and curation commands.
Review ambiguous or conflicting candidates; do not commit automatically.

## Configure OneShield with origin controls

**Added:** 2026-10-11

## Configure OneShield with origin controls

**Beginning — trigger and context:** The user asked to set up OneShield so it complements the origin security stack and does not conflict with Nginx redirects, CrowdSec permanent web bans, trusted proxy handling, or website delivery. The user then requested a reusable SOP and corrected an earlier proposal that mistakenly described browser sign-in rather than OneShield configuration.

**Middle — decisions and work:** Use the OneShield request-flow reference and inventory the exact zone, hostnames, DNS records, origin vhosts, certificate SANs, redirects, and existing origin controls before changing the portal. Keep the root zone under its current OneShield nameservers and preserve the intended A/CNAME host aliases; DNS delegation does not repair edge Host/SNI routing. Prefer Standard mode as the baseline. Use Advanced only for a documented need, review the active edge rules and their order, and stage targeted WAF rules in Log before Challenge or Block. Use Full (Strict) only when the origin has a valid certificate covering each hostname; keep TLS 1.2 minimum and TLS 1.3 enabled. Since this host already redirects HTTP to HTTPS in Nginx, leave OneShield's extra HTTPS redirect off. Cache only public content and static assets; bypass authenticated, session-dependent, administrative, and API traffic. Keep trusted proxy ranges current and never permanently ban OneShield proxy IPs at the origin. Avoid overlapping edge country or rate rules with existing origin policies unless the effect is deliberate. For the known www.obgyn.eaglesvn.club edge 404, retain the restored CNAME and have iNET inspect/provision the nested hostname route; the protected-A test did not fix it, and a new DNS zone will not supply the edge route.

**End — outcome and verification:** The host audit verified valid Let's Encrypt origin certificates for eaglesvn.club/www.eaglesvn.club and obgyn.eaglesvn.club/www.obgyn.eaglesvn.club, active HTTP-to-HTTPS redirects in Nginx, and working 200 responses for eaglesvn.club, www.eaglesvn.club, and obgyn.eaglesvn.club. www.obgyn.eaglesvn.club still returns an edge 404 while direct-origin requests return 200. OnePortal remains unauthenticated, so no portal settings have been changed or verified yet. The SOP is ready for review; perform the portal steps only after the user signs in and verify each saved setting and hostname afterward.

**Rationale:** OneShield and origin controls act at different points in the request path. The sequence prevents an edge configuration from bypassing or duplicating verified origin controls.

**Future utility:** This gives future setup work a repeatable order that accounts for the origin's actual TLS, redirect, proxy identity, and permanent-ban controls while distinguishing DNS resolution from OneShield edge hostname routing.

**Project impact:** Observed: origin certificates cover both sites and all four hostnames, Nginx owns HTTPS redirects, and the nested www hostname fails only at OneShield edge. Expected: following the inventory and staged-change procedure should avoid redirect loops, false-positive blocks, unsafe cache behavior, and unverified DNS workarounds.

**Follow-up:** After portal authentication, inspect the current settings for eaglesvn.club, apply the documented safe baseline, troubleshoot the www.obgyn edge route with its request ID, and verify public HTTPS and origin logs per hostname.

**Verification:** Observed: origin certificates cover both sites and all four hostnames, Nginx owns HTTPS redirects, and the nested www hostname fails only at OneShield edge. Expected: following the inventory and staged-change procedure should avoid redirect loops, false-positive blocks, unsafe cache behavior, and unverified DNS workarounds.

<!-- curatormd:record_id=b25e4a11fc2195d2d02369191c4da21c;content_sha256=8794a55a63c6a934f0fced86f11adab7a318240fb13df5f9e80e7977f6cdaac6 -->
<!-- curatormd:fingerprint=d5c37909d96886936e449c896a0b903169fb02162f0465ed62510d6b5cfd8f95 -->

## Authenticate OnePortal with a saved profile

**Added:** 2026-10-11

## Authenticate OnePortal with a saved profile

**Beginning — trigger and context:** OneShield setup stalled because the browser was unauthenticated, users could not see the isolated Playwright session, and prior profile-setup links had expired before they could be used. The user wants a browser login procedure that leaves a reusable authenticated session for subsequent OnePortal configuration.

**Middle — decisions and work:** Use the existing TinyFish Browser Context Profile for OnePortal rather than an isolated Playwright tab or a temporary automation widget. First call tinyfish_list_profiles and reuse the existing profile that will hold the sign-in; avoid creating duplicate profiles. Start a fresh tinyfish_start_profile_setup_session for that profile with the exact OnePortal target URL. Give the returned setup_url to the user immediately. In that handoff page, the user signs in directly and clicks Save profile; never ask for credentials in chat. After the user reports saving, call tinyfish_list_profiles and verify inet.vn appears in signed_in_sites for the same profile. Only then run OnePortal automation with use_profile=true and that exact profile_id. If a handoff expires, create a new setup session for the same profile and discard the old link. Do not treat Playwright's browser tab or a completed TinyFish run as a saved sign-in, and do not repeat profile setup after the profile records the sign-in.

**End — outcome and verification:** A fresh setup handoff has now been generated for the existing OnePortal profile and targets the eaglesvn.club OneShield DNS page. The handoff has not yet been completed by the user, and signed_in_sites remains empty, so no authenticated portal automation or settings change has been verified. The procedure's create-link and target-URL steps are verified; profile save and subsequent authenticated use remain pending user sign-in.

**Rationale:** A live page visible in an automation widget does not itself demonstrate that its cookies were saved into a reusable Browser Context Profile. The dedicated setup handoff and explicit profile-state check provide that evidence.

**Future utility:** This defines the supported browser-context persistence sequence and the verification gate needed to avoid stale links, invisible temporary browsers, repeated login attempts, and automation against the wrong account session.

**Project impact:** Observed: OnePortal URLs redirect to SSO in unauthenticated browser contexts; creating a setup session returns a dedicated handoff URL, and automation tools require the saved profile ID for authenticated reuse. Expected: saving and verifying one persistent profile should make subsequent OneShield tasks repeatable without repeated authentication setup.

**Follow-up:** The user should open the fresh setup_url, sign in, click Save profile, and report completion. Then confirm inet.vn in the OnePortal profile's signed_in_sites before resuming portal configuration.

**Verification:** Observed: OnePortal URLs redirect to SSO in unauthenticated browser contexts; creating a setup session returns a dedicated handoff URL, and automation tools require the saved profile ID for authenticated reuse. Expected: saving and verifying one persistent profile should make subsequent OneShield tasks repeatable without repeated authentication setup.

<!-- curatormd:record_id=91c4a4e54f5ebe3f336973bd587d863a;content_sha256=bbf919d8e1175dc587b22c8d169951f1705acb73c2d36d7f83f8188b84b2c354 -->
<!-- curatormd:fingerprint=796303e706fc8cd5e1003a5a4e1a247cad38a460b34c9ca138d70b82012d2394 -->

## Restrict origin HTTP and HTTPS to the OneShield proxy ranges

**Added:** 2026-10-12

## Restrict origin HTTP and HTTPS to the OneShield proxy ranges

**Beginning — trigger and context:** The user asked to align and augment this web-origin machine after iNET identified an unresolved OneShield edge hostname route. The origin firewall accepted public web connections from any source on IPv4 and IPv6, allowing direct requests to bypass OneShield. The iNET OneShield documentation says to allow its six IPv4 entries and six IPv6 entries and notes that ranges may change. Both origin certificates use DNS-01 validation.

**Middle — decisions and work:** Added a standalone nftables inet input chain at priority -15 that drops TCP ports 80 and 443 arriving on eth0 or eth1 unless the source matches the six current iNET IPv4 entries or six IPv6 entries. Kept the firewall in its own table, separate from iptables-nft, CrowdSec bans, and Vhost Manager rules. Added deploy/oneshield/origin-firewall.nft, a boot-enabled systemd unit ordered before Nginx, and deployment/update instructions. Installed and enabled the unit on the machine without touching SSH or the system-wide nftables service.

**End — outcome and verification:** The nftables config check passed, the systemd unit verified, the origin firewall service is active and enabled, and its installed IPv4/IPv6 sets exactly match all ranges in Nginx's OneShield real-IP trust configuration. Nginx configuration test passed with an existing protocol-options warning. Browser-style public HTTPS checks returned 200 for eaglesvn.club, www.eaglesvn.club, and obgyn.eaglesvn.club through OneShield; www.obgyn.eaglesvn.club still returns the known edge 404. The drop counters are zero, so an external direct-origin denial was not independently exercised. The firewall currently limits only TCP 80/443 on the two public NICs; it does not configure a provider firewall.

**Rationale:** An independent nftables table provides a persistent network-layer boundary that blocks direct-origin web traffic before it can bypass OneShield, while keeping existing CrowdSec and Vhost Manager rules intact. DNS-01 means public ACME HTTP challenge access is unnecessary.

**Future utility:** When OneShield is enabled on this host, use the dedicated nftables table and systemd unit rather than changing the shared iptables-managed chains or enabling the global nftables service. Keep the published iNET ranges synchronized with Nginx trust ranges and verify the edge hostnames after each update.

**Project impact:** Observed: the table is active, boot-enabled, and has exactly the same IPv4 and IPv6 entries as Nginx's current trusted-proxy configuration; normal proxied HTTPS still works for three hostnames. Expected: non-OneShield sources reaching the public NICs on TCP 80/443 are dropped before Nginx, preventing direct-origin bypass. No remote negative test was performed because the available checks originated on the same host or traversed OneShield.

**Follow-up:** Recheck iNET's published IP list whenever its service ranges change; update the nftables file and Nginx trusted-proxy snippet together, validate both, reload the firewall table, and retest all four hostnames. Keep the iNET edge route issue for www.obgyn separate from origin firewalling.

**Verification:** Observed: the table is active, boot-enabled, and has exactly the same IPv4 and IPv6 entries as Nginx's current trusted-proxy configuration; normal proxied HTTPS still works for three hostnames. Expected: non-OneShield sources reaching the public NICs on TCP 80/443 are dropped before Nginx, preventing direct-origin bypass. No remote negative test was performed because the available checks originated on the same host or traversed OneShield.

<!-- curatormd:record_id=4cc39cfc70073b782e9d51f497e3ef32;content_sha256=cbe49a38d462b43a56b1e1dc17dfbcd05138f0a4c315bdfcedba0307a123810b -->
<!-- curatormd:fingerprint=c305bbf4d216957cd6a24343cf6f1d54a93d5c71121add39971e84325eadf6e0 -->

## Restrict origin HTTP and HTTPS to the OneShield proxy ranges

**Added:** 2026-10-12

## Restrict origin HTTP and HTTPS to the OneShield proxy ranges

**Beginning — trigger and context:** The user asked to align and augment this web-origin machine after iNET identified an unresolved OneShield edge hostname route. The origin firewall accepted public web connections from any source on IPv4 and IPv6, allowing direct requests to bypass OneShield. The iNET OneShield documentation says to allow its six IPv4 entries and six IPv6 entries and notes that ranges may change. Both origin certificates use DNS-01 validation.

**Middle — decisions and work:** Added a standalone nftables inet input chain at priority -15 that drops TCP ports 80 and 443 arriving on eth0 or eth1 unless the source matches the six current iNET IPv4 entries or six IPv6 entries. Kept the firewall in its own table, separate from iptables-nft, CrowdSec bans, and Vhost Manager rules. Added deploy/oneshield/origin-firewall.nft, a boot-enabled systemd unit ordered before Nginx, and deployment/update instructions. Installed and enabled the unit on the machine without touching SSH or the system-wide nftables service.

**End — outcome and verification:** The nftables config check passed, the systemd unit verified, the origin firewall service is active and enabled, and its installed IPv4/IPv6 sets exactly match all ranges in Nginx's OneShield real-IP trust configuration. Nginx configuration test passed with an existing protocol-options warning. Browser-style public HTTPS checks returned 200 for eaglesvn.club, www.eaglesvn.club, and obgyn.eaglesvn.club through OneShield; www.obgyn.eaglesvn.club still returns the known edge 404. The drop counters are zero, so an external direct-origin denial was not independently exercised. The firewall currently limits only TCP 80/443 on the two public NICs; it does not configure a provider firewall.

**Rationale:** An independent nftables table provides a persistent network-layer boundary that blocks direct-origin web traffic before it can bypass OneShield, while keeping existing CrowdSec and Vhost Manager rules intact. DNS-01 means public ACME HTTP challenge access is unnecessary.

**Future utility:** When OneShield is enabled on this host, use the dedicated nftables table and systemd unit rather than changing the shared iptables-managed chains or enabling the global nftables service. Keep the published iNET ranges synchronized with Nginx trust ranges and verify the edge hostnames after each update.

**Project impact:** Observed: the table is active, boot-enabled, and has exactly the same IPv4 and IPv6 entries as Nginx's current trusted-proxy configuration; normal proxied HTTPS still works for three hostnames. Expected: non-OneShield sources reaching the public NICs on TCP 80/443 are dropped before Nginx, preventing direct-origin bypass. No remote negative test was performed because the available checks originated on the same host or traversed OneShield.

**Follow-up:** Recheck iNET's published IP list whenever its service ranges change; update the nftables file and Nginx trusted-proxy snippet together, validate both, reload the firewall table, and retest all four hostnames. Keep the iNET edge route issue for www.obgyn separate.

**Verification:** Observed: the table is active, boot-enabled, and has exactly the same IPv4 and IPv6 entries as Nginx's current trusted-proxy configuration; normal proxied HTTPS still works for three hostnames. Expected: non-OneShield sources reaching the public NICs on TCP 80/443 are dropped before Nginx, preventing direct-origin bypass. No remote negative test was performed because the available checks originated on the same host or traversed OneShield.

<!-- curatormd:record_id=7615434da2a69c49f1c6c7c586e46b5e;content_sha256=b262ba2a259aeace18f29ee54fb661a9b3504989f6b4a86fadfdf061a7918caa -->
<!-- curatormd:fingerprint=36a2a98da40d1555d180148751705f16faa9de4f5a30c7b13c6f0d1391d931ed -->

## Apply a protected A record for www.obgyn and track its OneShield edge route

**Added:** 2026-10-12

## Apply a protected A record for www.obgyn and track its OneShield edge route

**Beginning — trigger and context:** iNET traced the www.obgyn.eaglesvn.club 404 to a missing OneShield edge hostname route. The record was an unprotected CNAME to obgyn; iNET proposed changing it to a protected A record pointing to the same origin IP used by the protected sites. The user replied ok.

**Middle — decisions and work:** Changed only www.obgyn to an A record for origin 103.72.98.158 with Protection Enabled and a five-minute TTL. Authoritative DNS then returned OneShield edge addresses. Checked each edge IPv4 address and the direct origin: the origin responded 200, while the edge continued returning 404 without an x-osh-dp dataplane header. Updated the support-ticket draft with the verified record state and request IDs, asking iNET to add or refresh the missing hostname route.

**End — outcome and verification:** The last verified portal state is a protected A record for www.obgyn pointing at 103.72.98.158. Public checks still show the other three hostnames serving through OneShield while www.obgyn returns an edge 404; the direct origin serves it. DNS record changes alone did not provision the edge route. The ticket draft is available at docs/inet-oneshield-www-obgyn-404-ticket.txt.

**Rationale:** DNS resolution to OneShield does not prove that OneShield has provisioned a hostname route. Keeping the edge response headers, request ID, direct-origin result, and saved record type together prevents repeating DNS changes that cannot repair a missing edge route.

**Future utility:** Use this procedure when a hostname resolves to OneShield but receives an edge 404: inspect the protected DNS record, test every edge address, compare dataplane headers, test the origin directly, and have iNET repair the hostname route when the edge never reaches a dataplane.

**Project impact:** Observed: changing the record to protected A made the hostname resolve through OneShield but did not fix the edge route. Expected: preserving this diagnosis should reduce repeated DNS edits and keep edge routing problems distinct from origin serving problems.

**Follow-up:** Ask iNET to confirm www.obgyn.eaglesvn.club is provisioned in the active OneShield edge hostname configuration; then retest HTTPS and confirm an x-osh-dp header and successful response.

**Verification:** Observed: changing the record to protected A made the hostname resolve through OneShield but did not fix the edge route. Expected: preserving this diagnosis should reduce repeated DNS edits and keep edge routing problems distinct from origin serving problems.

<!-- curatormd:record_id=d866a32ab69a5ff30a731a8149addb0d;content_sha256=fc4cbabd9171784ee605466ae0c4e8dbc156fcd400d4c6e1f52ee9542f7de993 -->
<!-- curatormd:fingerprint=ceb734295f47603e5e1b7604f23b1e78c20f0e574698f2ec58bfb697b19c62b8 -->

## Verify live inline scripts before updating report-only CSP

**Added:** 2026-10-12

## Verify live inline scripts before updating report-only CSP

**Beginning — trigger and context:** Chrome reported an ignored upgrade-insecure-requests directive, unrecognized Permissions-Policy features, and later an inline-script hash mismatch on eaglesvn.club. The page was loading successfully, and the CSP policy was delivered in report-only mode.

**Middle — decisions and work:** Inspected the active Nginx vhost and the browser response. Removed upgrade-insecure-requests from the eaglesvn.club report-only policy and backed up the vhost. Verified the current page's inline script with Playwright Web Crypto; its SHA-256 was KqRQ7y/aCPklDvvFHUYiQBbfOFpCcPVLryKFdbhYHxs=. Added that exact hash as a separately quoted source in the site's report-only script-src policy, without enabling unsafe-inline or changing the policy to enforcement. The live Permissions-Policy contained only camera, microphone, and geolocation, and the four ad-related feature names did not appear in repository or origin configuration. The current RUM beacon request succeeds in the verification browser; ERR_BLOCKED_BY_CLIENT is local to the reporting browser/client.

**End — outcome and verification:** Nginx syntax validation passed and the service reloaded active. A fresh browser navigation returned HTTP 200 and no CSP console errors. The live page is the Domain Parked | Welcome template. The deployed public_html/index.html has a different inline-script hash from the modified repository boilerplate, so future content/config deployment should recompute the hash from the actual served script. The user-reported RUM block remains browser/client-specific.

**Rationale:** CSP hashes cover exact script bytes, including whitespace. The repository boilerplate and deployed page had different hashes, so the live document had to be inspected and hashed directly rather than copying a digest from another template.

**Project impact:** Observed: the active document's CSP hash warning is gone while the policy remains report-only and restrictive. Expected: recomputing the digest from served content will prevent stale hashes when the parked page is regenerated. The ad-feature warnings were not attributable to the inspected origin header.

**Follow-up:** When served HTML changes, recompute SHA-256 from the exact inline script text and include a separately quoted hash in script-src; validate Nginx and reload, then check the document in a browser. Keep the report-only policy while collecting reports, and do not add unsafe-inline to silence a hash report.

**Verification:** Observed: the active document's CSP hash warning is gone while the policy remains report-only and restrictive. Expected: recomputing the digest from served content will prevent stale hashes when the parked page is regenerated. The ad-feature warnings were not attributable to the inspected origin header.

<!-- curatormd:record_id=963626379ccb42349c4d433304ad2ff8;content_sha256=ed4463a6cb85c5c4810014087a22554d34b7114a7f03fd593d3636613e84d860 -->
<!-- curatormd:fingerprint=a4460465f040abd439ce2cff6cf29d6f8e053189a324102bc517b570dad1d740 -->
