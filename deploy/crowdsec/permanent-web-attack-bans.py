#!/usr/bin/python3
"""Persist CrowdSec web reconnaissance and exploit sources in nftables and Nginx."""

from __future__ import annotations

import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path


CSCLI = "/usr/bin/cscli"
NFT = "/usr/sbin/nft"
NGINX = "/usr/sbin/nginx"
SYSTEMCTL = "/usr/bin/systemctl"
TABLE = "renew_web_permanent"
STATE_FILE = Path("/var/lib/crowdsec/permanent-web-attack-bans.txt")
RELEASE_FILE = Path("/var/lib/crowdsec/permanent-web-attack-releases.txt")
NGINX_MAP_FILE = Path("/var/lib/crowdsec/permanent-web-attack-map.conf")
TRUSTED_PROXY_CONFIG = Path("/etc/nginx/snippets/oneshield-realip.conf")
TRUSTED_PROXY_PATTERN = re.compile(r"^\s*set_real_ip_from\s+(\S+)\s*;", re.IGNORECASE)

Address = ipaddress.IPv4Address | ipaddress.IPv6Address
Network = ipaddress.IPv4Network | ipaddress.IPv6Network


def run(command: str, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([command, *args], capture_output=True, text=True, check=False)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or f"{command} {' '.join(args)} failed")
    return result


def trusted_proxy_networks(path: Path = TRUSTED_PROXY_CONFIG) -> tuple[Network, ...]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise RuntimeError(f"Cannot read trusted proxy config {path}: {error}") from error

    networks: list[Network] = []
    for line in lines:
        match = TRUSTED_PROXY_PATTERN.match(line)
        if match:
            try:
                networks.append(ipaddress.ip_network(match.group(1), strict=False))
            except ValueError as error:
                raise RuntimeError(f"Invalid trusted proxy network {match.group(1)!r}") from error
    if not networks:
        raise RuntimeError(f"No trusted proxy networks found in {path}; refusing web bans")
    return tuple(networks)


def is_trusted_proxy(address: Address, networks: tuple[Network, ...]) -> bool:
    return any(address.version == network.version and address in network for network in networks)


def is_permanent_web_attack(alert: dict, trusted_networks: tuple[Network, ...]) -> bool:
    if alert.get("simulated") is True:
        return False
    source = alert.get("source") or {}
    if str(source.get("scope", "")).lower() != "ip":
        return False
    try:
        address = ipaddress.ip_address(str(source.get("value", "")))
    except ValueError:
        return False
    if is_trusted_proxy(address, trusted_networks):
        return False

    scenario = str(alert.get("scenario", "")).lower()
    kind = str(alert.get("kind", "")).lower()
    if kind == "waf":
        # Virtual-patching alerts represent a matched exploit signature. The
        # trusted-proxy exclusion above prevents banning the forwarding edge.
        return scenario.startswith("crowdsecurity/vpatch-")
    return (
        kind == "crowdsec"
        and alert.get("remediation") is True
        and (scenario.startswith("crowdsecurity/http-") or scenario == "ltsich/http-w00tw00t")
    )


def alert_addresses(
    rows: list[dict], trusted_networks: tuple[Network, ...]
) -> set[Address]:
    addresses: set[Address] = set()
    for alert in rows:
        if is_permanent_web_attack(alert, trusted_networks):
            source = alert.get("source") or {}
            addresses.add(ipaddress.ip_address(str(source["value"])))
    return addresses


def load_state() -> set[Address]:
    addresses: set[Address] = set()
    try:
        lines = STATE_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return addresses
    for line in lines:
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        try:
            addresses.add(ipaddress.ip_address(value))
        except ValueError:
            print(f"Ignoring invalid address in {STATE_FILE}: {value}", file=sys.stderr)
    return addresses


def load_releases() -> set[Address]:
    addresses: set[Address] = set()
    try:
        lines = RELEASE_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return addresses
    for line in lines:
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        try:
            addresses.add(ipaddress.ip_address(value))
        except ValueError:
            print(f"Ignoring invalid address in {RELEASE_FILE}: {value}", file=sys.stderr)
    return addresses


def list_alerts() -> list[dict]:
    result = subprocess.run(
        [CSCLI, "alerts", "list", "--limit", "0", "--output", "json"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Could not read CrowdSec alerts: {result.stderr.strip()}")
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Could not parse CrowdSec alerts: {error}") from error
    if not isinstance(rows, list):
        raise RuntimeError("CrowdSec returned an unexpected alert document")
    return rows


def ensure_object(kind: str, name: str, create_args: tuple[str, ...]) -> None:
    if run(NFT, "list", kind, "inet", TABLE, name, check=False).returncode:
        run(NFT, *create_args)


def ensure_firewall() -> None:
    if run(NFT, "list", "table", "inet", TABLE, check=False).returncode:
        run(NFT, "add", "table", "inet", TABLE)

    ensure_object(
        "set",
        "banned_ipv4",
        ("add", "set", "inet", TABLE, "banned_ipv4", "{", "type", "ipv4_addr", ";", "}"),
    )
    ensure_object(
        "set",
        "banned_ipv6",
        ("add", "set", "inet", TABLE, "banned_ipv6", "{", "type", "ipv6_addr", ";", "}"),
    )
    for chain, hook in (("input", "input"), ("forward", "forward")):
        ensure_object(
            "chain",
            chain,
            (
                "add",
                "chain",
                "inet",
                TABLE,
                chain,
                "{",
                "type",
                "filter",
                "hook",
                hook,
                "priority",
                "-11",
                ";",
                "policy",
                "accept",
                ";",
                "}",
            ),
        )
        rules = run(NFT, "list", "chain", "inet", TABLE, chain).stdout
        for rule in (
            ("ip", "saddr", "@banned_ipv4", "drop"),
            ("ip6", "saddr", "@banned_ipv6", "drop"),
        ):
            if " ".join(rule) not in rules:
                run(NFT, "add", "rule", "inet", TABLE, chain, *rule)


def atomic_write(path: Path, content: str, mode: int) -> bool:
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


def sort_addresses(addresses: set[Address]) -> list[Address]:
    return sorted(addresses, key=lambda item: (item.version, int(item)))


def add_element(address: Address) -> None:
    set_name = "banned_ipv4" if address.version == 4 else "banned_ipv6"
    result = run(
        NFT,
        "add",
        "element",
        "inet",
        TABLE,
        set_name,
        "{",
        str(address),
        "}",
        check=False,
    )
    if result.returncode and "File exists" not in result.stderr:
        raise RuntimeError(result.stderr.strip() or f"Could not add permanent ban for {address}")


def reload_nginx_if_needed(addresses: set[Address]) -> None:
    content = "".join(f"{address} 1;\n" for address in sort_addresses(addresses))
    if not atomic_write(NGINX_MAP_FILE, content, 0o640):
        return
    run(NGINX, "-t")
    run(SYSTEMCTL, "reload", "nginx")


def main() -> int:
    if os.geteuid() != 0:
        print("Run as root.", file=sys.stderr)
        return 1
    try:
        proxies = trusted_proxy_networks()
        detected = alert_addresses(list_alerts(), proxies)
        released = load_releases()
        addresses = (load_state() | detected) - released
        ensure_firewall()
        state = "".join(f"{address}\n" for address in sort_addresses(addresses))
        atomic_write(STATE_FILE, state, 0o600)
        for address in sort_addresses(released):
            set_name = "banned_ipv4" if address.version == 4 else "banned_ipv6"
            run(
                NFT,
                "delete",
                "element",
                "inet",
                TABLE,
                set_name,
                "{",
                str(address),
                "}",
                check=False,
            )
        for address in sort_addresses(addresses):
            add_element(address)
        reload_nginx_if_needed(addresses)
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Permanent web attack ban sync failed: {error}", file=sys.stderr)
        return 1
    print(f"Enforced {len(addresses)} permanent web attack ban(s) in nftables and Nginx.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
