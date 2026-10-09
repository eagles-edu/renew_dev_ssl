# Local Vhost Manager

## Summary

Build a root-run, browser-based vhost manager for this server. Open it locally in the VNC browser. It will provide a persistent vhost sidebar, domain-first creation, editable site details, and a preview-before-apply workflow.

The first-run wizard will offer a clean reset of discovered site vhosts while preserving phpMyAdmin: its OLS vhost, listener map, credentials, and `/opt/phpmyadmin` files remain intact. The reset backs up affected targets, shows the file list and diffs, and requires confirmation before apply. It retains global service settings, ACME accounts and certificates, and website data.

## Implementation

- Build an accessible React UI with a Node server, started explicitly as root. Bind only to `127.0.0.1`; expose fixed, validated operations only—never an arbitrary command runner. Protect state-changing requests against cross-origin use.
- Inventory Nginx available/enabled configs, OLS vhosts, and broken links. The sidebar will show health, enabled state, and changes made outside the manager. Keep a root-owned manifest for manager metadata and operation history; server configs remain canonical.
- For reset and site changes, show affected paths, backups, generated configs, ownership and permissions, and diffs before apply. Write atomically, journal operations, validate Nginx and OLS, then reload only after validation passes. Back up reset targets under a timestamped root-only directory; retain enough state to restore the prior configs if validation fails. Reset directory cleanup must leave any directory containing preserved phpMyAdmin files untouched.
- New sites default to `/home/<domain>/public_html/`, a per-site Unix account, and Nginx in front of OLS. Generate the webroot, placeholder page, robots.txt, optional OLS `.htaccess`, enabled Nginx challenge config, full production Nginx config, OLS vhost and PHP handler, and private per-site PHP ini outside the webroot. Keep SSL activation separate until certificate paths exist.
- Match the existing renewal script’s expected paths and names: production config in `/etc/nginx/sites-available/<domain>.conf`; challenge config in `/etc/nginx/sites-available/vhost_ssl/<domain>_ssl.conf`; enabled challenge link in `/etc/nginx/sites-enabled/<domain>_ssl.conf`.

## Interfaces and checks

- Add a root launch command for the local GUI plus internal endpoints for status, inventory/scan, reset preview, site preview, apply, validation, enable/disable, history, and rollback. Provisioning requests will return a reviewable plan before any apply request can change the host.
- Test domain/path validation, config rendering, inventory parsing, broken-link reporting, conflict detection, reset backup/restore, and failed-validation rollback using temporary fixture trees.
- Use Playwright to check sidebar navigation, create/edit persistence, preview and cancel behavior, reset confirmation, and blocked apply states. CSP starts in report-only mode with a restrictive generic policy; the IELTS-specific allowlist in `nginxz/prod-nginx/snippets/ielts-security-headers.conf` is not copied into unrelated site configs.
- Site settings expose CSP mode/policy, HSTS, frame/referrer/permissions policies, additional MIME mappings merged with system `mime.types`, static asset browser-cache duration, and optional shared proxy cache only when a global `cache_zone` exists. Reset preview explicitly lists the phpMyAdmin paths and listener/credential resources it preserves.
- Host acceptance requires reset and generated configs to pass `nginx -t` and `/usr/local/lsws/bin/openlitespeed -t` before either service reloads. Nginx currently fails on dangling site links; OLS fails on the stale `eaglesvn.club` vhost reference. The reset preview must show those targets and resulting changes before application.

## Defaults and assumptions

- The UI is local-browser only and the manager process runs as root, as requested.
- “Clean reset” means back up and remove discovered site Nginx configs/links and OLS site vhosts while preserving the complete phpMyAdmin vhost, listener mapping, credentials, and `/opt/phpmyadmin`. It does not remove website data, global service configuration, ACME state, or certificates.
- Per-site PHP uses an OLS vhost-level handler/configuration so settings and runtime identity are isolated; the shared global PHP ini is not edited. OpenLiteSpeed supports vhost-level handlers and PHP overrides ([official PHP configuration guide](https://docs.openlitespeed.org/config/php/externalapp/)).
- Validate the effective Nginx configuration with `nginx -t` before reload ([Nginx command options](https://nginx.org/en/docs/switches.html)).
