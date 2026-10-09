#!/usr/bin/python3
"""Persist IPs that trigger the local SSH brute-force scenario in nftables."""

import ipaddress
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


CSCLI = "/usr/bin/cscli"
NFT = "/usr/sbin/nft"
SCENARIO = "local/ssh-slow-bruteforce"
TABLE = "renew_ssh_permanent"
STATE_FILE = Path("/var/lib/crowdsec/permanent-ssh-bans.txt")


def nft(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run([NFT, *args], capture_output=True, text=True, check=False)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or f"nft {' '.join(args)} failed")
    return result


def ensure_object(kind: str, name: str, create_args: tuple[str, ...]) -> None:
    if nft("list", kind, "inet", TABLE, name, check=False).returncode:
        nft(*create_args)


def ensure_firewall() -> None:
    if nft("list", "table", "inet", TABLE, check=False).returncode:
        nft("add", "table", "inet", TABLE)

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
        rules = nft("list", "chain", "inet", TABLE, chain).stdout
        for rule in (
            ("ip", "saddr", "@banned_ipv4", "drop"),
            ("ip6", "saddr", "@banned_ipv6", "drop"),
        ):
            if " ".join(rule) not in rules:
                nft("add", "rule", "inet", TABLE, chain, *rule)


def read_state() -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    result: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    try:
        lines = STATE_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return result
    for line in lines:
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        try:
            result.add(ipaddress.ip_address(value))
        except ValueError:
            print(f"Ignoring invalid address in {STATE_FILE}: {value}", file=sys.stderr)
    return result


def alerts() -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    result = subprocess.run(
        [CSCLI, "alerts", "list", "--scenario", SCENARIO, "--limit", "0", "--output", "json"],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    if result.returncode:
        print(f"Could not read CrowdSec alerts: {result.stderr.strip()}", file=sys.stderr)
        return set()
    try:
        rows = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        print(f"Could not parse CrowdSec alerts: {error}", file=sys.stderr)
        return set()

    found: set[ipaddress.IPv4Address | ipaddress.IPv6Address] = set()
    for alert in rows if isinstance(rows, list) else []:
        if alert.get("scenario") != SCENARIO or alert.get("simulated"):
            continue
        source = alert.get("source") or {}
        if str(source.get("scope", "")).lower() != "ip":
            continue
        try:
            found.add(ipaddress.ip_address(str(source.get("value", ""))))
        except ValueError:
            continue
    return found


def add_element(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
    set_name = "banned_ipv4" if address.version == 4 else "banned_ipv6"
    result = nft(
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


def save_state(addresses: set[ipaddress.IPv4Address | ipaddress.IPv6Address]) -> None:
    STATE_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    content = "".join(f"{address}\n" for address in sorted(addresses, key=lambda item: (item.version, int(item))))
    fd, temp_name = tempfile.mkstemp(prefix="permanent-ssh-bans-", dir=STATE_FILE.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, STATE_FILE)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> int:
    if os.geteuid() != 0:
        print("Run as root.", file=sys.stderr)
        return 1
    ensure_firewall()
    addresses = read_state() | alerts()
    save_state(addresses)
    for address in sorted(addresses, key=lambda item: (item.version, int(item))):
        add_element(address)
    print(f"Loaded {len(addresses)} permanent SSH brute-force ban(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
