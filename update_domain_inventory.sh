#!/usr/bin/env bash
# Generate a clean grouped domain/certificate inventory from the historical
# inventory plus currently enabled public Nginx domains.
#
# Operator instructions:
# 1. Run this before reviewing or batching certificate work.
# 2. Review DOMAIN_CERTIFICATE_INVENTORY.md after it is generated.
# 3. CURRENT rows use the renew workflow; NEW rows use the new workflow.
# 4. Unreachable/internal entries remain visible but are not batch-selected.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_PATH="${SCRIPT_DIR}/Main_Domain KeyLength SAN_Domains CA Cre.md"
OUTPUT_PATH="${SCRIPT_DIR}/DOMAIN_CERTIFICATE_INVENTORY.md"
NGINX_ENABLED="/etc/nginx/sites-enabled"
ADD_NEW_DOMAIN=""
TMP_DIR=""

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: update_domain_inventory.sh [options]

Options:
  --source FILE       Historical/source inventory markdown
  --output FILE       Generated clean inventory markdown
  --nginx-dir DIR     Nginx sites-enabled directory
  --add-new FQDN      Include a new manager-created site even when only its *_ssl link is enabled
  --help              Show this help

Normal operation:
  sudo ./update_domain_inventory.sh
  less DOMAIN_CERTIFICATE_INVENTORY.md
USAGE
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --source)
        [ "$#" -ge 2 ] || die "Missing value for --source"
        SOURCE_PATH="$2"
        shift 2
        ;;
      --output)
        [ "$#" -ge 2 ] || die "Missing value for --output"
        OUTPUT_PATH="$2"
        shift 2
        ;;
      --nginx-dir)
        [ "$#" -ge 2 ] || die "Missing value for --nginx-dir"
        NGINX_ENABLED="$2"
        shift 2
        ;;
      --add-new)
        [ "$#" -ge 2 ] || die "Missing value for --add-new"
        ADD_NEW_DOMAIN="${2,,}"
        [[ "$ADD_NEW_DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$ ]] ||
          die "Invalid domain for --add-new: $2"
        shift 2
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
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

add_candidate() {
  local domain="$1" mode="$2"
  [[ "$domain" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$ ]] || return 0
  candidates["$domain"]="$mode"
}

read_source_inventory() {
  local mode="current" domain
  while IFS=$'\t' read -r domain mode_from_source; do
    [ -n "$domain" ] || continue
    add_candidate "$domain" "$mode_from_source"
  done < <(
    awk '
      BEGIN { mode = "current" }
      /^[[:space:]]*NEW[*![:space:]]+NOT[[:space:]]+YET[[:space:]]+ISSUED/ { mode = "new"; next }
      $1 ~ /^[A-Za-z0-9][A-Za-z0-9.-]*$/ && $1 ~ /\./ { print $1 "\t" mode }
    ' "$SOURCE_PATH"
  )
}

read_nginx_domains() {
  local entry domain
  [ -d "$NGINX_ENABLED" ] || return 0
  while IFS= read -r entry; do
    case "$entry" in
      *.conf) domain="${entry%.conf}" ;;
      *) domain="$entry" ;;
    esac
    [[ "$domain" == *_ssl ]] && continue
    [ "${candidates[$domain]:-}" = "new" ] && continue
    add_candidate "$domain" "current"
  done < <(find "$NGINX_ENABLED" -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -printf '%f\n' 2>/dev/null | sort -u)
}

promote_issued_domains() {
  local domain cert_file
  for domain in "${!candidates[@]}"; do
    [ "${candidates[$domain]}" = "new" ] || continue
    [ "$domain" = "$ADD_NEW_DOMAIN" ] && continue
    cert_file="$TMP_DIR/${domain}.classification.pem"
    if fetch_certificate "$domain" "$cert_file" &&
      certificate_covers_domain "$cert_file" "$domain"; then
      candidates["$domain"]="current"
    fi
  done
}

fetch_certificate() {
  local domain="$1" output="$2"
  set +e
  timeout 15 openssl s_client -4 -connect "${domain}:443" -servername "$domain" </dev/null 2>/dev/null \
    | openssl x509 -out "$output" 2>/dev/null
  local rc="$?"
  set -e
  [ "$rc" -eq 0 ] && [ -s "$output" ]
}

format_expiry() {
  local raw="$1"
  TZ=Asia/Ho_Chi_Minh date -d "$raw" '+%Y-%m-%dT%H:%M:%S %:z'
}

certificate_covers_domain() {
  local cert_file="$1" domain="$2"
  openssl x509 -in "$cert_file" -noout -text 2>/dev/null \
    | grep -Eq "DNS:${domain}([,[:space:]]|$)"
}

escape_markdown() {
  local value="$1"
  value="${value//|/\\|}"
  value="${value//$'\n'/ }"
  printf '%s' "$value"
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

sort_domain_list() {
  local domain group rank
  while IFS= read -r domain; do
    [ -n "$domain" ] || continue
    group="$(domain_group "$domain")"
    rank=1
    [ "$domain" = "$group" ] && rank=0
    printf '%s\t%s\t%s\n' "$group" "$rank" "$domain"
  done | sort -f -t $'\t' -k1,1 -k2,2n -k3,3f | cut -f3-
}

certificate_row() {
  local domain="$1" source_mode="$2" cert_file="$TMP_DIR/${domain}.pem"
  local expiry issuer ca sans key_type status
  local san_output

  if ! fetch_certificate "$domain" "$cert_file"; then
    printf '| `%s` | `%s` | ec-256 | — | — | Not publicly issued/reachable |\n' \
      "$domain" "www.${domain}"
    return 0
  fi

  expiry="$(openssl x509 -in "$cert_file" -noout -enddate | sed 's/^notAfter=//')"
  issuer="$(openssl x509 -in "$cert_file" -noout -issuer | sed 's/^issuer=//')"
  if [[ "$issuer" == *"Let's Encrypt"* ]]; then
    ca="Let's Encrypt"
  else
    ca="$(escape_markdown "$issuer")"
  fi

  san_output="$(openssl x509 -in "$cert_file" -noout -text 2>/dev/null \
    | awk '/Subject Alternative Name:/{getline; print}' \
    | sed 's/^[[:space:]]*//; s/DNS://g; s/, /, /g' || true)"
  [ -n "$san_output" ] || san_output="www.${domain}"

  if openssl x509 -in "$cert_file" -noout -text 2>/dev/null | grep -q 'id-ecPublicKey'; then
    key_type="ec-256"
  else
    key_type="unknown"
  fi

  expiry="$(format_expiry "$expiry")"
  status="${source_mode^^}"
  if ! certificate_covers_domain "$cert_file" "$domain"; then
    status="CERTIFICATE MISMATCH"
  fi
  printf '| `%s` | `%s` | %s | %s | %s | %s |\n' \
    "$domain" "$san_output" "$key_type" "$ca" "$expiry" "$status"
}

main() {
  parse_args "$@"
  [ -r "$SOURCE_PATH" ] || die "Source inventory is not readable: $SOURCE_PATH"
  mkdir -p "$(dirname -- "$OUTPUT_PATH")"
  TMP_DIR="$(mktemp -d)"
  trap cleanup EXIT

  declare -A candidates=()
  declare -a current_domains=() new_domains=()
  read_source_inventory
  read_nginx_domains
  if [ -n "$ADD_NEW_DOMAIN" ]; then
    candidates["$ADD_NEW_DOMAIN"]="new"
  fi
  promote_issued_domains
  [ "${#candidates[@]}" -gt 0 ] || die "No domains found in source or Nginx inventory."

  local generated_at
  generated_at="$(TZ=Asia/Ho_Chi_Minh date '+%Y-%m-%dT%H:%M:%S %:z')"
  {
    printf '# Domain Certificate Inventory\n\n'
    printf "> Generated: \`%s\`\n> Expiry values are read from each domain's public TLS certificate in Asia/Ho_Chi_Minh time.\n> Run \`sudo ./update_domain_inventory.sh\` to refresh.\n\n" "$generated_at"
    printf '## CURRENT\n\n'
    printf '| Main domain | SAN domains | Key length | CA | Expires | Status |\n'
    printf '| --- | --- | --- | --- | --- | --- |\n'
    for domain in "${!candidates[@]}"; do
      [ "${candidates[$domain]}" = "new" ] && continue
      current_domains+=("$domain")
    done
    if [ "${#current_domains[@]}" -gt 0 ]; then
      while IFS= read -r domain; do
        certificate_row "$domain" "current"
      done < <(printf '%s\n' "${current_domains[@]}" | sort_domain_list)
    fi
    printf '\n## NEW\n\n'
    printf '| Main domain | SAN domains | Key length | CA | Expires | Status |\n'
    printf '| --- | --- | --- | --- | --- | --- |\n'
    for domain in "${!candidates[@]}"; do
      [ "${candidates[$domain]}" = "new" ] || continue
      new_domains+=("$domain")
    done
    if [ "${#new_domains[@]}" -gt 0 ]; then
      while IFS= read -r domain; do
        certificate_row "$domain" "new"
      done < <(printf '%s\n' "${new_domains[@]}" | sort_domain_list)
    fi
  } > "$OUTPUT_PATH"

  # Preserve access for the checkout owner when this is run with sudo.
  if [[ "${SUDO_UID:-}" =~ ^[0-9]+$ && "${SUDO_GID:-}" =~ ^[0-9]+$ ]]; then
    chown "$SUDO_UID:$SUDO_GID" "$OUTPUT_PATH"
  fi
  chmod 0640 "$OUTPUT_PATH"
  printf 'Updated: %s\n' "$OUTPUT_PATH"
}

main "$@"
