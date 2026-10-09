#!/usr/bin/env bash
# Create a new HTTP Nginx vhost with a CyberPanel-style ACME webroot.
# The existing OpenLiteSpeed service is the default application backend.

set -Eeuo pipefail
umask 022

AVAILABLE_DIR="/etc/nginx/sites-available"
ENABLED_DIR="/etc/nginx/sites-enabled"
DOMAIN=""
WEBROOT=""
BACKEND="http://127.0.0.1:8088"
APPLY="no"
TEMP_CONFIG=""
CONFIG_INSTALLED="no"
LINK_CREATED="no"
SUCCESS="no"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: setup_nginx_vhost.sh --domain FQDN [options]

Creates a new HTTP vhost and its ACME HTTP-01 webroot. Dry-run is the default.

Options:
  --domain FQDN       Domain to configure; www.FQDN is added as an alias
  --webroot DIR       Document root (default: /home/FQDN/public_html)
  --backend URL|off   Local HTTP backend (default: http://127.0.0.1:8088)
                      Use 'off' to serve static files from the webroot
  --apply             Write the vhost, enable it, run nginx -t, and reload
  --help              Show this help

Examples:
  ./setup_nginx_vhost.sh --domain newsite.example.com
  sudo ./setup_nginx_vhost.sh --domain newsite.example.com --apply
  sudo ./setup_nginx_vhost.sh --domain static.example.com --backend off --apply

The script refuses to overwrite existing vhosts and checks the global Nginx
configuration before changing files. TLS issuance is a separate step.
USAGE
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --domain)
        [ "$#" -ge 2 ] || die "Missing value for --domain"
        DOMAIN="${2,,}"
        shift 2
        ;;
      --webroot)
        [ "$#" -ge 2 ] || die "Missing value for --webroot"
        WEBROOT="$2"
        shift 2
        ;;
      --backend)
        [ "$#" -ge 2 ] || die "Missing value for --backend"
        BACKEND="${2,,}"
        shift 2
        ;;
      --apply)
        APPLY="yes"
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
}

validate_domain() {
  local label
  local -a labels
  [[ "$DOMAIN" =~ ^[a-z0-9.-]+$ ]] || die "Invalid domain: $DOMAIN"
  [[ "$DOMAIN" == *.* && "$DOMAIN" != .* && "$DOMAIN" != *. && "$DOMAIN" != *..* ]] \
    || die "Provide a fully qualified domain name."
  [ "${#DOMAIN}" -le 249 ] || die "Domain is too long to add the www alias."

  IFS='.' read -r -a labels <<<"$DOMAIN"
  [ "${#labels[@]}" -ge 2 ] || die "Domain must include a top-level domain."
  for label in "${labels[@]}"; do
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
      || die "Invalid DNS label in domain: $DOMAIN"
  done
}

validate_webroot() {
  local resolved_webroot
  [ -n "$WEBROOT" ] || WEBROOT="/home/${DOMAIN}/public_html"
  [[ "$WEBROOT" =~ ^/home/[A-Za-z0-9._-]+/public_html/?$ ]] \
    || die "Webroot must use the /home/<domain>/public_html CyberPanel-style layout."
  [[ "$WEBROOT" != *"/../"* && "$WEBROOT" != */.. && "$WEBROOT" != *"/./"* ]] \
    || die "Webroot cannot contain dot path components."
  WEBROOT="${WEBROOT%/}"
  resolved_webroot="$(realpath -m -- "$WEBROOT")"
  [ "$resolved_webroot" = "$WEBROOT" ] \
    || die "Webroot resolves through a symlink or alternate path: $resolved_webroot"
}

validate_backend() {
  [ "$BACKEND" = "off" ] && return 0
  [[ "$BACKEND" =~ ^https?://(127\.0\.0\.1|localhost):[0-9]{1,5}$ ]] \
    || die "Backend must be 'off' or a local URL such as http://127.0.0.1:8088."

  local port="${BACKEND##*:}"
  ((port >= 1 && port <= 65535)) || die "Backend port is outside 1-65535."
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

domain_already_configured() {
  local dir file
  for dir in "$AVAILABLE_DIR" "$ENABLED_DIR"; do
    [ -d "$dir" ] || continue
    while IFS= read -r -d '' file; do
      if awk -v domain="$DOMAIN" -v www="www.${DOMAIN}" '
        $1 == "server_name" {
          for (i = 2; i <= NF; i++) {
            gsub(/;/, "", $i)
            if ($i == domain || $i == www) found = 1
          }
        }
        END { exit(found ? 0 : 1) }
      ' "$file"; then
        printf '%s\n' "$file"
        return 0
      fi
    done < <(find "$dir" -maxdepth 1 \( -type f -o -type l \) -name '*.conf' -print0 2>/dev/null)
  done
  return 1
}

render_config() {
  local output="$1"
  cat >"$output" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} www.${DOMAIN};

    root ${WEBROOT};
    index index.html index.htm;

    location ^~ /.well-known/acme-challenge/ {
        default_type text/plain;
        try_files \$uri =404;
    }

NGINX

  if [ "$BACKEND" = "off" ]; then
    cat >>"$output" <<'NGINX'
    location / {
        try_files $uri $uri/ =404;
    }
NGINX
  else
    cat >>"$output" <<NGINX
    location / {
        proxy_pass ${BACKEND};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
NGINX
  fi

  cat >>"$output" <<NGINX

    access_log /var/log/nginx/${DOMAIN}_access.log;
    error_log /var/log/nginx/${DOMAIN}_error.log warn;
}
NGINX
}

rollback() {
  if [ "$LINK_CREATED" = "yes" ]; then
    rm -f -- "$ENABLED_PATH"
    LINK_CREATED="no"
  fi
  if [ "$CONFIG_INSTALLED" = "yes" ]; then
    rm -f -- "$CONFIG_PATH"
    CONFIG_INSTALLED="no"
  fi
  if [ -n "$TEMP_CONFIG" ]; then
    rm -f -- "$TEMP_CONFIG"
    TEMP_CONFIG=""
  fi
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local exit_status=$?
  if [ "$SUCCESS" != "yes" ] && \
    { [ "$CONFIG_INSTALLED" = "yes" ] || [ "$LINK_CREATED" = "yes" ]; }; then
    rollback
  fi
  exit "$exit_status"
}

main() {
  parse_args "$@"
  [ -n "$DOMAIN" ] || die "--domain is required."
  validate_domain
  validate_webroot
  validate_backend

  local config_path="${AVAILABLE_DIR}/${DOMAIN}.conf"
  local enabled_path="${ENABLED_DIR}/${DOMAIN}.conf"
  local existing

  if path_exists "$config_path" || path_exists "$enabled_path"; then
    die "A vhost path already exists for '$DOMAIN'; refusing to overwrite it."
  fi
  if existing="$(domain_already_configured)"; then
    die "'$DOMAIN' or 'www.$DOMAIN' is already configured in $existing."
  fi

  printf 'Plan for %s:\n' "$DOMAIN"
  printf '  Webroot: %s\n' "$WEBROOT"
  printf '  Backend: %s\n' "$BACKEND"
  printf '  Config:  %s\n' "$config_path"
  printf '  Enable:  %s -> %s\n' "$enabled_path" "$config_path"
  printf '  Action:  create HTTP vhost, validate Nginx, reload Nginx\n'

  [ "$APPLY" = "yes" ] || {
    printf 'Dry-run only. Add --apply to make these changes (run with sudo).\n'
    return 0
  }

  [ "${EUID:-$(id -u)}" -eq 0 ] || die "Run apply mode as root: sudo $0 --domain $DOMAIN --apply"
  command -v nginx >/dev/null 2>&1 || die "nginx is not installed."
  command -v systemctl >/dev/null 2>&1 || die "systemctl is not available."
  command -v flock >/dev/null 2>&1 || die "flock is not installed."
  command -v realpath >/dev/null 2>&1 || die "realpath is not installed."
  command -v runuser >/dev/null 2>&1 || die "runuser is not installed."
  [ -d "$AVAILABLE_DIR" ] || die "Nginx available directory is missing: $AVAILABLE_DIR"
  [ -d "$ENABLED_DIR" ] || die "Nginx enabled directory is missing: $ENABLED_DIR"

  local lock_file="/run/lock/setup-nginx-vhost-${DOMAIN}.lock"
  exec 9>"$lock_file"
  flock -n 9 || die "Another vhost setup is already running for $DOMAIN."

  # Never enable a new site while the existing server-wide config is invalid.
  nginx -t || die "Existing Nginx configuration is invalid; no vhost files were changed."

  mkdir -p -m 0755 "${WEBROOT}/.well-known/acme-challenge"
  local nginx_user
  nginx_user="$(awk '$1 == "user" { gsub(/;/, "", $2); print $2; exit }' /etc/nginx/nginx.conf)"
  nginx_user="${nginx_user:-www-data}"
  id "$nginx_user" >/dev/null 2>&1 || die "Nginx worker account does not exist: $nginx_user"
  runuser -u "$nginx_user" -- test -x "$WEBROOT" \
    || die "Nginx user '$nginx_user' cannot traverse webroot $WEBROOT"
  runuser -u "$nginx_user" -- test -x "${WEBROOT}/.well-known/acme-challenge" \
    || die "Nginx user '$nginx_user' cannot access the ACME challenge directory."

  local temp_config
  temp_config="$(mktemp "${AVAILABLE_DIR}/.${DOMAIN}.conf.XXXXXX")"
  TEMP_CONFIG="$temp_config"
  CONFIG_PATH="$config_path"
  ENABLED_PATH="$enabled_path"
  render_config "$TEMP_CONFIG"
  chmod 0644 "$TEMP_CONFIG"
  ln -- "$TEMP_CONFIG" "$CONFIG_PATH" \
    || die "Vhost config path appeared during setup; refusing to overwrite it."
  CONFIG_INSTALLED="yes"
  rm -- "$TEMP_CONFIG"
  TEMP_CONFIG=""

  ln -s -- "$CONFIG_PATH" "$ENABLED_PATH"
  LINK_CREATED="yes"

  if ! nginx -t; then
    die "Generated Nginx configuration failed validation; rolling back this vhost."
  fi
  if ! systemctl reload nginx; then
    die "Nginx reload failed; rolling back this vhost."
  fi

  SUCCESS="yes"
  printf 'Configured %s. HTTP-01 challenges use %s/.well-known/acme-challenge/.\n' \
    "$DOMAIN" "$WEBROOT"
  printf 'TLS issuance is not included; issue/install the certificate as a separate step.\n'
}

trap cleanup EXIT
main "$@"
