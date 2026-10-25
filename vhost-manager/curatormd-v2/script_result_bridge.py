"""Queue and submit content-free standalone utility outcomes to Vhost Manager."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


PRODUCERS = {
    "manual_dns_renewal",
    "domain_batch_renewal",
    "domain_inventory_refresh",
    "nginx_vhost_setup",
}
MAX_PENDING_RESULTS = 100


def _request(
    url: str, host: str, payload: bytes | None = None, csrf: str = ""
) -> bytes:
    headers = {"Host": host}
    method = "GET"
    if payload is not None:
        method = "POST"
        headers.update(
            {
                "Origin": f"http://{host}",
                "Content-Type": "application/json",
                "X-CSRF-Token": csrf,
            }
        )
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=5) as response:
        return response.read(16 * 1024)


def _store(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    if (
        not path.exists()
        and len(list(path.parent.glob("*.json"))) >= MAX_PENDING_RESULTS
    ):
        raise OSError("standalone receipt queue is full")
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _flush(directory: Path, base_url: str, host: str) -> None:
    session = json.loads(_request(f"{base_url}/api/session", host))
    csrf = session.get("csrf")
    if not isinstance(csrf, str) or not csrf:
        raise ValueError("Vhost Manager returned no CSRF token")
    for path in sorted(directory.glob("*.json")):
        value = json.loads(path.read_text(encoding="utf-8"))
        payload = json.dumps(value, separators=(",", ":")).encode()
        result = json.loads(
            _request(f"{base_url}/api/script-result", host, payload, csrf)
        )
        receipt = result.get("curatorV2") if isinstance(result, dict) else None
        if not isinstance(receipt, dict) or receipt.get("status") != "received":
            reason = receipt.get("reason") if isinstance(receipt, dict) else None
            if reason not in {"curator_unavailable", "receipt_unverified"}:
                reason = "receipt_unconfirmed"
            error_type = (
                receipt.get("bridgeErrorType") if isinstance(receipt, dict) else None
            )
            if not isinstance(error_type, str) or not error_type.isidentifier():
                error_type = ""
            suffix = f" ({error_type})" if error_type else ""
            raise ValueError(f"Vhost Manager returned {reason}{suffix}")
        path.unlink()
    directory_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _local_http_target(base_url: str) -> tuple[str, str]:
    parsed = urlsplit(base_url)
    if parsed.scheme != "http" or parsed.username is not None:
        raise ValueError("Vhost Manager result endpoint must be loopback HTTP")
    if parsed.password is not None or parsed.path not in {"", "/"}:
        raise ValueError("Vhost Manager result endpoint must be loopback HTTP")
    if parsed.query or parsed.fragment:
        raise ValueError("Vhost Manager result endpoint must be loopback HTTP")
    if parsed.hostname not in {"127.0.0.1", "::1"} or parsed.port is None:
        raise ValueError("Vhost Manager result endpoint must be loopback HTTP")
    return f"http://{parsed.netloc}", parsed.netloc


def _pending_directory() -> Path:
    """Choose the service-owned or per-user queue root."""

    pending_override = os.environ.get("CURATOR_V2_SCRIPT_PENDING_DIR")
    if pending_override:
        return Path(pending_override)
    if os.geteuid() == 0:
        return Path("/var/lib/vhost-manager/curatormd-v2-pending-script-results")
    state_home = Path(
        os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))
    )
    return state_home / "vhost-manager" / "curator-v2-script-results"


def main(arguments: list[str]) -> int:
    """Queue and deliver one allowlisted producer's outcome."""

    if len(arguments) != 3:
        return 2
    producer, operation_id, raw_exit_code = arguments
    try:
        parsed_id = uuid.UUID(operation_id)
        exit_code = int(raw_exit_code)
    except (ValueError, TypeError):
        return 2
    if producer not in PRODUCERS or str(parsed_id) != operation_id.lower():
        return 2
    if not 0 <= exit_code <= 255:
        return 2

    directory = _pending_directory()
    value = {
        "producerId": producer,
        "operationId": str(parsed_id),
        "exitCode": exit_code,
    }
    pending_path = directory / f"{parsed_id}.json"
    try:
        _store(pending_path, value)
        base_url, host = _local_http_target(
            os.environ.get("VHOST_MANAGER_URL", "http://127.0.0.1:4310")
        )
        _flush(directory, base_url, host)
    except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError) as error:
        # Never include utility input or output in the diagnostic.
        detail = str(error) if isinstance(error, ValueError) else type(error).__name__
        disposition = "remains queued" if pending_path.exists() else "could not be queued"
        print(f"Standalone result {disposition}: {detail}.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
