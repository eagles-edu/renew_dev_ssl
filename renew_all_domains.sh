#!/usr/bin/env bash
# Run acme_dns_manual_nginx_swap.sh sequentially for domains listed in the
# inventory markdown file. DNS TXT entry and certificate cutover remain
# interactive and must stay attached to the operator's terminal.

# cd /home/eagles/dockerz/renew_ssl
# ./renew_all_domains.sh --dry-run

# sudo ./renew_all_domains.sh
# sudo ./renew_all_domains.sh --mode renew
# sudo ./renew_all_domains.sh --continue-on-failure
# sudo ./renew_all_domains.sh --reset-progress
# sudo ./renew_all_domains.sh --domain ltd.eagles.vn

# cd /home/eagles/dockerz/renew_ssl
# sudo ./update_domain_inventory.sh
# ./renew_all_domains.sh --dry-run
# sudo ./renew_all_domains.sh

# Operator instructions:
# 1. Refresh the generated inventory before a batch:
#      sudo ./update_domain_inventory.sh
# 2. Review the plan without changes:
#      ./renew_all_domains.sh --dry-run
# 3. Run one representative domain successfully before the full batch.
# 4. Keep DNS provider access ready; every domain requires manual TXT entry.
# 5. Review any failure before using --continue-on-failure.
# 6. After every success, refresh the inventory and save progress for resume.
# 7. A saved success is skipped only while expiry is more than 10 days away.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SCRIPT_PATH="${SCRIPT_DIR}/acme_dns_manual_nginx_swap.sh"
UPDATER_PATH="${SCRIPT_DIR}/update_domain_inventory.sh"
INVENTORY_PATH="${SCRIPT_DIR}/DOMAIN_CERTIFICATE_INVENTORY.md"
LOCK_FILE="/run/lock/acme-dns-manual-all.lock"
PROGRESS_FILE="/var/lib/acme-dns-manual-nginx-swap/progress.tsv"
DOMAIN_FILTER=""
MODE="auto"
DRY_RUN="no"
CONTINUE_ON_FAILURE="no"
RESET_PROGRESS="no"
DUE_ONLY="yes"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: renew_all_domains.sh [options]

Runs the existing ACME/Nginx script one domain at a time. By default it reads
DOMAIN_CERTIFICATE_INVENTORY.md. The child script remains interactive for DNS
TXT records and safety checkpoints. Before each domain, press Enter to run it
or type 's' to skip it for this batch.

Operator instructions:
  1. Refresh and review the inventory before execution.
  2. Run --dry-run and verify CURRENT/NEW mode selection.
  3. Confirm the batch at the prompt.
  4. Complete each domain's TXT challenge and Nginx checkpoints.
  5. The default behavior stops at the first failure.
  6. Use --continue-on-failure only after investigating that failure.

NEW entries:
  Rows under NEW use the child script's --mode new workflow. Prepare the
  FQDN_ssl.conf staged link and the FQDN.conf production config before running.

Options:
  --inventory FILE          Domain inventory markdown file
  --script FILE             Existing ACME/Nginx script
  --updater FILE            Inventory refresh script
  --domain FQDN             Run only the specified domain
  --mode auto|renew|new     auto honors CURRENT/NEW inventory sections (default: auto)
  --dry-run                 List domains and selected modes without changing anything
  --continue-on-failure     Continue to the next domain after a failed domain
  --reset-progress          Forget saved successes and run selected domains again
  --all-current             Include CURRENT domains with more than 10 days remaining
  --help                    Show this help

Examples:
  sudo ./update_domain_inventory.sh
  sudo ./renew_all_domains.sh --dry-run
  sudo ./renew_all_domains.sh
  sudo ./renew_all_domains.sh --mode renew
  sudo ./renew_all_domains.sh --reset-progress
USAGE
}

ask_domain_action() {
  local domain="$1" selected_mode="$2" answer
  while true; do
    read -r -p "ACTION: process ${domain} (${selected_mode})? [Enter=run, s=skip, q=quit]: " answer || die "Input closed while selecting the next domain."
    case "${answer,,}" in
      ""|run|r)
        return 0
        ;;
      skip|s)
        return 1
        ;;
      quit|q)
        die "Batch cancelled by operator before ${domain}."
        ;;
      *)
        printf "Please press Enter to run, 's' to skip, or 'q' to quit.\n" >&2
        ;;
    esac
  done
}

require_root() {
  [ "${EUID:-$(id -u)}" -eq 0 ] || die "Run this wrapper as root: sudo $0"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --inventory)
        [ "$#" -ge 2 ] || die "Missing value for --inventory"
        INVENTORY_PATH="$2"
        shift 2
        ;;
      --script)
        [ "$#" -ge 2 ] || die "Missing value for --script"
        SCRIPT_PATH="$2"
        shift 2
        ;;
      --updater)
        [ "$#" -ge 2 ] || die "Missing value for --updater"
        UPDATER_PATH="$2"
        shift 2
        ;;
      --domain)
        [ "$#" -ge 2 ] || die "Missing value for --domain"
        DOMAIN_FILTER="$2"
        shift 2
        ;;
      --mode)
        [ "$#" -ge 2 ] || die "Missing value for --mode"
        MODE="$2"
        shift 2
        ;;
      --dry-run)
        DRY_RUN="yes"
        shift
        ;;
      --continue-on-failure)
        CONTINUE_ON_FAILURE="yes"
        shift
        ;;
      --reset-progress)
        RESET_PROGRESS="yes"
        shift
        ;;
      --all-current)
        DUE_ONLY="no"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument '$1'. Use --help for usage."
        ;;
    esac
  done

  case "$MODE" in
    auto|renew|new) ;;
    *) die "Invalid mode '$MODE'. Expected auto, renew, or new." ;;
  esac
}

domain_group() {
  local domain="$1" suffix start group=""
  local -a labels
  IFS='.' read -r -a labels <<<"${domain,,}"
  local label_count="${#labels[@]}"

  if [ "$label_count" -ge 3 ]; then
    suffix="${labels[$((label_count - 2))]}.${labels[$((label_count - 1))]}"
  else
    suffix=""
  fi

  case "$suffix" in
    com.vn|edu.vn|gov.vn|net.vn|org.vn)
      start=$((label_count - 3))
      ;;
    *)
      start=$((label_count - 2))
      ;;
  esac

  for ((i = start; i < label_count; i += 1)); do
    [ -n "$group" ] && group+="."
    group+="${labels[$i]}"
  done
  printf '%s\n' "$group"
}

sort_records_by_group() {
  local record domain group rank
  while IFS= read -r record; do
    [ -n "$record" ] || continue
    IFS=$'\t' read -r domain _ _ <<<"$record"
    group="$(domain_group "$domain")"
    rank=1
    [ "$domain" = "$group" ] && rank=0
    printf '%s\t%s\t%s\n' "$group" "$rank" "$record"
  done | sort -f -t $'\t' -k1,1 -k2,2n -k3,3f | cut -f3-
}

is_due_for_renewal() {
  local inventory_mode="$1" expiry="$2" status="$3" expiry_epoch cutoff_epoch
  [ "$DUE_ONLY" = "no" ] && return 0
  [ "$inventory_mode" = "new" ] && return 0
  [ "$status" = "CERTIFICATE MISMATCH" ] && return 0

  case "$expiry" in
    —|-) return 0 ;;
  esac

  expiry_epoch="$(date -d "$expiry" +%s 2>/dev/null || true)"
  cutoff_epoch="$(date -d '+10 days' +%s 2>/dev/null || true)"
  [ -n "$expiry_epoch" ] && [ -n "$cutoff_epoch" ] || return 1
  [ "$expiry_epoch" -le "$cutoff_epoch" ]
}

parse_inventory() {
  awk '
    BEGIN { mode = "renew" }
    /^##[[:space:]]+CURRENT/ { mode = "renew"; next }
    /^##[[:space:]]+NEW/ { mode = "new"; next }
    {
      line = $0
      gsub(/`/, "", line)
      n = split(line, fields, "|")
      domain = fields[2]
      expiry = fields[6]
      status = fields[7]
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", domain)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", expiry)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", status)
      if (domain ~ /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$/ && \
          (mode == "new" || status == "CURRENT" || status == "CERTIFICATE MISMATCH") && !seen[domain]++) {
        print domain "\t" mode "\t" expiry "\t" status
      }
    }
  ' "$INVENTORY_PATH"
}

was_completed() {
  local domain="$1" expiry="$2" expiry_epoch renew_window_epoch
  [ -f "$PROGRESS_FILE" ] || return 1
  if ! awk -F '\t' -v wanted_domain="$domain" -v wanted_expiry="$expiry" \
    '$1 == wanted_domain && $2 == wanted_expiry { found = 1; exit } END { exit(found ? 0 : 1) }' \
    "$PROGRESS_FILE"; then
    return 1
  fi

  expiry_epoch="$(date -d "$expiry" +%s 2>/dev/null || true)"
  renew_window_epoch="$(date -d '+10 days' +%s 2>/dev/null || true)"
  [ -n "$expiry_epoch" ] && [ -n "$renew_window_epoch" ] && [ "$expiry_epoch" -gt "$renew_window_epoch" ]
}

record_success() {
  local domain="$1" expiry="$2" progress_dir
  progress_dir="$(dirname -- "$PROGRESS_FILE")"
  mkdir -p "$progress_dir"
  touch "$PROGRESS_FILE"
  awk -F '\t' -v wanted_domain="$domain" '$1 != wanted_domain' "$PROGRESS_FILE" > "${PROGRESS_FILE}.tmp"
  printf '%s\t%s\t%s\n' "$domain" "$expiry" "$(date --iso-8601=seconds)" >> "${PROGRESS_FILE}.tmp"
  mv -f "${PROGRESS_FILE}.tmp" "$PROGRESS_FILE"
  chmod 0600 "$PROGRESS_FILE"
}

current_inventory_expiry() {
  local wanted_domain="$1"
  parse_inventory | awk -F '\t' -v wanted_domain="$wanted_domain" \
    '$1 == wanted_domain { print $3; exit }'
}

main() {
  parse_args "$@"
  [ -r "$INVENTORY_PATH" ] || die "Inventory file is not readable: $INVENTORY_PATH"

  local records domain inventory_mode inventory_expiry inventory_status selected_mode position=0 count=0 failed=0
  local due_records=()
  while IFS= read -r inventory_mode_record; do
    [ -n "$inventory_mode_record" ] || continue
    IFS=$'\t' read -r domain inventory_mode inventory_expiry inventory_status <<<"$inventory_mode_record"
    if is_due_for_renewal "$inventory_mode" "$inventory_expiry" "$inventory_status"; then
      due_records+=("$inventory_mode_record")
    fi
  done < <(parse_inventory)
  if [ "${#due_records[@]}" -gt 0 ]; then
    mapfile -t records < <(printf '%s\n' "${due_records[@]}" | sort_records_by_group)
  else
    records=()
  fi
  [ "${#records[@]}" -gt 0 ] || die "No domain rows found in inventory: $INVENTORY_PATH"

  if [ -n "$DOMAIN_FILTER" ]; then
    local filtered_records=()
    for inventory_mode_record in "${records[@]}"; do
      IFS=$'\t' read -r domain inventory_mode inventory_expiry inventory_status <<<"$inventory_mode_record"
      [ "$domain" = "$DOMAIN_FILTER" ] && filtered_records+=("$inventory_mode_record")
    done
    records=("${filtered_records[@]}")
    [ "${#records[@]}" -eq 1 ] || die "Domain not found in runnable inventory: $DOMAIN_FILTER"
  fi

  printf 'Inventory: %s\n' "$INVENTORY_PATH"
  printf 'Domains found: %s\n' "${#records[@]}"
  [ "$DUE_ONLY" = "yes" ] && printf 'Renewal filter: CURRENT certificates expiring within 10 days; NEW entries included.\n'
  printf '%-24s %-32s %s\n' 'GROUP' 'DOMAIN' 'MODE'
  for inventory_mode_record in "${records[@]}"; do
    IFS=$'\t' read -r domain inventory_mode inventory_expiry inventory_status <<<"$inventory_mode_record"
    selected_mode="$inventory_mode"
    [ "$MODE" = "auto" ] || selected_mode="$MODE"
    printf '%-24s %-32s %s\n' "$(domain_group "$domain")" "$domain" "$selected_mode"
  done

  [ "$DRY_RUN" = "yes" ] && exit 0

  require_root
  [ -x "$SCRIPT_PATH" ] || die "ACME/Nginx script is not executable: $SCRIPT_PATH"
  [ -x "$UPDATER_PATH" ] || die "Inventory updater is not executable: $UPDATER_PATH"
  [ -t 0 ] && [ -t 1 ] || die "Run from an interactive terminal; DNS and safety prompts require a TTY."

  if [ "$RESET_PROGRESS" = "yes" ]; then
    rm -f "$PROGRESS_FILE"
    printf 'Saved batch progress cleared.\n'
  fi

  local lock_dir
  lock_dir="$(dirname -- "$LOCK_FILE")"
  mkdir -p "$lock_dir"
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "Another all-domain renewal wrapper is already running: $LOCK_FILE"

  echo
  printf 'This will run domains sequentially and require manual DNS TXT entry.\n'
  read -r -p "Proceed with the list above? [y/n]: " answer
  case "${answer,,}" in
    y|yes) ;;
    *) printf 'Cancelled.\n'; exit 0 ;;
  esac

  for inventory_mode_record in "${records[@]}"; do
    position=$((position + 1))
    IFS=$'\t' read -r domain inventory_mode inventory_expiry inventory_status <<<"$inventory_mode_record"
    selected_mode="$inventory_mode"
    [ "$MODE" = "auto" ] || selected_mode="$MODE"

    if [ "$RESET_PROGRESS" != "yes" ] && was_completed "$domain" "$inventory_expiry"; then
      printf 'SKIPPED: %s (saved success with expiry %s)\n' "$domain" "$inventory_expiry"
      continue
    fi

    if ! ask_domain_action "$domain" "$selected_mode"; then
      printf 'SKIPPED BY OPERATOR: %s (this batch only)\n' "$domain"
      continue
    fi

    count=$((count + 1))
    printf '\n===== [%s/%s] %s (%s) =====\n' "$position" "${#records[@]}" "$domain" "$selected_mode"
    if "$SCRIPT_PATH" --domain "$domain" --mode "$selected_mode"; then
      printf 'Refreshing certificate inventory after successful domain: %s\n' "$domain"
      if ! "$UPDATER_PATH"; then
        failed=$((failed + 1))
        printf 'FAILED: inventory refresh after %s\n' "$domain" >&2
        if [ "$CONTINUE_ON_FAILURE" != "yes" ]; then
          die "Stopping because progress could not be saved safely."
        fi
        continue
      fi

      inventory_expiry="$(current_inventory_expiry "$domain")"
      if [ -z "$inventory_expiry" ] || [ "$inventory_expiry" = "—" ]; then
        failed=$((failed + 1))
        printf 'FAILED: refreshed inventory has no usable expiry for %s\n' "$domain" >&2
        if [ "$CONTINUE_ON_FAILURE" != "yes" ]; then
          die "Stopping because progress could not be saved safely."
        fi
        continue
      fi

      record_success "$domain" "$inventory_expiry"
      printf 'COMPLETED: %s\n' "$domain"
    else
      failed=$((failed + 1))
      printf 'FAILED: %s\n' "$domain" >&2
      if [ "$CONTINUE_ON_FAILURE" != "yes" ]; then
        die "Stopping after failure. Re-run with --continue-on-failure only after reviewing the failed domain."
      fi
    fi
  done

  printf '\nBatch complete: %s domain(s) attempted, %s failed.\n' "$count" "$failed"
  [ "$failed" -eq 0 ]
}

main "$@"
