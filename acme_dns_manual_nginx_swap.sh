#!/usr/bin/env bash
# Safely issue or renew an ECC certificate with manual DNS validation and an
# Nginx staging/cutover workflow.
#
# Modes:
#   renew: swap the enabled production entry to staged SSL, then restore it.
#   new: keep an existing staged SSL link enabled, then enable production.
#
# Run as root. Confirm the domain exists in DOMAIN_CERTIFICATE_INVENTORY.md,
# keep DNS provider access ready, enter the exact TXT values printed by acme.sh,
# and continue only after public and authoritative DNS checks pass.
#
# Examples:
#   sudo ./acme_dns_manual_nginx_swap.sh --domain example.com --mode renew
#   sudo ./acme_dns_manual_nginx_swap.sh --domain newsite.example.com --mode new

set -euo pipefail
umask 077

# ---------- Config (edit only if your paths differ) ----------
ACME="/root/.acme.sh/acme.sh"
NGINX_ENABLED="/etc/nginx/sites-enabled"
NGINX_AVAILABLE="/etc/nginx/sites-available"
SSL_REPO="/etc/nginx/sites-available/ssl_conf_repo"
TEMP_DIR="/etc/nginx/temp_production_symlink"
LOCK_FILE="/run/lock/acme-dns-manual-nginx-swap.lock"
LOG_DIR="/var/log"

# Public resolvers for propagation checks
PUBLIC_RESOLVERS=( "1.1.1.1" "8.8.8.8" "9.9.9.9" )
# Set CHECK_AUTH_IPV6=yes only when authoritative IPv6 DNS transport is ready.
CHECK_AUTH_IPV6="${CHECK_AUTH_IPV6:-no}"

# ---------- State (used for rollback) ----------
DOMAIN=""
WWW=""
RUN_MODE="renew"
LOG_FILE=""
PROD_ENABLED_PATH=""
PROD_AVAILABLE_PATH=""
PROD_MOVED_PATH=""
STAGE_LINK_PATH=""
STAGE_CONF_PATH=""
ROLLBACK_NEEDED="no"
NEW_MODE_LINK_SWITCHED="no"
ECC_DIR=""
ECC_BACKUP=""
ECC_STATE_CHANGED="no"
CERT_ISSUED="no"

# ---------- Messaging helpers ----------
ts() { date +"%F %T %z"; }
info() { echo "INFO  [$(ts)] $*"; }
warn() { echo "WARN  [$(ts)] $*" >&2; }
err()  { echo "ERROR [$(ts)] $*" >&2; }
die()  { err "$*"; exit 1; }

# Print command then run it (stdout preserved via global logging tee)
run() {
  info "RUN: $*"
  "$@"
}

validate_reload_nginx() {
  run systemctl status nginx --no-pager || true
  run nginx -t
  run systemctl reload nginx
  run systemctl status nginx --no-pager || true
}

pause_enter() {
  local prompt="$1" answer
  echo
  while true; do
    read -r -p "ACTION: ${prompt}  (Enter=continue, r=restore and quit) " answer || rollback "input closed at restore checkpoint"
    case "${answer,,}" in
      "") return 0 ;;
      r|restore|q|quit) rollback "operator requested full configuration restore" ;;
      *) warn "Press Enter to continue, or 'r' to restore the full configuration and quit." ;;
    esac
  done
}

ask_yes_no() {
  local prompt="$1" ans
  while true; do
    read -r -p "PROMPT: ${prompt} [y/n/r=restore+quit]: " ans || rollback "input closed at restore checkpoint"
    case "${ans,,}" in
      y|yes) return 0 ;;
      n|no)  return 1 ;;
      r|restore|q|quit) rollback "operator requested full configuration restore" ;;
      *) warn "Please answer 'y', 'n', or 'r' to restore and quit." ;;
    esac
  done
}

read_txt_value_or_restore() {
  local prompt="$1" variable_name="$2" value
  while true; do
    read -r -p "INPUT: ${prompt} (or 'r' to restore and quit): " value || rollback "input closed at restore checkpoint"
    case "${value,,}" in
      r|restore|q|quit)
        rollback "operator requested full configuration restore"
        ;;
      "")
        warn "A TXT value is required, or enter 'r' to restore and quit."
        ;;
      *)
        printf -v "$variable_name" '%s' "${value//\"/}"
        return 0
        ;;
    esac
  done
}

# ---------- Lock ----------
acquire_lock() {
  mkdir -p "$(dirname "$LOCK_FILE")" || true
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    die "Another instance is already running (lock: $LOCK_FILE). If you're sure it's stale, remove it and retry."
  fi
}

# ---------- Rollback ----------
rollback() {
  local why="${1:-unspecified reason}"
  warn "Rollback initiated: ${why}"
  set +e

  # Restore Nginx state based on selected flow
  if [ "$ROLLBACK_NEEDED" = "yes" ]; then
    if [ "$RUN_MODE" = "renew" ]; then
      if [ -n "$STAGE_LINK_PATH" ] && [ -L "$STAGE_LINK_PATH" ]; then
        info "Removing staged symlink: $STAGE_LINK_PATH"
        rm -f "$STAGE_LINK_PATH"
      fi

      if [ -n "$PROD_MOVED_PATH" ] && [ -e "$PROD_MOVED_PATH" ]; then
        info "Restoring production entry to: $PROD_ENABLED_PATH"
        mv -f "$PROD_MOVED_PATH" "$PROD_ENABLED_PATH"
      fi
    elif [ "$RUN_MODE" = "new" ]; then
      if [ "$NEW_MODE_LINK_SWITCHED" = "yes" ]; then
        if [ -n "$PROD_ENABLED_PATH" ] && [ -L "$PROD_ENABLED_PATH" ]; then
          info "Removing production symlink enabled during NEW flow: $PROD_ENABLED_PATH"
          rm -f "$PROD_ENABLED_PATH"
        fi
        if [ -n "$STAGE_LINK_PATH" ] && [ -n "$STAGE_CONF_PATH" ]; then
          info "Restoring staged SSL symlink: $STAGE_LINK_PATH -> $STAGE_CONF_PATH"
          ln -sfn "$STAGE_CONF_PATH" "$STAGE_LINK_PATH"
        fi
      fi
    fi

    # Restore the old ACME state only when issuance did not produce a usable
    # certificate. Once a certificate exists, preserve it for recovery instead
    # of destroying the successful issuance during an Nginx-side rollback.
    if [ "$ECC_STATE_CHANGED" = "yes" ] && [ "$CERT_ISSUED" != "yes" ]; then
      if [ -n "$ECC_BACKUP" ] && [ -d "$ECC_BACKUP" ]; then
        info "Restoring ECC backup from: $ECC_BACKUP -> $ECC_DIR"
        rm -rf "$ECC_DIR"
        cp -a "$ECC_BACKUP" "$ECC_DIR"
      elif [ -d "$ECC_DIR" ]; then
        info "Removing newly-created ECC state after failed issuance: $ECC_DIR"
        rm -rf "$ECC_DIR"
      fi
    elif [ "$CERT_ISSUED" = "yes" ]; then
      warn "Preserving the issued certificate at $ECC_DIR for recovery. Review Nginx configuration before retrying."
    fi

    # Validate & reload only if nginx exists
    if command -v nginx >/dev/null 2>&1; then
      info "Validating nginx config after rollback (nginx -t)..."
      if nginx -t; then
        systemctl reload nginx || warn "Nginx reload failed after rollback. Run: nginx -t ; systemctl status nginx"
      else
        warn "nginx -t failed after rollback. Run: nginx -t ; systemctl status nginx"
      fi
    fi
  fi

  warn "Rollback complete. Exiting."
  exit 1
}

on_exit() {
  # Do not auto-rollback on normal exit; rollback is explicit via traps/errors.
  :
}

trap 'rollback "received interrupt/signal"' INT TERM HUP
trap 'rollback "command failed at line $LINENO"' ERR
trap 'on_exit' EXIT

# ---------- Preflight ----------
require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    die "This script must be run as root (use: sudo -i)."
  fi
}

require_bin() {
  local b="$1" hint="$2"
  command -v "$b" >/dev/null 2>&1 || die "Required binary missing: '$b'. ${hint}"
}

require_file_exec() {
  local f="$1"
  [ -x "$f" ] || die "Required executable not found or not executable: $f"
}

# ---------- Domain validation ----------
validate_domain() {
  local d="$1"
  # Accept letters/digits/dots/hyphens; reject empty, spaces, slashes, leading dot, trailing dot handled separately.
  if [ -z "$d" ]; then
    die "Domain is empty. Provide a fully-qualified domain like: example.com"
  fi
  if [[ "$d" =~ [[:space:]/\\] ]]; then
    die "Domain '$d' contains spaces or slashes. Provide a plain FQDN only."
  fi
  d="${d%.}" # strip trailing dot (harmless)
  if ! [[ "$d" =~ ^[A-Za-z0-9.-]+$ ]]; then
    die "Domain '$d' contains invalid characters. Allowed: A-Z a-z 0-9 dot (.) hyphen (-)."
  fi
  if [[ "$d" == .* ]] || [[ "$d" == *..* ]] || [[ "$d" == *.-* ]] || [[ "$d" == *-.* ]]; then
    warn "Domain '$d' looks unusual (leading dot/double dot/dangling hyphen patterns). Double-check spelling."
  fi
  echo "$d"
}

# ---------- Flow selection ----------
select_run_mode() {
  local mode_in="${1:-}"
  if [ -z "$mode_in" ]; then
    read -r -p "INPUT: choose certificate flow [renew/new] (default: renew): " mode_in || true
  fi
  case "${mode_in,,}" in
    ""|renew|r) echo "renew" ;;
    new|n)      echo "new" ;;
    *)
      die "Invalid flow '$mode_in'. Expected: renew or new."
      ;;
  esac
}

# ---------- Nginx prod entry detection ----------
detect_prod_enabled_entry() {
  local d="$1"
  local c1="${NGINX_ENABLED}/${d}.conf"
  local c2="${NGINX_ENABLED}/${d}"
  local found=""

  if [ -e "$c1" ]; then
    found="$c1"
  elif [ -e "$c2" ]; then
    found="$c2"
  else
    # Try strict match in directory listing (no globbing in filesystem ops)
    local matches
    matches="$(find "$NGINX_ENABLED" -mindepth 1 -maxdepth 1 -printf '%f\n' 2>/dev/null | awk -v d="$d" '$0==d || $0==(d".conf") {print $0}' || true)"
    if [ -n "$matches" ]; then
      found="${NGINX_ENABLED}/$(echo "$matches" | head -n 1)"
      warn "Multiple candidates may exist; selecting first match: $found"
    fi
  fi

  if [ -z "$found" ] && [ -d "$TEMP_DIR" ]; then
    local candidate candidate_target expected_prod
    expected_prod="${NGINX_ENABLED}/${d}.conf"
    while IFS= read -r candidate; do
      [ -n "$candidate" ] || continue
      candidate_target="$(readlink -f "$candidate" 2>/dev/null || true)"
      case "$candidate_target" in
        "${NGINX_AVAILABLE}/${d}.conf"|"${NGINX_AVAILABLE}/${d}")
          warn "Recovering orphaned production entry: $candidate -> $expected_prod"
          mv -f "$candidate" "$expected_prod"
          found="$expected_prod"
          break
          ;;
      esac
    done < <(
      find "$TEMP_DIR" -mindepth 1 -maxdepth 1 \( -name "${d}.conf*" -o -name "$d" \) \
        -printf '%T@ %p\n' 2>/dev/null \
        | sort -nr \
        | cut -d' ' -f2-
    )
  fi

  [ -n "$found" ] || die "Could not find production enabled site entry for '$d' in $NGINX_ENABLED.
Expected one of:
  - ${NGINX_ENABLED}/${d}.conf
  - ${NGINX_ENABLED}/${d}
Fix: create/enable the site entry or adjust detection logic for your naming."

  echo "$found"
}

validate_production_enabled_entry() {
  local domain="$1" enabled_path="$2" real_target
  real_target="$(readlink -f "$enabled_path" 2>/dev/null || true)"

  case "$real_target" in
    "${NGINX_AVAILABLE}/${domain}.conf"|"${NGINX_AVAILABLE}/${domain}")
      return 0
      ;;
  esac

  die "Enabled entry for '$domain' is not the production configuration: $enabled_path -> ${real_target:-unresolved}.
The renewal workflow will not treat a staged HTTP-only config as production.
Restore it with:
  sudo ln -sfn ${NGINX_AVAILABLE}/${domain}.conf ${NGINX_ENABLED}/${domain}.conf
Then run: sudo nginx -t && sudo systemctl reload nginx"
}

detect_prod_available_entry() {
  local d="$1"
  local c1="${NGINX_AVAILABLE}/${d}.conf"
  local c2="${NGINX_AVAILABLE}/${d}"
  local found=""

  if [ -f "$c1" ]; then
    found="$c1"
  elif [ -f "$c2" ]; then
    found="$c2"
  fi

  [ -n "$found" ] || die "Could not find production site config for '$d' in $NGINX_AVAILABLE.
Expected one of:
  - ${NGINX_AVAILABLE}/${d}.conf
  - ${NGINX_AVAILABLE}/${d}
Fix: place your full 80/443 production config in sites-available."

  echo "$found"
}

detect_stage_conf() {
  local d="$1"
  local p1="${SSL_REPO}/${d}_ssl.conf"
  local p2="${SSL_REPO}/${d}_ssl"
  local found=""

  if [ -f "$p1" ]; then
    found="$p1"
  elif [ -f "$p2" ]; then
    found="$p2"
  fi

  [ -n "$found" ] || die "Staged SSL config not found for '$d'.
Expected: ${SSL_REPO}/${d}_ssl.conf
Fix: create that file or adjust SSL_REPO path."

  echo "$found"
}

detect_stage_enabled_entry() {
  local d="$1"
  local c1="${NGINX_ENABLED}/${d}_ssl.conf"
  local c2="${NGINX_ENABLED}/${d}_ssl"
  local found=""

  if [ -e "$c1" ]; then
    found="$c1"
  elif [ -e "$c2" ]; then
    found="$c2"
  fi

  [ -n "$found" ] || die "Enabled staged SSL entry not found for '$d' in $NGINX_ENABLED.
Expected one of:
  - ${NGINX_ENABLED}/${d}_ssl.conf (symlink preferred)
  - ${NGINX_ENABLED}/${d}_ssl
Fix: enable your staged SSL config symlink before running NEW flow."

  if [ ! -L "$found" ]; then
    warn "Expected a symlink for staged SSL entry, but found a non-symlink path: $found"
  fi

  echo "$found"
}

# ---------- DNS helpers (public + authoritative) ----------
dig_txt_short() {
  local fqdn="$1" server="$2"
  # Normalize quotes; TXT can return multiple quoted segments; join lines for match checks.
  dig +short TXT "$fqdn" @"$server" 2>/dev/null | tr -d '"' | sed '/^\s*$/d' || true
}

detect_zone_apex() {
  local name="$1" soa owner
  while :; do
    soa="$(dig +noall +authority SOA "$name" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$soa" ]; then
      owner="$(awk '{print $1}' <<<"$soa")"
      echo "${owner%.}"
      return 0
    fi

    soa="$(dig +noall +answer SOA "$name" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$soa" ]; then
      owner="$(awk '{print $1}' <<<"$soa")"
      echo "${owner%.}"
      return 0
    fi

    if [[ "$name" != *.* ]]; then
      return 1
    fi
    name="${name#*.}"
  done
}

get_auth_ns_list() {
  local zone="$1" resolver ns_list
  for resolver in "${PUBLIC_RESOLVERS[@]}" ""; do
    if [ -n "$resolver" ]; then
      ns_list="$(dig +time=3 +tries=1 +short NS "$zone" @"$resolver" 2>/dev/null || true)"
    else
      ns_list="$(dig +time=3 +tries=1 +short NS "$zone" 2>/dev/null || true)"
    fi
    ns_list="$(sed 's/\.$//' <<<"$ns_list" | sed '/^\s*$/d')"
    if [ -n "$ns_list" ]; then
      printf '%s\n' "$ns_list"
      return 0
    fi
  done
  return 1
}

resolve_ns_ips() {
  local ns="$1"
  local ips4 ips6=""
  ips4="$(dig +short A "$ns" 2>/dev/null | sed '/^\s*$/d' || true)"
  if [ "$CHECK_AUTH_IPV6" = "yes" ]; then
    ips6="$(dig +short AAAA "$ns" 2>/dev/null | sed '/^\s*$/d' || true)"
  fi
  { [ -n "$ips4" ] && echo "$ips4"; [ -n "$ips6" ] && echo "$ips6"; } | sed '/^\s*$/d' || true
}

dig_txt_authoritative_verbose() {
  local fqdn="$1" ip="$2" out
  # Prefer UDP, then retry over TCP for nameservers that drop large or IPv6 UDP responses.
  out="$(dig +time=2 +tries=1 +norecurse +noall +comments +answer TXT "$fqdn" @"$ip" 2>/dev/null || true)"
  if ! grep -q '^;; ->>HEADER<<-' <<<"$out"; then
    out="$(dig +tcp +time=3 +tries=1 +norecurse +noall +comments +answer TXT "$fqdn" @"$ip" 2>/dev/null || true)"
  fi
  printf '%s\n' "$out"
}

# Check that acme.sh produced usable cert/key artifacts (best-effort sanity gate).
cert_files_present() {
  local dir="$1"
  [ -s "${dir}/fullchain.cer" ] && [ -s "${dir}/${DOMAIN}.key" ]
}

# Returns 0 if expected present (or any TXT present if expected empty), else 1.
check_public_resolvers() {
  local fqdn="$1" expected="${2:-}"
  local ok_any="no"
  local r out

  echo
  info "Public resolver check for TXT: $fqdn"
  for r in "${PUBLIC_RESOLVERS[@]}"; do
    out="$(dig_txt_short "$fqdn" "$r")"
    if [ -z "$out" ]; then
      warn "Resolver @$r: no TXT answer yet (could be propagation delay or record missing)."
      continue
    fi

    info "Resolver @$r returned TXT:"
    while IFS= read -r line; do
      printf '  - %s\n' "$line"
    done <<<"$out"

    if [ -n "$expected" ]; then
      # Use -- to avoid treating leading '-' in tokens as options.
      if echo "$out" | grep -Fq -- "$expected"; then
        info "Resolver @$r: MATCH (expected token present)."
        ok_any="yes"
      else
        warn "Resolver @$r: MISMATCH (token differs). Expected: '$expected'. Check you pasted the exact value from acme.sh (no extra quotes/spaces)."
      fi
    else
      ok_any="yes"
    fi
  done

  [ "$ok_any" = "yes" ]
}

# Returns 0 if any authoritative NS IP shows expected present (or any TXT present if expected empty), else 1.
check_authoritative_ns() {
  local fqdn="$1" expected="${2:-}"
  local zone ns_list ns ip out header answers ok_any="no"

  echo
  info "Authoritative nameserver check for TXT: $fqdn"

  zone="$(detect_zone_apex "$DOMAIN" || true)"
  if [ -z "$zone" ]; then
    warn "Could not detect zone apex via SOA for '$DOMAIN'. Skipping authoritative NS check (will rely on public resolvers)."
    return 1
  fi
  info "Detected zone apex (SOA owner): $zone"

  ns_list="$(get_auth_ns_list "$zone")"
  if [ -z "$ns_list" ]; then
    warn "No NS records returned for zone '$zone'. Skipping authoritative NS check (will rely on public resolvers)."
    return 1
  fi
  info "Authoritative NS for '$zone':"
  while IFS= read -r line; do
    printf '  - %s\n' "$line"
  done <<<"$ns_list"

  while read -r ns; do
    [ -n "$ns" ] || continue
    while read -r ip; do
      [ -n "$ip" ] || continue

      out="$(dig_txt_authoritative_verbose "$fqdn" "$ip")"
      header="$(grep -m1 '^;; ->>HEADER<<-' <<<"$out" || true)"
      answers="$(grep -v '^;;' <<<"$out" | sed '/^\s*$/d' || true)"

      if [ -z "$header" ]; then
        warn "Authoritative '$ns' ($ip): no DNS header returned. Possible firewall/UDP issues. Try: dig +tcp TXT $fqdn @$ip"
        continue
      fi

      if grep -q 'status: SERVFAIL' <<<"$header"; then
        warn "Authoritative '$ns' ($ip): SERVFAIL for '$fqdn' (transient NS failure or upstream issue)."
        continue
      fi
      if grep -q 'status: REFUSED' <<<"$header"; then
        warn "Authoritative '$ns' ($ip): REFUSED for '$fqdn' (policy restriction). Try TCP: dig +tcp TXT $fqdn @$ip"
        continue
      fi
      if grep -q 'status: NXDOMAIN' <<<"$header"; then
        warn "Authoritative '$ns' ($ip): NXDOMAIN for '$fqdn'. Likely record name wrong or created in the wrong zone/account."
        continue
      fi

      if [ -z "$answers" ]; then
        warn "Authoritative '$ns' ($ip): NOERROR but no TXT answers yet (record not present on this NS or not propagated between NS)."
        continue
      fi

      info "Authoritative '$ns' ($ip) answers:"
      while IFS= read -r line; do
        printf '  %s\n' "$line"
      done <<<"$answers"

      if [ -n "$expected" ]; then
        if echo "$answers" | grep -Fq -- "\"$expected\"" || echo "$answers" | grep -Fq -- "$expected"; then
          info "Authoritative '$ns' ($ip): MATCH (expected token present)."
          ok_any="yes"
        else
          warn "Authoritative '$ns' ($ip): MISMATCH. Expected: '$expected'. Verify TXT value exactly (no extra quoting/spaces)."
        fi
      else
        ok_any="yes"
      fi
    done < <(resolve_ns_ips "$ns" || true)
  done <<<"$ns_list"

  [ "$ok_any" = "yes" ]
}

# ---------- acme.sh output parsing (best-effort; prompts if parsing fails) ----------
parse_expected_txt_from_issue_output() {
  local fqdn="$1" issue_out="$2"
  # acme.sh manual DNS typically prints blocks:
  #   Domain: '_acme-challenge.example.com'
  #   TXT value: 'TOKEN'
  awk -v fqdn="$fqdn" '
    BEGIN{IGNORECASE=1; inblk=0}
    $0 ~ /Domain:/ && $0 ~ fqdn {inblk=1; next}
    inblk && $0 ~ /TXT value:/ {
      sub(/.*TXT value:[[:space:]]*/, "", $0)
      gsub(/^[ "\x27]+|[ "\x27]+$/, "", $0)   # trim spaces/quotes (incl apostrophe 0x27)
      print $0
      exit
    }
  ' "$issue_out" | head -n 1
}

# ---------- Main ----------
main() {
  local mode_arg=""
  local domain_arg=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --mode)
        [ "$#" -ge 2 ] || die "Missing value for --mode. Usage: $0 [--domain FQDN] [--mode renew|new]"
        mode_arg="$2"
        shift 2
        ;;
      --domain)
        [ "$#" -ge 2 ] || die "Missing value for --domain. Usage: $0 [--domain FQDN] [--mode renew|new]"
        domain_arg="$2"
        shift 2
        ;;
      --help|-h)
        cat <<'USAGE'
Usage: acme_dns_manual_nginx_swap.sh [--domain FQDN] [--mode renew|new]

Without --domain, the script prompts for the domain.

Operator instructions:
  1. Confirm the domain and mode before continuing.
  2. Keep DNS provider access ready for the apex and www TXT records.
  3. Paste the exact acme.sh TXT values without quotes or extra spaces.
  4. Wait for public and authoritative DNS checks to pass.
  5. Approve certificate installation only after the checks pass.
  6. After SUCCESS, verify the served certificate and run:
       TARGET_URL=https://FQDN npm run test:strict

Modes:
  renew  Existing production Nginx entry is swapped to staged SSL, then restored.
  new    Existing staged SSL entry remains active until production is enabled.

NEW WORKFLOW INSTRUCTIONS:
  1. Put the staged challenge config at:
       /etc/nginx/sites-available/ssl_conf_repo/FQDN_ssl.conf
  2. Enable it as:
       /etc/nginx/sites-enabled/FQDN_ssl.conf
  3. Put the complete production 80/443 config at:
       /etc/nginx/sites-available/FQDN.conf
  4. Validate the staged configuration with nginx -t.
  5. Run:
       sudo ./acme_dns_manual_nginx_swap.sh --domain FQDN --mode new
  6. Complete both DNS TXT challenges and approve installation.
  7. The script installs the certificate, switches the enabled link to
     FQDN.conf, reloads Nginx, and verifies the served certificate.

Safety:
  The workflow is interactive, serialized by a lock, and stops on failed checks.
  After the SSL staging swap, enter 'r' or 'restore' at any prompt to restore
  the full pre-swap Nginx configuration, reload Nginx, and quit safely.
USAGE
        return 0
        ;;
      *)
        die "Unknown argument '$1'. Usage: $0 [--domain FQDN] [--mode renew|new]"
        ;;
    esac
  done

  require_root
  acquire_lock

  require_bin flock "Install util-linux (usually already present)."
  require_bin nginx "Install nginx or adjust script to your web server."
  require_bin systemctl "This script expects systemd."
  require_bin dig "Install 'dnsutils' (Ubuntu): apt-get install -y dnsutils"
  require_bin openssl "Install openssl for final verification (optional but recommended)."
  require_file_exec "$ACME"

  mkdir -p "$TEMP_DIR" "$LOG_DIR"

  echo
  if [ -n "$domain_arg" ]; then
    DOMAIN="$(validate_domain "$domain_arg")"
  else
    read -r -p "INPUT: enter domain name (e.g., example.com): " DOMAIN_RAW || true
    DOMAIN="$(validate_domain "${DOMAIN_RAW:-}")"
  fi
  WWW="www.${DOMAIN}"
  RUN_MODE="$(select_run_mode "$mode_arg")"
  ECC_DIR="/root/.acme.sh/${DOMAIN}_ecc"

  LOG_FILE="${LOG_DIR}/acme-dns-manual-${DOMAIN}-$(date +%F-%H%M%S).log"
  # Start logging AFTER we know the domain for per-domain log filenames.
  exec > >(tee -a "$LOG_FILE") 2>&1
  info "Logging to: $LOG_FILE"
  info "Selected certificate flow: $RUN_MODE"

  info "Set default CA to Let's Encrypt"
  run "$ACME" --set-default-ca --server letsencrypt

  info "Show acme.sh certificate list"
  run "$ACME" --list

  info "Show acme.sh certificate information"
  run "$ACME" --info -d "$DOMAIN" --ecc || warn "No existing ECC info for $DOMAIN (this is ok if you're re-issuing)."
  if [ "$WWW" != "$DOMAIN" ]; then
    info "SAN note: acme.sh stores the SAN entry for $WWW inside the same config dir as $DOMAIN (usually ${ECC_DIR}/${DOMAIN}.conf). A separate www.* conf directory is not created."
  fi

  if [ "$RUN_MODE" = "renew" ]; then
    # Detect production enabled entry + staged SSL conf
    PROD_ENABLED_PATH="$(detect_prod_enabled_entry "$DOMAIN")"
    validate_production_enabled_entry "$DOMAIN" "$PROD_ENABLED_PATH"
    STAGE_CONF_PATH="$(detect_stage_conf "$DOMAIN")"
    STAGE_LINK_PATH="${NGINX_ENABLED}/$(basename "$PROD_ENABLED_PATH")"

    info "Detected production enabled entry: $PROD_ENABLED_PATH"
    info "Staged SSL conf to enable: $STAGE_CONF_PATH"
    info "Staged symlink path will be: $STAGE_LINK_PATH"

    # Swap nginx: move prod -> temp, enable stage
    info "Move production entry to temporary storage: $TEMP_DIR"
    local moved_target
    moved_target="${TEMP_DIR}/$(basename "$PROD_ENABLED_PATH")"
    if [ -e "$moved_target" ]; then
      moved_target="${moved_target}.bak.$(date +%F-%H%M%S)"
      warn "Temp target already existed; using unique name: $moved_target"
    fi
    run mv -f "$PROD_ENABLED_PATH" "$moved_target"
    PROD_MOVED_PATH="$moved_target"
    ROLLBACK_NEEDED="yes"

    info "Enable staged SSL configuration"
    run ln -sfn "$STAGE_CONF_PATH" "$STAGE_LINK_PATH"

    info "Validate and reload Nginx after staging swap"
    validate_reload_nginx

    echo
    info "Checkpoint: Nginx staging swap is active (RENEW flow)."
    if ! ask_yes_no "Report SUCCESS so far and proceed to acme issue/renew for '$DOMAIN' and '$WWW'?"; then
      rollback "user chose not to proceed at checkpoint"
    fi
  else
    # NEW flow: staged SSL link already enabled; production full config lives in sites-available.
    STAGE_LINK_PATH="$(detect_stage_enabled_entry "$DOMAIN")"
    STAGE_CONF_PATH="$(readlink -f "$STAGE_LINK_PATH" 2>/dev/null || true)"
    [ -n "$STAGE_CONF_PATH" ] || STAGE_CONF_PATH="$STAGE_LINK_PATH"

    PROD_AVAILABLE_PATH="$(detect_prod_available_entry "$DOMAIN")"
    PROD_ENABLED_PATH="${NGINX_ENABLED}/$(basename "$PROD_AVAILABLE_PATH")"

    if [ "$PROD_ENABLED_PATH" = "$STAGE_LINK_PATH" ]; then
      die "NEW flow conflict: production enabled path equals staged SSL link path ($PROD_ENABLED_PATH). Ensure staged link uses *_ssl naming and production file is ${NGINX_AVAILABLE}/${DOMAIN}.conf."
    fi

    info "Detected staged SSL enabled entry (already active): $STAGE_LINK_PATH"
    info "Resolved staged SSL config target: $STAGE_CONF_PATH"
    info "Detected production config in sites-available: $PROD_AVAILABLE_PATH"
    info "Production symlink target path (to be enabled later): $PROD_ENABLED_PATH"

    info "Validate and reload Nginx with staged SSL active"
    validate_reload_nginx

    echo
    info "Checkpoint: Existing staged SSL symlink is active (NEW flow)."
    ROLLBACK_NEEDED="yes"
    if ! ask_yes_no "Proceed to issue/renew cert for '$DOMAIN' and '$WWW' using NEW flow?"; then
      rollback "user chose not to proceed at checkpoint"
    fi
  fi

  pause_enter "Prepare to add TWO DNS TXT records in your DNS provider when prompted by acme.sh. Ensure you can edit the zone now."

  # Backup ECC entry
  if [ -d "$ECC_DIR" ]; then
    ECC_BACKUP="${ECC_DIR}.bak.$(date +%F-%H%M%S)"
    info "Back up the existing ECC certificate state"
    run cp -a "$ECC_DIR" "$ECC_BACKUP"
  else
    warn "ECC directory not found at $ECC_DIR. This is ok if you're issuing fresh; backup skipped."
  fi

  # Preserve the existing ACME state until the replacement certificate is verified.
  # --force makes acme.sh issue a fresh certificate without deleting the current one first.
  ECC_STATE_CHANGED="yes"
  info "Preserving existing ECC state while issuing the replacement certificate"

  # Issue (manual DNS) - capture output for TXT parsing
  local issue_out issue_rc cert_ready_after_issue="no"
  issue_out="$(mktemp)"
  info "Issue certificate with manual DNS; acme.sh will print the required TXT records"
  set +e
  "$ACME" --issue \
    -d "$DOMAIN" -d "$WWW" \
    --keylength ec-256 \
    --force \
    --dns \
    --yes-I-know-dns-manual-mode-enough-go-ahead-please \
    --dnssleep 120 \
    --debug 2 2>&1 | tee "$issue_out"
  issue_rc="${PIPESTATUS[0]}"
  set -e
  if [ "$issue_rc" -ne 0 ]; then
    if grep -qi "DNS record not yet added" "$issue_out" || grep -qi "Please add the TXT records" "$issue_out"; then
      warn "acme.sh --issue exited $issue_rc because TXT records are not yet added (manual DNS). Continuing to propagation checks with the printed tokens."
    else
      err "acme.sh --issue failed (exit $issue_rc). Inspect output above and log: $LOG_FILE"
      err "Common fixes: wrong DNS provider zone, blocked outbound DNS, or acme.sh account/CA issues."
      rollback "acme.sh --issue failed"
    fi
  else
    if cert_files_present "$ECC_DIR"; then
      cert_ready_after_issue="yes"
      info "Decision: acme.sh --issue already produced a certificate (TXT likely still present/valid)."
    else
      warn "acme.sh --issue exited 0 but no cert files were found in $ECC_DIR. Will continue with DNS checks and a renew attempt."
    fi
  fi

  # Parse expected TXT values (best-effort)
  local expected_apex expected_www
  expected_apex="$(parse_expected_txt_from_issue_output "_acme-challenge.${DOMAIN}" "$issue_out" || true)"
  expected_www="$(parse_expected_txt_from_issue_output "_acme-challenge.${WWW}" "$issue_out" || true)"

  echo
  if [ -n "$expected_apex" ] && [ -n "$expected_www" ]; then
    info "Parsed expected TXT values from acme.sh output:"
    info "  _acme-challenge.${DOMAIN}      TXT: $expected_apex"
    info "  _acme-challenge.${WWW}         TXT: $expected_www"
  elif [ "$cert_ready_after_issue" = "yes" ]; then
    warn "acme.sh already completed issuance; its successful output did not include TXT challenge blocks."
    info "Using presence checks for the currently published TXT records instead of asking for duplicate token input."
    expected_apex=""
    expected_www=""
  else
    warn "Could not reliably parse both TXT values from acme.sh output."
    warn "This can happen if acme.sh output format differs or the provider prints multi-line tokens."
    echo
    read_txt_value_or_restore "Paste TXT value for _acme-challenge.${DOMAIN} (no surrounding quotes)" expected_apex
    read_txt_value_or_restore "Paste TXT value for _acme-challenge.${WWW} (no surrounding quotes)" expected_www
  fi

  if [ "$cert_ready_after_issue" = "yes" ]; then
    pause_enter "TXT records appear to be already present/valid; press Enter to continue to DNS verification."
  else
    pause_enter "Proceed with BOTH DNS TXT record additions now. When completed, press Enter here."
  fi

  # Propagation loop
  while true; do
    echo
    info "DNS propagation verification (public resolvers + authoritative NS)"

    local ok_pub_apex="no" ok_pub_www="no" ok_auth_apex="no" ok_auth_www="no"

    if check_public_resolvers "_acme-challenge.${DOMAIN}" "$expected_apex"; then ok_pub_apex="yes"; fi
    if check_public_resolvers "_acme-challenge.${WWW}"    "$expected_www";  then ok_pub_www="yes";  fi

    if check_authoritative_ns "_acme-challenge.${DOMAIN}" "$expected_apex"; then ok_auth_apex="yes"; fi
    if check_authoritative_ns "_acme-challenge.${WWW}"    "$expected_www";  then ok_auth_www="yes";  fi

    echo
    info "DNS check summary:"
    info "  Public resolvers: apex=$ok_pub_apex  www=$ok_pub_www"
    info "  Authoritative NS: apex=$ok_auth_apex www=$ok_auth_www"

    if [ "$ok_pub_apex" = "yes" ] && [ "$ok_pub_www" = "yes" ] && [ "$ok_auth_apex" = "yes" ] && [ "$ok_auth_www" = "yes" ]; then
      info "DNS appears propagated (public + authoritative checks passed)."
      break
    fi

    warn "DNS not fully propagated yet."
    warn "Guidance: wait 2–10 minutes, ensure you created records in the correct DNS zone, and confirm no old TXT records conflict."
    echo
    local quit_action="rollback and quit"
    if [ "$RUN_MODE" = "renew" ]; then
      quit_action="restore nginx config and quit"
    fi
    read -r -p "ACTION: press 't' to try again, or 'r' to restore and quit (${quit_action}): " choice || rollback "input closed at restore checkpoint"
    case "${choice,,}" in
      t) continue ;;
      r|restore|q|quit) rollback "operator requested full configuration restore during DNS propagation" ;;
      *) warn "Unrecognized choice '$choice'. Type 't' to retry or 'r' to restore and quit." ;;
    esac
  done

  # Decide if renew is needed
  local renew_needed="yes"
  local renew_force_flag=""
  if [ "$cert_ready_after_issue" = "yes" ]; then
    renew_needed="no"
    info "Decision: acme.sh already issued a cert during --issue. Skipping --renew to avoid a non-due skip."
  else
    renew_force_flag="--force"
  fi

  if [ "$renew_needed" = "yes" ]; then
    echo
    if ! ask_yes_no "Ready to run acme.sh --renew now (manual DNS, ECC) for '$DOMAIN' and '$WWW'?"; then
      rollback "user declined renew step"
    fi

    # Renew (force when we haven't produced a cert yet)
    local renew_out renew_rc
    renew_out="$(mktemp)"
    info "Renew certificate with manual DNS and ECC"
    local renew_cmd=( "$ACME" --renew -d "$DOMAIN" -d "$WWW" --ecc --dns --yes-I-know-dns-manual-mode-enough-go-ahead-please --debug 2 )
    [ -n "$renew_force_flag" ] && renew_cmd+=( "$renew_force_flag" )
    set +e
    "${renew_cmd[@]}" 2>&1 | tee "$renew_out"
    renew_rc="${PIPESTATUS[0]}"
    set -e

    if [ "$renew_rc" -ne 0 ]; then
      if grep -qi "Next renewal time is" "$renew_out"; then
        warn "acme.sh --renew reported 'not due yet'. Treating as non-fatal if cert files exist."
      else
        err "acme.sh --renew failed (exit $renew_rc)."
        err "Common causes: TXT mismatch, TXT not reachable by CA yet, multiple conflicting TXT records, or timing."
        if ask_yes_no "Retry renew now?"; then
          info "Retrying renew..."
          run "${renew_cmd[@]}"
        else
          rollback "renew failed and user chose not to retry"
        fi
      fi
    fi
  fi

  # Ensure cert artifacts exist before proceeding
  if cert_files_present "$ECC_DIR"; then
    CERT_ISSUED="yes"
    info "Cert/key artifacts present under $ECC_DIR. Proceeding to install."
  else
    rollback "expected certificate files missing after issue/renew"
  fi

  info "Show certificate information after issuance"
  run "$ACME" --info -d "$DOMAIN" --ecc
  run "$ACME" --info -d "$WWW"    --ecc
  run "$ACME" --list

  echo
  if [ "$RUN_MODE" = "renew" ]; then
    if ! ask_yes_no "Proceed to restore production nginx config and install the cert paths?"; then
      rollback "user chose not to restore/install after successful renew"
    fi
  else
    if ! ask_yes_no "Proceed to install cert paths and enable production config from sites-available?"; then
      rollback "user chose not to enable production config after successful issue/renew"
    fi
  fi

  # RENEW flow: restore prod nginx config (remove staged symlink and move back prod)
  if [ "$RUN_MODE" = "renew" ]; then
    info "Remove staged SSL configuration"
    if [ -L "$STAGE_LINK_PATH" ]; then
      run rm -f "$STAGE_LINK_PATH"
    else
      warn "Expected staged symlink not found at $STAGE_LINK_PATH (it may have been modified). Continuing."
    fi

    info "Restore production configuration"
    if [ -e "$PROD_MOVED_PATH" ]; then
      run mv -f "$PROD_MOVED_PATH" "$PROD_ENABLED_PATH"
    else
      die "Production entry missing in temp location ($PROD_MOVED_PATH). Cannot safely restore. Restore manually and rerun nginx -t."
    fi
  fi

  # Resolve production config path for ssl_certificate extraction.
  local prod_real prod_conf ssl_cert ssl_key installed_cert_path
  installed_cert_path=""
  if [ "$RUN_MODE" = "renew" ]; then
    prod_real="$(readlink -f "$PROD_ENABLED_PATH" 2>/dev/null || true)"
    prod_conf="${prod_real:-$PROD_ENABLED_PATH}"
  else
    prod_conf="$PROD_AVAILABLE_PATH"
  fi

  ssl_cert="$(awk '
    $1=="ssl_certificate" {
      gsub(/;$/, "", $2); print $2; exit
    }' "$prod_conf" 2>/dev/null || true)"

  ssl_key="$(awk '
    $1=="ssl_certificate_key" {
      gsub(/;$/, "", $2); print $2; exit
    }' "$prod_conf" 2>/dev/null || true)"

  if [ -n "$ssl_cert" ] && [ -n "$ssl_key" ]; then
    info "Detected ssl_certificate paths from production config:"
    info "  ssl_certificate:     $ssl_cert"
    info "  ssl_certificate_key: $ssl_key"
    mkdir -p "$(dirname "$ssl_cert")" "$(dirname "$ssl_key")" || true

    info "Install certificate using paths detected from the production Nginx config"
    run "$ACME" --install-cert -d "$DOMAIN" --ecc \
      --key-file       "$ssl_key" \
      --fullchain-file "$ssl_cert" \
      --reloadcmd      "true"
    installed_cert_path="$ssl_cert"
  else
    warn "Could not detect ssl_certificate / ssl_certificate_key in production config: $prod_conf"
    warn "Fallback: installing cert to /etc/ssl/acme/${DOMAIN}/ (you must ensure nginx references these paths or already references acme.sh live paths)."

    local fallback_dir="/etc/ssl/acme/${DOMAIN}"
    mkdir -p "$fallback_dir"
    local fb_key="${fallback_dir}/privkey.ec-256.pem"
    local fb_chain="${fallback_dir}/fullchain.ec-256.pem"
    ssl_key="$fb_key"
    ssl_cert="$fb_chain"

    run "$ACME" --install-cert -d "$DOMAIN" --ecc \
      --key-file       "$fb_key" \
      --fullchain-file "$fb_chain" \
      --reloadcmd      "true"
    installed_cert_path="$fb_chain"
  fi

  if [ "$RUN_MODE" = "new" ]; then
    info "Switch the enabled entry from staged SSL to production"
    if [ -L "$STAGE_LINK_PATH" ]; then
      run rm -f "$STAGE_LINK_PATH"
    else
      warn "Expected staged ssl symlink not found at $STAGE_LINK_PATH. Continuing."
    fi

    if [ -e "$PROD_ENABLED_PATH" ]; then
      if [ -L "$PROD_ENABLED_PATH" ]; then
        run rm -f "$PROD_ENABLED_PATH"
      else
        die "Target production enabled path exists and is not a symlink: $PROD_ENABLED_PATH"
      fi
    fi

    run ln -sfn "$PROD_AVAILABLE_PATH" "$PROD_ENABLED_PATH"
    NEW_MODE_LINK_SWITCHED="yes"
  fi

  if [ "$RUN_MODE" = "new" ]; then
    local nginx_dump
    if ! nginx_dump="$(nginx -T 2>&1)"; then
      rollback "Nginx test could not load the NEW production configuration"
    fi
    if ! grep -Fq "server_name ${DOMAIN} ${WWW};" <<<"$nginx_dump"; then
      rollback "NEW production server_name was not loaded by Nginx"
    fi
    if ! grep -Fq "ssl_certificate ${ssl_cert};" <<<"$nginx_dump" || \
      ! grep -Fq "ssl_certificate_key ${ssl_key};" <<<"$nginx_dump"; then
      rollback "NEW production certificate paths were not loaded by Nginx"
    fi
  fi

  info "Validate and reload Nginx after certificate installation"
  validate_reload_nginx

  # Final verification. Require the running origin Nginx workers to serve the
  # exact certificate installed above. The public hostname may be proxied by
  # Cloudflare, which intentionally presents Cloudflare's edge certificate;
  # therefore this check must connect to the local origin while preserving SNI.
  # Poll after reload because graceful Nginx reloads can leave old workers
  # alive briefly.
  echo
  info "Final verify: compare installed and served origin certificates (127.0.0.1:443 with SNI ${DOMAIN})"
  local served_cert_file installed_fingerprint served_fingerprint served_verified="no" attempt
  if ! openssl x509 -in "$installed_cert_path" -noout -checkhost "$DOMAIN" >/dev/null 2>&1 || \
     ! openssl x509 -in "$installed_cert_path" -noout -checkhost "$WWW" >/dev/null 2>&1; then
    rollback "the installed certificate does not cover both $DOMAIN and $WWW"
  fi
  installed_fingerprint="$(openssl x509 -in "$installed_cert_path" -noout -fingerprint -sha256)"
  for attempt in $(seq 1 20); do
    served_cert_file="$(mktemp)"
    if openssl s_client -4 -servername "$DOMAIN" -connect "127.0.0.1:443" </dev/null 2>/dev/null \
      | openssl x509 -out "$served_cert_file" 2>/dev/null && \
      openssl x509 -in "$served_cert_file" -noout -checkhost "$DOMAIN" >/dev/null 2>&1 && \
      openssl x509 -in "$served_cert_file" -noout -checkhost "$WWW" >/dev/null 2>&1; then
      served_fingerprint="$(openssl x509 -in "$served_cert_file" -noout -fingerprint -sha256)"
      if [ -n "$installed_fingerprint" ] && [ "$installed_fingerprint" = "$served_fingerprint" ]; then
        info "Nginx is serving the installed certificate for $DOMAIN and $WWW."
        openssl x509 -in "$served_cert_file" -noout -subject -issuer -dates
        served_verified="yes"
        rm -f "$served_cert_file"
        break
      fi
    fi
    rm -f "$served_cert_file"
    [ "$attempt" -eq 20 ] || sleep 1
  done
  if [ "$served_verified" != "yes" ]; then
    rollback "Nginx is not serving the newly installed certificate for $DOMAIN after reload"
  fi
  ECC_STATE_CHANGED="no"

  # Offer to purge ECC backup to keep filesystem tidy
  if [ -n "$ECC_BACKUP" ] && [ -d "$ECC_BACKUP" ]; then
    echo
    if ask_yes_no "Purge ECC backup directory now to save space? ($ECC_BACKUP)"; then
      info "Remove ECC backup: $ECC_BACKUP"
      run rm -rf "$ECC_BACKUP"
    else
      info "Keeping ECC backup at $ECC_BACKUP"
    fi
  fi

  info "SUCCESS: Completed DNS-manual ECC issue/renew with staging nginx swap and restored production config."
  info "Backup directories (if kept) live under /root/.acme.sh/${DOMAIN}_ecc.bak.*"
  info "Log file: $LOG_FILE"
}

main "$@"
