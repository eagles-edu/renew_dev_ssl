# Vhost Manager GUI: data input and operations

## Purpose

Provide a host-local GUI for creating, reviewing, and maintaining websites on this Nginx + OpenLiteSpeed server. The GUI must make the selected domain and every file/system change visible before it applies anything. It manages web-server configuration and webroot files, with optional local MySQL/MariaDB database and scoped-user creation. DNS ownership, ACME issuance, and application deployment remain separate operations.

Start with a clean configuration model: do not assume a hosting panel, imported domain inventory, prior ownership conventions, or a particular site's settings. Detect the actual installed services and paths, then let the operator configure the initial site defaults. Existing configs are reference examples unless the operator explicitly directs cleanup. For a clean initialization, show the exact targets and diffs, save exact copies in a root-only archive before clearing active paths, preserve phpMyAdmin, and require the reviewed confirmation phrase before apply.

## Operating principles

- Treat `/etc/nginx/sites-available/` and `/etc/nginx/sites-enabled/` as the Nginx source of truth. Inventory every discovered vhost, including unmanaged files and broken symlinks; distinguish discovered, GUI-managed, externally changed, disabled, and invalid states.
- Discover the installed Nginx and OpenLiteSpeed paths and service names at startup. Show the detected values and let an administrator configure them; do not assume every host uses identical OLS layouts.
- Default new sites to `/home/<domain>/public_html/`, matching the CyberPanel-style layout already used on this server. Make the webroot editable, validate it stays under an approved base directory, and reject symlink/path traversal escapes.
- Never silently overwrite or delete a file. Existing or externally modified files require a diff, backup, and explicit confirmation.
- Bind the management interface to loopback by default. Any remote access requires an explicitly configured authenticated, encrypted access path; never expose a root shell or arbitrary command runner through the browser.
- Keep TLS issuance and certificate installation separate from vhost creation. Show ACME readiness and blockers, but do not imply a certificate exists until independently verified.

## Main layout

### Persistent vhost sidebar

- List all vhosts found in the configured Nginx available/enabled directories and configured OLS vhost directory, deduplicated by canonical domain/config identity.
- Provide search and filters for enabled, disabled, GUI-managed, external, invalid, pending TLS, and drifted entries.
- Show primary domain, aliases, webroot, front-end/backend (Nginx, OLS, static), TLS status, last scan, and a concise health indicator.
- Refresh inventory on demand and periodically. Detect changes made outside the GUI and show a drift badge instead of replacing the observed configuration.
- Selecting an entry opens its details. The **Create New Website** action opens a blank, validated form without disturbing the current selection.

### Website details and editing

Use named sections with a reviewable summary:

1. **Identity**: required primary FQDN; optional `www` alias and additional aliases; optional label/notes. Normalize case and reject invalid labels, duplicates, wildcard names unless explicitly supported, and conflicts with existing configs.
2. **Webroot and files**: default `/home/<domain>/public_html/`; require a dedicated no-login Unix account with a private primary group, derived as `<first4letters><domain-suffix-labels><MMYY>` (for example, `eaglesvn.club` becomes `eaglclub1026`), and stable when that managed site is edited later. Run the site's OLS PHP processes as that account. Do not allow a shared system account/group to own a managed site's content. Show the account and group in the review. Keep directory/file permission presets explicit; include placeholder index, robots.txt, and optional OLS `.htaccess` controls.
3. **Request handling**: choose static Nginx, Nginx reverse proxy to OLS, or OLS-managed application. For reverse proxy, accept only configured local upstreams by default and show the resulting proxy headers. Never treat `.htaccess` as an Nginx control: show that it is relevant only when the request is served by a compatible OLS/Apache rewrite context.
4. **Nginx**: HTTP server names, webroot, ACME HTTP-01 challenge location, access/error log paths, optional redirect policy, and selected full-site template. Offer a separate SSL/renewal config template only after certificate paths and renewal method are known. Generated configs must not point at missing certificate files.
5. **Security policy**: let each site use the manager-wide global CSP baseline or a custom site policy. The baseline includes the `eagles.edu.vn`, `gptpatient.com`, `eaglesvn.club`, and `eaglesvn.com` domain families and the client-side vendors present in current/reference app and Nginx configs: Google Analytics/Tag Manager/Fonts/Translate APIs, Brevo, jsDelivr, unpkg, AMP, YouTube, hCaptcha, and the GPTpatient placeholder image host. Use explicit source directives, `object-src 'none'`, a hash for the existing inline Analytics bootstrap, and no general inline-script or `unsafe-eval` allowance. Start in report-only mode and keep custom values in the reviewable plan.
6. **OpenLiteSpeed**: vhost name, document root, config path, listener mapping, rewrite policy, and optional external-app mapping, all based on detected/selected templates. Do not modify the global OLS listener or main config implicitly.
7. **PHP**: select an installed PHP version/handler and an approved `php.ini` profile. Prefill common editable values from that profile (memory/upload/post limits, execution/input limits, timezone, display errors, and logging). Allow advanced `directive = value` lines for less common settings. Include both in the review and in a private per-site ini based on the selected profile; do not change the shared profile or claim a setting is active until the selected handler is verified.
8. **Review and apply**: show a complete change list and unified diff for every existing or generated config, created directory/file, ownership, mode, symlink, service validation, and reload.

Allow editing supported fields for GUI-managed sites. For files created outside the GUI, provide read-only inventory first; an explicit **Adopt** action must preserve current files and record their initial hashes before the GUI offers edits.

## Create workflow

1. **Create New Website** opens a guided form beginning with the domain name. Validate each field inline and explain conflicts with the exact discovered path.
2. Build a dry-run plan. Show domains, webroot, owner/group, modes, generated placeholder/robots/`.htaccess` choices, Nginx and OLS output paths, PHP profile, and any prerequisites.
   - Database creation is opt-in. Review the database name, localhost-only user, required local root socket access, and one-time generated password delivery. Never include the password in the plan response, manifest, history, or logs; preserve an explicitly created database when rolling back site files.
3. Preview the generated files and full diff. Let the operator download/export the plan without applying it.
4. Apply as a sequence of individually logged steps: create directories/files; set ownership/modes; write Nginx/OLS/PHP configs using atomic temporary files and backups; create the enabled Nginx symlink; validate each service configuration; then reload only services whose config passed validation.
5. On a failed step, stop, report the exact command/result, and roll back only changes made by this operation. Never remove pre-existing or externally modified files during rollback.
6. Rescan inventory and report the actual enabled state, webroot access, service health, and remaining DNS/TLS prerequisites.

## Editing and maintenance workflow

- Show current detected values beside proposed values, with a before/after diff.
- Save edits as a pending plan. Applying requires an explicit confirmation naming the vhost and impacted services.
- Keep a timestamped, root-readable operation record with actor, domain, changed paths, prior hashes/backups, validation results, and rollback outcome. Do not store credentials, private keys, or secret environment values in the record.
- Provide **Validate**, **Enable/Disable**, **View config**, **Open webroot**, and **View history** actions where supported. Disabling removes only the managed enabled symlink after verifying its target; it does not delete the available config.
- Warn when Nginx or OLS is globally invalid, and block reload/apply until the relevant global validation passes.

## Best-practice defaults and guardrails

- Use least-privilege ownership: the site/deploy account owns content; the web-server account receives only the read/traverse access required. Do not default to `777` or make all sites owned by the web-server user.
- Separate writable upload/cache paths from executable application files where the application supports it. Display effective Unix modes and ACLs instead of hiding them behind labels such as “secure”.
- Use atomic writes, restrictive temporary-file modes, collision checks, per-domain locks, validated path construction, and backups before changing active configuration.
- Keep secrets and TLS private keys out of the webroot, persisted GUI state, logs, and diffs. The only database-secret response is the one-time credential handoff after explicit provisioning.
- Keep generated database passwords only in the expiring server-side plan and the one-time post-apply response; grant the new localhost-only user access only to its selected database.
- Disable directory listings and prevent dotfile/private-file exposure in the selected server template. Use an explicit `robots.txt` choice and make clear that it is crawler guidance, not access control.
- Only add security headers or HTTP-to-HTTPS redirects when the selected TLS setup is ready and the operator previews the result; avoid proxy loops and duplicate headers across Nginx and OLS.
- Validate Nginx with its effective global configuration before reload. Validate OLS with the installed binary/config before reload. A successful syntax test does not by itself prove DNS, routing, PHP execution, or public TLS health.
- Keep templates versioned and visible in the repo. Show the template name/revision used for each managed vhost so later edits can report template drift.

## Inventory and persistent state

- The server config files remain canonical for observed Nginx/OLS state. A small root-owned manifest may store GUI ownership, template revision, user-facing notes, and last-applied hashes; it must not replace or obscure discovered configuration.
- Mark each sidebar entry as **In sync**, **External changes**, **Missing**, or **Invalid** by comparing paths and hashes on each scan.
- If the manifest is lost, rebuild inventory from server files and mark ownership/template metadata unknown. Never infer that an unmarked file is safe to overwrite.

## Acceptance checklist

- A user can create a site by entering a domain, inspect the complete plan, and cancel without changing the host.
- The sidebar displays enabled and disabled discovered vhosts and identifies broken links, invalid configs, and external changes.
- A site can be created without a database or with an explicitly reviewed MySQL/MariaDB database and scoped localhost-only user; generated credentials are shown once after apply.
- A managed site's editable details persist after reload and produce a diff before apply.
- Webroot, placeholder page, ownership, permissions, robots.txt, optional `.htaccess`, Nginx HTTP/SSL-renewal templates, enabled symlink, OLS vhost, selected PHP profile, prefilled simple PHP settings, and advanced per-site ini overrides each have explicit preview and validation states.
- Apply refuses collisions, unsafe paths, missing prerequisites, and failed global syntax checks; successful apply records exactly what changed and can roll back its own changes.
- The GUI remains local-only unless secure authentication and transport are explicitly configured.

## Implementation sequence

1. Read-only Nginx/OLS discovery and sidebar with health/drift states.
2. Create form, validation, and dry-run plan for webroot plus Nginx HTTP config.
3. Safe apply/rollback for directories, placeholder files, permissions, and enabled symlink.
4. OLS vhost templates and validation, then PHP profile selection.
5. SSL/renewal template workflow after certificate path and ACME method are confirmed.
6. Editing/import of existing configurations, operation history, and UI accessibility/persistence review.

Do not generate or activate production OLS/PHP/SSL files until their host-specific template paths, service accounts, handler versions, and validation commands have been detected and reviewed.
