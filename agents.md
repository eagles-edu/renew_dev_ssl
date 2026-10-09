# AGENTS.md - Agents Operating Manual

YOU ARE AUTHORIZED TO AUTOMATICALLY, UPDATE, EXPAND, AND MAINTAIN THIS DOCUMENT CONTINUOUSLY IN REALTIME, WITHOUT ASKING ME.

## Instructions for Coding

Mindset of a 15+ yr full-stack, AI-enabled app dev.

### Core behaviors

_Critically, consistently, and before every coding attempt, ALWAYS reread agents.md instructions._

**Prepare to continue** dev by:

1. rescanning repo,
2. identifying all changed files in repo,
3. fully purging your working memory,
4. refreshing repo working memory with current canonical repo state,
5. verifying repo working memory state is equal to canonical repo state, and
6. performing All per agents.md rules.

#### MANDATORY

> **_BEFORE_** you (codex) evaluates any code to suggest edits and/or provide unified differential patches, you MUST ALWAYS, WITHOUT EXCEPTION:

1. RESCAN REPO FOR CHANGED CANONICAL files,

2. COMPLETELY FLUSH working memory (head),

3. REFRESH working memory with freshly updated canonical state.

4. ALWAYS Cautious, incremental, validation-first problem solving.

5. **No assumptions**; clarify missing context with focused questions.

6. **Recency obsession**: verify versions, syntax, deprecations, and compatibility online, **from today to your (the GPT model’s) info cutoff date** before advising.

7. **Defer to current sources** when legacy conflicts appear; note impacts.

8. **Focused-diff edits**; change only what’s required; avoid over-engineering.

9. Break down large problems into multiple simple, specific, detailed steps when creating Implementation steps.

10. Dont '**reinvent the wheel**' or **modify existing code** unless requested or absolutely necessary to fulfill this documents instructions.

11. Look for ways to implement changes by using existing code first; then, if not possible, create new code solutions.

12. Work slowly and go step-by-step to make compact, requirement fulfilling, working, elegant, best-practices code.

### Delivery

- Provide complete, executable code when asked (POIA); never abridge.

- Mention the filename + full path for every file you touch in your summary.

- **Prefer focused diffs**: annotate notable CSS/JS changes with succinct inline comments when the intent is not obvious.

- **Keep prose purposeful**; use short checklists (3+ items) followed by focused steps when outlining work.

- Close each major edit or suggestion with a one-line **validation of the expected outcome**.

- **Never reprint edits** that have already been provided unless additional clarification is explicitly required (POIA).

- **Unified Diff Format forever**: include an aggregated unified diff snippet (e.g., from `git diff --unified`) for every change set, even when full files are provided elsewhere in the response.

### Scope & safety rails

- Stay strictly within the user’s scope. Don’t modify or mention unrelated code or files.

- Discuss material changes before implementation when risk/impact is high; otherwise proceed with documented intent.

- If anything is unclear or risky, pause and ask.

### Memory & continuity

- Track and recall project versions, toolchains, linters, build targets, browser support, and prior decisions. Reuse working patterns; avoid past mistakes.

### Detailed App Description (log)

- Record Detailed App Description sequentially, by subroutine, below and update details in realtime of every subsequent change, update, addition, subtraction, and deprecation.

### Standard Operating Procedures (SOP) (log)

- Record Standard Operating Procedures below and apply them in all subsequent sessions.

### Lessons Learned

- Record lessons learned (successes/failures) below and apply them in all subsequent sessions.

### Detailed App Description

- Site identity policy: every managed site receives a unique no-login Unix account and exclusive primary group; manager edits retain the account, and OpenLiteSpeed PHP handlers use it as `extUser`/`extGroup`. Shared owners/groups and cross-site account reuse are rejected. Apply verifies existing account home, shell, private group, and group exclusivity before changing site files.
- Desktop launcher: XFCE left application panel (`panel-2`) includes the `Vhost Manager` launcher and starts the root-run manager through `renew-dev-ssl-vhost-manager.service`, waits for `/api/status`, then opens `http://127.0.0.1:4310`; its sudoers grant is limited to starting that exact service and it is not enabled at boot. The panel plugin was moved from the top/status panel to the left application panel after the launcher was reported missing.
- Display accessibility: Vhost Manager starts in persistent dark mode with 175% text scaling or 200% on detected 4K UHD displays, without zooming layout dimensions. Detection uses screen dimensions multiplied by device pixel ratio; the toolbar labels text-size controls, displays the current percentage and a 4K badge, and adjusts from 125% to 225%. Automatic sizing follows display changes until a user manually selects a scale; the manual scale persists in browser localStorage. Theme and scale preferences are browser-local.
- User documentation: `docs/vhost-manager-user-manual.md` documents the local launcher, archive-only versus clean reset, website creation sequence, traffic and permission diagrams, recommendations for site identity, modes, ports, PHP, CSP, HSTS, MIME/cache, TLS activation, operations, rollback, and troubleshooting. `readme.md` links the guide and now reflects the active CSP vendor list rather than removed vendors.

- Baseline: Bash utility `acme_dns_manual_nginx_swap.sh` drives manual DNS ACME renewals with Nginx config swapping, public/authoritative TXT validation, and trap-based rollback.
- Vhost bootstrap: `setup_nginx_vhost.sh` previews or creates new HTTP Nginx vhosts, maps `/home/<domain>/public_html/` as the HTTP-01 webroot, and proxies to OpenLiteSpeed at `127.0.0.1:8088` by default. It refuses collisions, validates Nginx before/after activation, and leaves TLS issuance separate.
- Vhost manager: `vhost-manager/ui` is the React browser interface and `vhost-manager/server` is the loopback-only root API. It inventories Nginx/OLS, creates reviewable reset/site plans, stores root-owned history/backups, validates before reload, and keeps phpMyAdmin configuration/listener/app files intact during clean initialization. Discovered server configs are labeled as examples/reference inventory; an archive-only action snapshots exact files and the prior OLS main config under `<backupDir>/archive/<operation-id>` without changing active configs. The separately confirmed reset reuses that archive before clearing active paths. New-site details include domain, aliases, label/notes, editable webroot bounded under `/home/<domain>`, owner/group, permissions, placeholder/robots/.htaccess, request mode with loopback-only proxy upstream, Nginx logs/redirect/certificate paths, TCP/UDP inbound ports reviewed as IPv4/IPv6 iptables changes, OLS listener and PHP handler/profile, plus CSP/security/MIME/cache. Firewall rules use a dedicated VHOST-MANAGER chain, update `/etc/iptables/rules.v4` and `rules.v6`, and roll back with the reviewed site operation; proxy upstream ports are never opened implicitly. Dedicated site owners concatenate the first four domain letters, the full domain slug, and `MMYY`, respect Ubuntu's 32-character account limit, and persist across later edits. The PHP form prefills common directives from the selected profile and supports editable simple controls plus validated advanced per-site overrides; the private generated ini retains the selected profile as its base. All generated Nginx production/renewal, OLS main/vhost, PHP ini, placeholder HTML, robots, and `.htaccess` content comes from variable-rendered files in `vhost-manager/boilerplate`; missing/unresolved `{{UPPER_SNAKE_CASE}}` variables fail planning. The global CSP is sourced from `vhost-manager/shared/csp-policy.txt`, keeps the Eagles/GPTpatient/EaglesVN first-party origins and Google Analytics/Tag Manager, includes GPTMD Supabase and OpenAI Realtime plus requested ACB and IcePanel endpoints, and excludes unused Fonts/Translate, Brevo, jsDelivr, unpkg, AMP, YouTube, hCaptcha, and obsolete EaglesVN.com origins. It hashes the known Analytics inline bootstrap without general inline-script or `unsafe-eval` permission. It starts in report-only mode; sites may use a custom policy. The IELTS allowlist remains site-specific. The old GUI plan/spec remains supporting documentation, not the runtime source of truth.
- Tooling: Node 24.21.0 runtime (`.nvmrc` / `.node-version`) with ESLint 10 flat config (`eslint.config.mjs`) and Prettier formatting (`.prettierrc`).
- Git publishing: `npm run git:update` prefills the next `ACME_DEV_BETA_` commit subject, waits for Enter or edits, runs `npm run check`, then stages, commits, and pushes. `--dry-run` prints the suggestion only.
- Testing: Default Playwright config targets only `tests/ssl-health.spec.js` against `TARGET_URL`/`BASE_URL`; Vhost Manager server and UI suites use `npm run check:vhost` so fixture flows never run against the external health-check URL. `npm run check` runs both suites.
- Docs/IDE: VS Code settings tuned for Prettier + ESLint; MCP servers configured in `.vscode/mcp.json` (GitHub, Playwright, Codacy, Context7, Serena, Snyk, JFrog) and require tokens/inputs.

### Standard Operating Procedures (SOP)

- Use Node 24.21.0 via `nvm use` before npm scripts; `.npmrc` enforces engine-strict.
- Install dependencies with `npm ci`; run `npm run pw:install` to fetch browsers and `npm run check` for lint, format, health, and Vhost Manager server/UI suites. Use `npm run check:vhost` for focused manager validation.
- Review all workspace changes before `npm run git:update`; it runs `npm run check` and then stages every non-ignored change before commit and push.
- For new vhosts, review `./setup_nginx_vhost.sh --domain FQDN` first; use `sudo ... --apply` only after the existing global Nginx configuration passes `nginx -t`. Issue/install TLS separately.
- For the local Vhost Manager, build with `npm run vhost:build`, then launch explicitly as root with `sudo npm run vhost:start`; open `http://127.0.0.1:4310` in the VNC browser. Preview every operation. Reset apply archives config snapshots first, preserves phpMyAdmin, then validates both services; never apply it without the operator's exact confirmation in the reviewed UI.
- Launch the local Vhost Manager from the XFCE left panel; check `systemctl status renew-dev-ssl-vhost-manager.service` and `journalctl -u renew-dev-ssl-vhost-manager.service` for startup issues. The service stays manually started and is not enabled at boot.
- Site firewall ports use separate comma-separated TCP and UDP fields. New sites default to TCP 80 and 443; the reviewed plan shows all-source IPv4 and IPv6 INPUT rules and persistent rule-file diffs before apply. Firewall changes are independent from the loopback-only app upstream and container publishing.
- Edit generated site files only in `vhost-manager/boilerplate`; use `{{UPPER_SNAKE_CASE}}` placeholders and keep the renderer's missing/unresolved-variable checks enabled. Update `boilerplate/README.md` when adding or renaming a template.
- For GUI work, begin from detected host state without assuming a control panel or imported inventory. Implement read-only discovery and dry-run review before privileged writes; preserve existing files and validate Nginx and OLS before reload.
- Configure Playwright targets through `TARGET_URL` or `BASE_URL` in `.env`; security-header test skips unless pointing at a non-default host.
- Keep secrets in `.env` (git-ignored); do not commit node_modules or Playwright artifacts (`playwright-report/`, `test-results/`).

### Lessons Learned (log)

- Playwright install reports missing system libraries; resolve per installer output or run inside the recommended container image.
- Use `nvm exec 24.21.0 <command>` when scripting to avoid falling back to another system Node version.
