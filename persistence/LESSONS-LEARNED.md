# Lessons learned

## Keep the generated certificate inventory editable after root refreshes

**Date:** 2026-10-11

**Lesson:** ## Keep the generated certificate inventory editable after root refreshes

**Beginning — trigger and context:** The user reported that DOMAIN_CERTIFICATE_INVENTORY.md could not be read during repository validation. The file contained a modified certificate inventory and was owned by root:root with mode 0640, so the eaglesvn checkout owner could not read or edit it.

**Middle — decisions and work:** Inspection found the inventory generator is intentionally run with sudo and umask 077. It already attempted chown using SUDO_UID/GID, but running from a root login shell can omit those variables, leaving the refreshed output root-owned. Preserved the inventory content, restored owner eaglesvn:eaglesvn and mode 0664, and changed the generator to fall back to the output directory owner when invoked as root without SUDO variables.

**End — outcome and verification:** The inventory is now readable and writable by eaglesvn. bash -n and targeted git diff --check passed. Ran the generator as root with SUDO_UID/GID/USER unset against a temporary fixture and verified that its output was owned by eaglesvn:eaglesvn with mode 0664. The live inventory was not regenerated, so its existing contents stayed intact.

**Rationale:** Records the cause and tested prevention for a recurring file-access failure in a root-run maintenance script.

**Future utility:** When generated files live in a user-owned checkout but a refresh needs root access, preserve the checkout user's ownership even if sudo environment variables are unavailable.

**Project impact:** Observed: the reported permission failure is fixed and a root-login regeneration path now preserves checkout access. Expected: future inventory refreshes will remain reviewable and editable instead of reintroducing root-only ownership.

**Follow-up:** If the inventory generator is run with a custom output directory, ownership follows that directory's owner when root has no SUDO_UID/GID.

**Trigger / root cause:** When generated files live in a user-owned checkout but a refresh needs root access, preserve the checkout user's ownership even if sudo environment variables are unavailable.

**Preventative rule:** Observed: the reported permission failure is fixed and a root-login regeneration path now preserves checkout access. Expected: future inventory refreshes will remain reviewable and editable instead of reintroducing root-only ownership.

<!-- curatormd:record_id=4b909e147de33288e31d152f91ce5462;content_sha256=282673c1543587d18e12520a10103db8272e58e5a9eab8c036adad68aa1b89a8 -->
<!-- curatormd:fingerprint=616166b4f353427d52bc982f68c33538a02abb00791bb1c63c0804e44a0921f1 -->

## Don't use a live TinyFish browser session when OnePortal setup links expire

**Date:** 2026-10-11

**Lesson:** ## Don't use a live TinyFish browser session when OnePortal setup links expire

**Beginning — trigger and context:** Repeated TinyFish profile-setup handoff URLs for OnePortal expired before the user could complete sign-in, blocking the planned OneShield inspection and configuration for eaglesvn.club and obgyn.eaglesvn.club. The user asked whether Hermes was available after another expired-link notice.

**Middle — decisions and work:** Confirmed locally that Hermes Agent v0.21.5 is installed and that the renew-ssl-coding profile is registered and running with OpenAI Codex authentication. This Hermes coding profile is separate from TinyFish's browser-profile setup and does not itself save OnePortal browser authentication. After repeated expired setup handoffs, opened OnePortal in an active TinyFish browser run, which reached the iNET SSO sign-in page without entering credentials or changing portal settings. The user must complete sign-in in the live run before inspection can continue.

**End — outcome and verification:** Verified Hermes installation and the running renew-ssl-coding profile with `hermes --version`, `hermes profile list`, and `hermes -p renew-ssl-coding status`. The TinyFish setup-link failure was unrelated to Hermes availability. A live browser-run link was provided as the workaround; no OnePortal credentials were entered and no OneShield settings were changed. User completion of sign-in remains unverified.

**Rationale:** This captures the separation between Hermes project profiles and TinyFish browser authentication, and preserves a practical recovery path after repeated setup-link expiry.

**Future utility:** For future OnePortal access attempts, verify Hermes independently if asked, but avoid regenerating expired setup handoffs repeatedly; provide the active TinyFish browser run for user sign-in, then verify that the browser profile actually retained authentication before changing OneShield settings.

**Project impact:** Observed: Hermes and the repository-specific profile are installed and running. Repeated setup handoff links expired; an active TinyFish run reached the SSO page. Expected: using the live run avoids relying on the expiring handoff mechanism, while explicit post-login verification prevents mistaking a ready login page for saved authentication.

**Follow-up:** Wait for the user to sign in through the active TinyFish run, then inspect both domain configurations and verify saved browser authentication before making portal changes.

**Trigger / root cause:** For future OnePortal access attempts, verify Hermes independently if asked, but avoid regenerating expired setup handoffs repeatedly; provide the active TinyFish browser run for user sign-in, then verify that the browser profile actually retained authentication before changing OneShield settings.

**Preventative rule:** Observed: Hermes and the repository-specific profile are installed and running. Repeated setup handoff links expired; an active TinyFish run reached the SSO page. Expected: using the live run avoids relying on the expiring handoff mechanism, while explicit post-login verification prevents mistaking a ready login page for saved authentication.

<!-- curatormd:record_id=260d2d9dcfe34587f8808f6fed1976db;content_sha256=be9c47141356518fb05f16d3b81e7862f498b0493e17d1bfdc5d6c5dfe135358 -->
<!-- curatormd:fingerprint=5f746a180ad8f9854326d8229a7c62e4ddd16b1c8cfb326d5a5ba04d260c6eba -->

## OneShield nested www hostname protection and edge routing

**Date:** 2026-10-11

**Lesson:** ## OneShield nested www hostname protection and edge routing

**Beginning — trigger and context:** The OneShield DNS setup followed the same pattern for eaglesvn.club and obgyn.eaglesvn.club: each apex hostname had an A record, and each www hostname was a CNAME. The www.obgyn CNAME had protection Off, and public HTTPS failed at the OneShield edge although the origin served the hostname.

**Middle — decisions and work:** The OnePortal CNAME editor did not expose a protection control. As a workaround, the record was changed to a protected A pointing at the same origin IP, which allowed OneShield to queue and issue a wildcard certificate for the nested hostname. The authoritative DNS then returned OneShield edge IPs for the protected name. This created a DNS pattern exception: www.obgyn became an independent A record instead of a CNAME alias.

**End — outcome and verification:** Current authoritative DNS confirms www.eaglesvn.club remains a CNAME to eaglesvn.club, while www.obgyn.eaglesvn.club is an A record resolving to three OneShield edge addresses. Current tests show the nested www hostname returns OneShield HTTP 404 at all three edge addresses while direct-origin HTTPS returns 200. Therefore certificate and DNS propagation alone did not finish the route; the nested hostname still needs correct OneShield host routing. The desired record pattern is an A for each site apex and a protected www CNAME to that apex.

**Rationale:** The mismatch is a verified workaround caused by the unavailable CNAME protection control, not an intentional difference between the two site naming patterns. A future reviewer needs this context before changing the live record again.

**Future utility:** Preserves the reason the www.obgyn A record appeared and the required distinction between DNS answers and HTTP routing. Future troubleshooting should verify TLS and host routing separately, and should avoid treating a protected A workaround as a completed website fix.

**Project impact:** Observed: the workaround resolved edge TLS coverage but the nested www site still returns 404 through OneShield. Expected: using the same alias pattern for both sites, with proxy protection and edge routing configured for the alias, removes the anomalous record type and makes DNS intent consistent.

**Follow-up:** When an authenticated OnePortal session is available, restore www.obgyn as a protected CNAME to obgyn if the portal supports it; otherwise retain a protected A only after the OneShield edge hostname mapping is fixed and public HTTPS returns 200.

**Trigger / root cause:** Preserves the reason the www.obgyn A record appeared and the required distinction between DNS answers and HTTP routing. Future troubleshooting should verify TLS and host routing separately, and should avoid treating a protected A workaround as a completed website fix.

**Preventative rule:** Observed: the workaround resolved edge TLS coverage but the nested www site still returns 404 through OneShield. Expected: using the same alias pattern for both sites, with proxy protection and edge routing configured for the alias, removes the anomalous record type and makes DNS intent consistent.

<!-- curatormd:record_id=56d33e10e60363edf39a87b53f934ab6;content_sha256=7a276d32e025c6528848fc96f21c44b5f606a6d09b03495ba4fb060dba42a51f -->
<!-- curatormd:fingerprint=dbf152d2ae860f7dcf5d533edf9888b793f9f56c690b8ff6a2d0d66aa6b366b3 -->

## Keep the certificate inventory editable after root-shell regeneration

**Date:** 2026-10-11

**Lesson:** ## Keep the certificate inventory editable after root-shell regeneration

**Beginning — trigger and context:** The user reported a permission error when opening DOMAIN_CERTIFICATE_INVENTORY.md after the certificate inventory refresh had run from a root login shell. The generated report needed to remain editable by the checkout owner after every refresh.

**Middle — decisions and work:** Inspection found that update_domain_inventory.sh used umask 077, creating a root-owned mode-640 report when run as root. Its ownership repair depended on SUDO_UID and SUDO_GID, which are absent in a root login shell. The generator was changed to fall back to the output directory owner, set the report mode to 664, and restore the existing inventory to eaglesvn:eaglesvn without changing its contents.

**End — outcome and verification:** The inventory is owned by eaglesvn:eaglesvn and readable and writable by the checkout owner. Regeneration as root with SUDO_UID and SUDO_GID unset produced the same ownership. Shell syntax and whitespace checks passed.

**Rationale:** The failure came from assuming sudo-provided ownership metadata during a root login shell, while the restrictive umask made the generated file inaccessible for editing.

**Future utility:** This gives future certificate-inventory maintenance a verified ownership rule for both sudo and root-login invocations.

**Project impact:** Observed: the report can be edited after root-shell regeneration, and the ownership repair works without sudo environment variables. Expected: future inventory updates will not recreate the permission failure.

**Follow-up:** Keep the generator's root-login ownership fallback and mode 664 when changing the report output path or refresh workflow.

**Trigger / root cause:** This gives future certificate-inventory maintenance a verified ownership rule for both sudo and root-login invocations.

**Preventative rule:** Observed: the report can be edited after root-shell regeneration, and the ownership repair works without sudo environment variables. Expected: future inventory updates will not recreate the permission failure.

<!-- curatormd:record_id=9e5e971605660fc0847c395f82fbc0ef;content_sha256=9fed0ab330bce8934e15647816d5ca40563720835c2befa6aca63217d3675655 -->
<!-- curatormd:fingerprint=1bd8121b83b5d38be0965718f37f86331d1147cdb5cf10c918c7502db049edb2 -->
