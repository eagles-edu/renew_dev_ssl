# Active project rules

Keep durable knowledge concise, verified, actionable, and local-only.
Never record credentials, tokens, private keys, connection strings, personal data, or raw transcripts.
Use the OpenAI developer documentation MCP server for OpenAI product, API, plugin, or Codex questions.
Use an absolute project root with CuratorMD. Leave curation changes uncommitted for review.
CuratorMD must never add, commit, push, deploy, migrate, delete project data, or modify application source.

- ## Permanent web attack bans behind OneShield with trusted client-IP recovery

**Beginning — trigger and context:** The security dashboard showed high web attack signal counts for multiple source IPs while only one was actively blocked, because ordinary CrowdSec decisions expired. The user reiterated that any repeated web probing, login failures, brute force, or exploit must produce a permanent ban, and clarified that SSH is disabled and outside this work.

**Middle — decisions and work:** The investigation found two separate enforcement gaps: web decisions had no permanent origin set, and Nginx trusted OneShield proxy addresses without recursively resolving the original client from X-Forwarded-For, so WAF events could identify the proxy itself. The implementation enabled recursive real-IP processing for configured trusted OneShield ranges, excluded those ranges from permanent source bans, and added a synchronizer that persists qualifying CrowdSec HTTP and AppSec exploit sources to a durable IP file, an nftables set, and an Nginx client-IP map. It checks every 30 seconds and supports deliberate releases through a separate release file. Bulgaria was added to the origin GeoIP deny map. SSH stayed disabled.

**End — outcome and verification:** The synchronizer was enabled and repeatedly reported 20 permanent web bans enforced in nftables and Nginx. Nginx configuration tests passed; the prior implementation's Python synchronizer tests and Vhost Manager tests passed. The end-to-end curl probe received OneShield's edge `Bad bot detected` 403; the tested source was absent from CrowdSec decisions and the permanent map, so that rejection was not caused by the origin ban. Current host nftables inspection shows INPUT policy `accept` and no shown restriction of ports 80/443 to OneShield, so direct-origin traffic can bypass edge filtering unless a provider firewall blocks it. Edge-only OneShield blocks are not automatically visible to origin CrowdSec without a verified log integration.

**Rationale:** This records the user's permanent web-ban policy, the real-client attribution requirement behind a proxy, the durable enforcement path, and the remaining edge-to-origin visibility and direct-origin firewall limitations.

**Future utility:** Future security changes can preserve the no-expiry web-ban contract, keep SSH disabled, avoid banning trusted OneShield proxy IPs, verify both packet and application enforcement, and distinguish edge blocks from origin CrowdSec events.

**Project impact:** Observed: qualifying origin detections persist beyond CrowdSec decision expiry and are enforced in both nftables and Nginx using the recovered visitor address. Expected: keeping OneShield at the edge and permanent CrowdSec bans at the origin provides layered protection, provided origin web access is restricted to OneShield and edge-only alerts are separately integrated if they must also become permanent.

**Follow-up:** Review the OneShield portal's mode and active rules per domain; consider a carefully staged host-firewall restriction to current OneShield IPv4/IPv6 ranges after validating DNS/proxy coverage and other required web flows. Do not claim OneShield edge detections are permanent at the origin unless event ingestion is implemented and verified.

- **Why:** Future security changes can preserve the no-expiry web-ban contract, keep SSH disabled, avoid banning trusted OneShield proxy IPs, verify both packet and application enforcement, and distinguish edge blocks from origin CrowdSec events.

<!-- curatormd:record_id=fa84db9858a261ef9ee78e67e283cc22;content_sha256=4fef074ae6bc474ad8f8d21d2de97dc4bf45499541475f9c83c60b2b8d35a79d -->
<!-- curatormd:fingerprint=2d7a3e3cab5cdfc8e69aa87259c78b21510877627b2028426a0fd578f7deae37 -->

- ## Document OneShield request paths and origin security boundaries

**Beginning — trigger and context:** The user needed to configure OneShield as a complement to the host's permanent CrowdSec web-ban policy, then asked for real request-flow diagrams, WAF rule behavior, and performance/security best practices. The host uses OneShield in front of Nginx and OpenLiteSpeed, with visitor-IP recovery, country rules, and persistent web bans at the origin.

**Middle — decisions and work:** Compared iNET's documented DNS-only, Standard, and Advanced modes and WAF actions with verified origin behavior. Documented that edge blocks never reach origin CrowdSec; nftables sees the proxy network on proxied requests, while Nginx recovers the visitor IP from trusted X-Forwarded-For and applies visitor bans. Recorded that host nftables currently accepts inbound traffic, that OneShield's active per-domain portal settings were not observable from the host, and that Nginx already redirects HTTP to HTTPS. Added Mermaid diagrams for each mode and WAF action ordering, plus guidance on targeted rules, rate limits, safe caching, strict TLS, trusted proxy ranges, and staged origin firewall restrictions.

**End — outcome and verification:** Added docs/oneshield-request-flows.md with the diagrams and guidance. Prettier validation passed. No OneShield portal or live firewall settings were changed. The document explicitly labels portal configuration as unknown and marks proxy-only origin firewalling as a recommendation requiring DNS, ACME, health-check, and provider-firewall inventory first.

**Rationale:** Preserves the host-specific request path and provider/origin boundary so future WAF, rate-limit, cache, TLS, and firewall decisions do not conflict with permanent visitor bans.

**Future utility:** Future OneShield changes can be checked against a verified traffic path, avoid treating edge blocks as permanent CrowdSec bans, and preserve a safe staged process before restricting direct-origin access.

**Project impact:** Improves security correctness by distinguishing edge enforcement from origin enforcement and preserving visitor identity through the proxy; improves performance and maintainability through scoped caching and rules, measured tuning, and repeatable diagrams.

- **Why:** Future OneShield changes can be checked against a verified traffic path, avoid treating edge blocks as permanent CrowdSec bans, and preserve a safe staged process before restricting direct-origin access.

<!-- curatormd:record_id=a6edf637ff3af4d5689996ede189b10b;content_sha256=76e5d41803c3d6b10bc5a8343d3f3714835e0999eb1e7f33b2382803abb9d519 -->
<!-- curatormd:fingerprint=4b7eefe6d97ee55846e9ae4ed9212b42d678ae998a453bb5b899939029fefad9 -->

- ## Add a full-screen OneShield request-flow viewer

**Beginning — trigger and context:** The user asked for the OneShield request-flow diagrams to open full screen. The existing diagrams were Mermaid blocks in Markdown, where full-screen controls were not reliably available in the reader.

**Middle — decisions and work:** A standalone HTML viewer and a generator script were added. The Markdown Mermaid blocks remain the editable source. The viewer provides per-diagram full-screen controls, zoom, fit, Escape handling, and a CSS full-screen fallback when native browser full screen is unavailable. A package script regenerates the HTML from the Markdown source.

**End — outcome and verification:** Playwright verified that all four diagrams render, full-screen and zoom controls work, Escape exits and restores focus, and the mobile layout has no page-wide horizontal overflow.

**Rationale:** The Markdown viewer did not provide consistent full-screen controls. Generating a browser viewer from the existing Mermaid source adds usable navigation without losing the editable diagrams.

**Future utility:** This records the source-to-viewer workflow and the interaction and mobile checks needed when the diagrams change.

**Project impact:** Observed: the four request-flow diagrams can be expanded and navigated in the generated browser viewer, with a tested mobile layout. Expected: retaining Markdown as the source keeps future flow edits reviewable and reproducible.

**Follow-up:** Regenerate the viewer with npm run docs:oneshield-viewer after editing the Markdown Mermaid blocks, then check rendering, full screen, Escape, zoom, and mobile width.

- **Why:** This records the source-to-viewer workflow and the interaction and mobile checks needed when the diagrams change.

<!-- curatormd:record_id=28675ef0a520ceb421e1a7ac07233e78;content_sha256=5aa08ab95955963d6876b843067b2d2df89d995077488fc77db0dfacb6e614b0 -->
<!-- curatormd:fingerprint=2f87cfa7b0d9eb3980c379d9cf8e22dd036108af27574b0310fd213a91176824 -->

- ## Refresh OneShield request-flow diagrams around the live origin controls

**Beginning — trigger and context:** After the iNET diagnosis proposed changing www.obgyn to origin 103.56.163.145, the user clarified that the production origin is 103.72.98.158 and asked to align the machine with the current OneShield setup. The user then asked for diagrams that show real request flow and rule behavior, organized by layers, with performance and security practices.

**Middle — decisions and work:** Reviewed the full captured OneShield thread, current project guidance, generated diagram viewer, portal state, public HTTPS behavior, and live origin services and configuration. Replaced stale mode-comparison diagrams with a numbered production path from visitor and OneShield DNS through edge routing, origin nftables, Nginx policy, and OpenLiteSpeed; added separate diagrams for origin detection and durable CrowdSec bans and for WAF action behavior. Documented the known edge hostname routing gap for www.obgyn and distinguished an edge 404 from an origin failure. Preserved the correct .158 target and documented why .145 is wrong. Added current evidence boundaries and performance/security practices.

**End — outcome and verification:** Regenerated docs/oneshield-request-flows.html from the three Mermaid diagrams; render command and git diff --check pass. Browser inspection confirmed all three diagrams render and the full-screen viewer controls work. Public HTTPS probes on 2026-10-12 returned 200 for eaglesvn.club, www.eaglesvn.club, and obgyn.eaglesvn.club, and 404 for www.obgyn.eaglesvn.club; iNET's report and absent x-osh-dp header indicate the latter is still rejected before reaching the origin. No DNS or portal changes were made.

**Rationale:** Preserve the current layered request path and the evidence-backed unresolved hostname route issue for future OneShield setup and incident work.

**Future utility:** This records the verified current boundary between OneShield and the origin, the correct .158 production target, and a repeatable way to distinguish edge routing errors from failures that reach Nginx. It also keeps the generated full-screen viewer tied to the Markdown Mermaid source.

**Project impact:** Observed: the diagrams now match the checked live origin firewall, Nginx trust and ban handling, and OpenLiteSpeed path, while clearly exposing the unresolved OneShield route failure. Expected: future diagnosis will separate edge route failures from origin firewall, web policy, and application failures, reducing incorrect origin changes and repeated troubleshooting.

**Follow-up:** iNET still needs to add or repair the www.obgyn.eaglesvn.club edge hostname route; recheck its public response and x-osh-dp header after they confirm the change.

- **Why:** This records the verified current boundary between OneShield and the origin, the correct .158 production target, and a repeatable way to distinguish edge routing errors from failures that reach Nginx. It also keeps the generated full-screen viewer tied to the Markdown Mermaid source.

<!-- curatormd:record_id=68cde88029189de654f1c9ec7481396a;content_sha256=55f1964a676323137fe2f4b75beb02fe2153289d82fc2ea26a81bc0618beb03b -->
<!-- curatormd:fingerprint=c8b5cb836832639ee93c3bd5713ac4b02ba1f108c11e52a88011c2aacba31528 -->
