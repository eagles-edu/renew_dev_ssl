# renew_ssl

Toolkit for manual DNS ACME certificate renewal with nginx swap/rollback safety, plus Playwright-based TLS posture verification.

## Upgrade completion status

Completed on **February 9, 2026**.

- Upgraded toolchain to current major/stable set:
  - `eslint` `10.0.0`
  - `@eslint/js` `10.0.1`
  - `globals` `17.3.0`
  - `@playwright/test` `1.58.2`
  - `prettier` `3.8.1`
  - `dotenv` `17.2.4`
- Added strict test mode for security headers and CI optional strict gate.
- Fixed formatting pipeline so shell scripts are not parsed as HTML.
- Verified with `npm run check` and strict-mode test runs.

## Repository components

- `acme_dns_manual_nginx_swap.sh`
  - Interactive single-domain workflow with trap-based rollback, DNS propagation checks, and certificate installation.
- `renew_all_domains.sh`
  - Sequential wrapper for the clean domain inventory; preserves interactive DNS and Nginx checkpoints.
- `update_domain_inventory.sh`
  - Refreshes the generated current/new inventory and live certificate expiry dates.
- `DOMAIN_CERTIFICATE_INVENTORY.md`
  - Generated grouped domain list with `CURRENT` and `NEW` sections.
- `tests/ssl-health.spec.js`
  - HTTPS reachability and security-header assertions.
- `playwright.config.js`
  - Multi-browser Playwright config with `.env` support.
- `package.json`
  - Scripts for lint, format, smoke checks, and strict checks.
- `.github/workflows/ci.yml`
  - CI installs Playwright browsers, runs `npm run check`, then optional strict gate if `TARGET_URL` is configured.

## Prerequisites

1. Node `22.22.0` (`.nvmrc` and `.node-version` are pinned).
2. npm.
3. Linux host packages required by Playwright browsers (install per Playwright output if missing).
4. Root access for production renewal (`acme_dns_manual_nginx_swap.sh` uses nginx/systemctl and `/root/.acme.sh`).
5. Root access for the Moodle DB health probe (`scripts/moodle-db-healthcheck.sh` reads the live `config.php` and tests MariaDB locally).

## Command reference

| Command                                 | Purpose                              | Typical use                               | Pass criteria                                                  |
| --------------------------------------- | ------------------------------------ | ----------------------------------------- | -------------------------------------------------------------- |
| `nvm use 22.22.0`                       | Use pinned Node runtime              | First step per shell/session              | `node -v` shows `v22.22.0`                                     |
| `npm install`                           | Install/update dependencies          | Initial setup or after dependency changes | Completes without audit/build errors                           |
| `npm run pw:install`                    | Download Playwright browser binaries | First setup, after Playwright upgrade     | Browser download succeeds                                      |
| `npm run lint`                          | Static lint checks                   | Fast local check                          | Exit code `0`                                                  |
| `npm run format:check`                  | Prettier conformance                 | Pre-commit formatting gate                | Exit code `0`                                                  |
| `npm test`                              | Standard Playwright run              | Smoke checks and default CI behavior      | HTTPS tests pass; header checks run when target is non-default |
| `npm run test:strict`                   | Force security-header assertions     | Security hardening gate                   | Fails unless non-default target has required headers           |
| `npm run check`                         | Full standard quality gate           | Recommended local pre-push command        | Lint + format + test pass                                      |
| `npm run check:strict`                  | Full strict quality gate             | Release readiness/security gates          | Lint + format + strict test pass                               |
| `npm run check:moodle-db`               | Moodle DB reachability probe         | Quick DB availability check on the host   | `config.php` credentials authenticate and `SELECT 1` succeeds  |
| `sudo ./acme_dns_manual_nginx_swap.sh`  | Renewal workflow                     | Manual DNS-based production renewal       | Script reaches `SUCCESS` and nginx restored                    |
| `sudo ./update_domain_inventory.sh`     | Refresh domain inventory             | Before reviewing or batching renewals     | Live expiry dates and domain sections are regenerated          |
| `sudo ./renew_all_domains.sh --dry-run` | Batch inventory preview              | Review domains and auto-selected flow     | Lists every inventory domain without changing state            |

## Flag and environment variable table

### Batch renewal wrapper

`renew_all_domains.sh` reads `DOMAIN_CERTIFICATE_INVENTORY.md` and runs the existing certificate workflow sequentially. Rows in `CURRENT` are run with `renew`; rows in `NEW` are run with `new`.

The clean generated source is `DOMAIN_CERTIFICATE_INVENTORY.md`. Refresh it with `sudo ./update_domain_inventory.sh`; expiry values come from each domain's public TLS certificate, while unreachable/internal entries remain visible but are not sent to the batch runner.

```bash
./renew_all_domains.sh --dry-run
sudo ./renew_all_domains.sh
```

The wrapper intentionally keeps DNS entry and Nginx checkpoints interactive. After each successful domain it runs `update_domain_inventory.sh` and saves the refreshed expiry in `/var/lib/acme-dns-manual-nginx-swap/progress.tsv`. A later run skips domains with the same saved expiry only while expiry is more than 10 days away; domains inside the 10-day window run again. It stops after the first failure by default, prevents concurrent batch runs, and requires a TTY for real execution.

Supported wrapper options:

```bash
cd /home/eagles/dockerz/renew_ssl
./renew_all_domains.sh --dry-run
sudo ./renew_all_domains.sh
sudo ./renew_all_domains.sh --mode renew
sudo ./renew_all_domains.sh --continue-on-failure
sudo ./renew_all_domains.sh --reset-progress
sudo ./renew_all_domains.sh --domain ltd.eagles.vn
```

Use `--reset-progress` only when intentionally starting the selected domains again. Use `--continue-on-failure` only after reviewing the failed domain.

To process one domain while retaining inventory refresh and resume tracking, use `--domain FQDN`. For `ltd.eagles.vn`, the inventory selects `new` automatically.

### Playwright runtime flags

| Variable/flag                           | Where used                    | Default               | Effect                                                      | Real-world usage                          |
| --------------------------------------- | ----------------------------- | --------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `TARGET_URL`                            | `playwright.config.js`, tests | unset                 | Primary target URL for tests                                | Point checks at production/staging host   |
| `BASE_URL`                              | `playwright.config.js`, tests | `https://example.com` | Fallback target if `TARGET_URL` is unset                    | Local override when avoiding `.env` edits |
| `PLAYWRIGHT_REQUIRE_SECURITY_HEADERS=1` | `tests/ssl-health.spec.js`    | `0`                   | Forces security-header checks; fails fast on default target | CI release gate for hardened TLS posture  |
| `HEADLESS=false`                        | `playwright.config.js`        | `true`                | Runs browsers with UI                                       | Debugging local failures                  |
| `PLAYWRIGHT_ENABLE_WEBKIT=1`            | `playwright.config.js`        | `0`                   | Adds WebKit project                                         | Safari-specific TLS/header confidence     |
| `CI=true`                               | `playwright.config.js`        | auto in CI            | Enables retries/CI reporters                                | GitHub Actions and pipeline runs          |

### ACME flags used by `acme_dns_manual_nginx_swap.sh`

The script remains interactive for DNS and safety checkpoints, but accepts `--domain FQDN` and `--mode renew|new` so the batch wrapper can select each domain safely. It drives `acme.sh` using the flags below.

| Flag                                                  | Stage                   | Why it matters                                                                                                     | Typical value                              |
| ----------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `--set-default-ca --server`                           | Preflight               | Ensures issuance uses intended CA                                                                                  | `letsencrypt`                              |
| `--issue`                                             | DNS challenge start     | Creates challenge for first-time/new issue flow                                                                    | used with `-d` and `--dns`                 |
| `--renew`                                             | Final cert action       | Completes renewal after TXT propagation                                                                            | used with `--dns` and optionally `--force` |
| `--force`                                             | Issue/conditional renew | Preserves the current ACME state while forcing a fresh issue; also bypasses the renew due-date guard when required | issue always; renew only when required     |
| `-d`                                                  | Domain targets          | Sets primary and SAN domains                                                                                       | `<domain>` and `www.<domain>`              |
| `--ecc`                                               | Key type                | Uses ECC cert profile in remove/info/renew/install                                                                 | `ec-256` flow                              |
| `--keylength`                                         | Issue                   | Chooses ECC key length                                                                                             | `ec-256`                                   |
| `--dns`                                               | Validation mode         | Uses manual DNS challenge path                                                                                     | manual TXT records                         |
| `--dnssleep`                                          | Issue                   | Waits before challenge validation attempts                                                                         | `120` seconds                              |
| `--yes-I-know-dns-manual-mode-enough-go-ahead-please` | Issue/Renew             | Required acme.sh acknowledgement for manual mode                                                                   | fixed literal                              |
| `--install-cert`                                      | Deploy cert             | Installs key/fullchain to nginx paths                                                                              | dynamic path detection                     |
| `--reloadcmd`                                         | Deploy cert             | Reloads nginx after install                                                                                        | `systemctl reload nginx`                   |
| `--debug 2`                                           | Diagnostics             | Verbose output for troubleshooting                                                                                 | `2`                                        |

## Detailed usage examples and real-world sequences

### 1) Refresh and review the domain inventory

```bash
sudo ./update_domain_inventory.sh
less DOMAIN_CERTIFICATE_INVENTORY.md
./renew_all_domains.sh --dry-run
```

The updater discovers domains from the historical source and enabled Nginx sites, reads the public TLS certificate, and writes expiry timestamps in Vietnam time. Internal or unreachable entries remain visible but are not selected for batch execution.

### 2) Single-domain production renewal

```bash
nvm use 22.22.0
npm install
npm run check
sudo ./acme_dns_manual_nginx_swap.sh --domain example.com --mode renew
```

Sequence to follow:

1. Confirm the domain and mode are correct.
2. Confirm nginx staging swap checkpoint.
3. Copy both TXT values printed by acme.sh into DNS provider.
4. Wait for script DNS checks to show public+authoritative pass for apex and `www`.
5. Continue renew/install prompts.
6. Confirm nginx restored and script reports `SUCCESS`.
7. Optionally run:

```bash
TARGET_URL=https://example.com npm run test:strict
```

### 3) New-domain issuance

```bash
sudo ./acme_dns_manual_nginx_swap.sh --domain newsite.example.com --mode new
```

Use `new` only when the staged SSL Nginx link is already enabled and the full production configuration exists in `sites-available`. Confirm the generated inventory lists the domain under `NEW` before using the batch wrapper.

### 4) All-domain sequential renewal

```bash
sudo ./update_domain_inventory.sh
./renew_all_domains.sh --dry-run
sudo ./renew_all_domains.sh
```

For each domain, complete the displayed DNS TXT records, wait for public and authoritative checks to pass, and approve the install/cutover prompts. The wrapper stops on failure so the failed domain can be investigated before continuing.

### 5) Emergency renewal when cert is near expiry

```bash
openssl s_client -servername example.com -connect example.com:443 </dev/null 2>/dev/null \
  | openssl x509 -noout -dates
sudo ./acme_dns_manual_nginx_swap.sh --domain example.com --mode renew
```

Sequence to follow:

1. Capture current cert dates before change.
2. Run renewal script and complete TXT workflow immediately.
3. After success, re-run OpenSSL date check and confirm `notAfter` moved forward.
4. Run strict header validation:

```bash
TARGET_URL=https://example.com npm run test:strict
```

### 6) CI security gate for an internet-facing host

Configure repository variable in GitHub Actions:

1. `TARGET_URL=https://example.com`

Then push or open PR.

Pipeline sequence:

1. `npm ci`
2. Playwright browser install
3. `npm run check`
4. Optional strict step runs automatically because `TARGET_URL` is set in repo vars.

### 7) Pre-go-live validation for a new domain

```bash
TARGET_URL=https://newsite.example.com npm test
TARGET_URL=https://newsite.example.com npm run test:strict
```

Sequence to follow:

1. Run standard test first for quick connectivity and protocol checks.
2. Run strict test to enforce security headers.
3. Fix missing headers in nginx if strict test fails.
4. Re-run strict test until all browser projects pass.

### 8) Moodle database availability probe

```bash
sudo npm run check:moodle-db
```

Sequence to follow:

1. Read `dbhost`, `dbname`, `dbuser`, and `dbpass` from the live Moodle `config.php`.
2. Open a short MySQL session against the local MariaDB server.
3. Run `SELECT 1` plus a quick connection-count status check.
4. Treat any timeout or auth failure as a real database availability problem, not an SSL issue.

## Recommended operator workflow

1. **Before renewal**: refresh `DOMAIN_CERTIFICATE_INVENTORY.md` and run `./renew_all_domains.sh --dry-run`.
2. **During renewal**: use the single-domain script or wrapper, complete DNS prompts, and do not interrupt after Nginx swap unless rolling back.
3. **After renewal**: verify the served expiry date and run `TARGET_URL=https://<domain> npm run test:strict`.
4. **Before commit/push**: `npm run check` (and `npm run check:strict` if target is available).

## Notes

- `.env` is git-ignored; keep secrets out of source control.
- If Playwright reports missing shared libraries, install required packages from Playwright output and re-run `npm run pw:install`.
- Strict mode intentionally fails if target remains `https://example.com`, preventing false-positive security checks.
