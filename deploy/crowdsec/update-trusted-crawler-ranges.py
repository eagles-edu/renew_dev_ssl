#!/usr/bin/python3
"""Refresh Nginx's trusted crawler ranges from the selected upstream feed."""

from __future__ import annotations

import ipaddress
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable
from urllib.error import URLError
from urllib.request import Request, urlopen


SOURCE_URL = (
    "https://raw.githubusercontent.com/sefinek/trusted-ips-whitelist/"
    "main/lists/all-crawlers-ips.txt"
)
CIDR_FILE = Path("/var/lib/crowdsec/trusted-crawler-cidrs.txt")
NGINX_GEO_FILE = Path("/var/lib/crowdsec/trusted-crawler-map.conf")
NGINX = "/usr/sbin/nginx"
SYSTEMCTL = "/usr/bin/systemctl"
MAX_FEED_BYTES = 2_000_000
MIN_NETWORKS = 500

Address = ipaddress.IPv4Address | ipaddress.IPv6Address
Network = ipaddress.IPv4Network | ipaddress.IPv6Network


def run(command: str, *args: str) -> None:
    result = subprocess.run(
        [command, *args], capture_output=True, text=True, check=False, timeout=60
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"{command} {' '.join(args)} failed")


def parse_feed(content: str) -> tuple[Network, ...]:
    networks: set[Network] = set()
    for line_number, line in enumerate(content.splitlines(), 1):
        value = line.partition("#")[0].strip()
        if not value:
            continue
        try:
            network = ipaddress.ip_network(value, strict=False)
        except ValueError as error:
            raise ValueError(f"Invalid CIDR on feed line {line_number}: {value!r}") from error

        minimum_prefix = 8 if network.version == 4 else 16
        if network.prefixlen < minimum_prefix:
            raise ValueError(f"Feed contains overly broad network {network}")
        if not network.network_address.is_global or not network.broadcast_address.is_global:
            raise ValueError(f"Feed contains non-global network {network}")
        networks.add(network)

    if len(networks) < MIN_NETWORKS:
        raise ValueError(
            f"Feed contains only {len(networks)} valid networks; expected at least {MIN_NETWORKS}"
        )
    return tuple(sorted(networks, key=lambda item: (item.version, int(item.network_address), item.prefixlen)))


def fetch_feed(url: str = SOURCE_URL) -> str:
    request = Request(url, headers={"User-Agent": "renew-ssl-crawler-ranges/1.0"})
    try:
        with urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"Crawler feed returned HTTP {response.status}")
            body = response.read(MAX_FEED_BYTES + 1)
    except (OSError, URLError, TimeoutError) as error:
        raise RuntimeError(f"Could not download crawler feed: {error}") from error
    if len(body) > MAX_FEED_BYTES:
        raise RuntimeError(f"Crawler feed exceeds {MAX_FEED_BYTES} bytes")
    try:
        return body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError("Crawler feed is not valid UTF-8") from error


def canonical_content(networks: tuple[Network, ...]) -> str:
    return "".join(f"{network}\n" for network in networks)


def nginx_geo_content(networks: tuple[Network, ...]) -> str:
    return "".join(f"{network} 1;\n" for network in networks)


def atomic_write(path: Path, content: str, mode: int = 0o644) -> bool:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        if path.read_text(encoding="utf-8") == content:
            return False
    except FileNotFoundError:
        pass

    fd, temp_name = tempfile.mkstemp(prefix=f"{path.name}-", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_name, mode)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return True


def restore(path: Path, previous: str | None) -> None:
    if previous is None:
        atomic_write(path, "")
    else:
        atomic_write(path, previous)


def apply_feed(
    content: str,
    cidr_path: Path = CIDR_FILE,
    geo_path: Path = NGINX_GEO_FILE,
    activate_nginx: Callable[[], None] | None = None,
) -> tuple[bool, int]:
    networks = parse_feed(content)
    cidr_content = canonical_content(networks)
    geo_content = nginx_geo_content(networks)
    previous_cidrs = cidr_path.read_text(encoding="utf-8") if cidr_path.exists() else None
    previous_geo = geo_path.read_text(encoding="utf-8") if geo_path.exists() else None
    geo_changed = False

    try:
        cidrs_changed = atomic_write(cidr_path, cidr_content)
        geo_changed = atomic_write(geo_path, geo_content)
        if geo_changed and activate_nginx is not None:
            activate_nginx()
    except Exception:
        restore(cidr_path, previous_cidrs)
        restore(geo_path, previous_geo)
        if geo_changed and activate_nginx is not None:
            try:
                activate_nginx()
            except Exception:
                pass
        raise

    return cidrs_changed or geo_changed, len(networks)


def refresh(
    fetch: Callable[[], str] = fetch_feed,
    cidr_path: Path = CIDR_FILE,
    geo_path: Path = NGINX_GEO_FILE,
    validate_and_reload: Callable[[], None] | None = None,
) -> tuple[bool, int]:
    return apply_feed(fetch(), cidr_path, geo_path, validate_and_reload)


def activate_nginx() -> None:
    run(NGINX, "-t")
    run(SYSTEMCTL, "reload", "nginx")


def main() -> int:
    check_only = sys.argv[1:] == ["--check"]
    if sys.argv[1:] and not check_only:
        print("Usage: renew-ssl-update-trusted-crawler-ranges.py [--check]", file=sys.stderr)
        return 2
    if os.geteuid() != 0:
        if not check_only:
            print("Run as root.", file=sys.stderr)
            return 1
    try:
        content = fetch_feed()
        if check_only:
            networks = parse_feed(content)
            print(f"Validated {len(networks)} crawler network(s) from the upstream feed.")
            return 0
        changed, count = apply_feed(content, activate_nginx=activate_nginx)
        if changed:
            # The regular CrowdSec timer retries this reconciliation every 30s;
            # start it now so newly trusted sources are promptly released.
            run(SYSTEMCTL, "start", "renew-permanent-web-attack-bans.service")
        print(f"Accepted {count} trusted crawler network(s); changed={str(changed).lower()}.")
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Trusted crawler range update failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
