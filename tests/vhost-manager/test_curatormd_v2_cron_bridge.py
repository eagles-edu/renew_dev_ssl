"""Exercise the cron producer bridge with fake ACME and a local receipt endpoint."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
import unittest
import uuid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE_BRIDGE = PROJECT_ROOT / "vhost-manager/curatormd-v2/acme_cron_bridge.sh"
BRIDGE = Path(os.environ.get("CURATOR_V2_CRON_BRIDGE", str(SOURCE_BRIDGE)))
OUTPUT_CANARY = "CURATOR_V2_CRON_OUTPUT_MUST_NOT_BE_STORED"


class CronBridgeTests(unittest.TestCase):
    """Keep the cron environment, ACME output, queue, and receipt disposable."""

    def test_cron_bridge_posts_only_exit_status_and_removes_acknowledged_queue(self) -> None:
        class ReceiptHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path != "/api/session":
                    self.send_error(404)
                    return
                body = b'{"csrf":"fixture-csrf"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:
                if self.path != "/api/ssl-cron-result":
                    self.send_error(404)
                    return
                self.server.received.append({
                    "headers": dict(self.headers),
                    "body": self.rfile.read(int(self.headers["Content-Length"])),
                })
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), ReceiptHandler)
        server.received = []
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="vhost-cron-bridge-") as raw:
                fixture = Path(raw)
                acme_home = fixture / "acme-home"
                acme_home.mkdir()
                pending = fixture / "pending"
                fake_acme = fixture / "fake-acme.sh"
                fake_acme.write_text(
                    "#!/bin/sh\n"
                    f"printf '%s\\n' '{OUTPUT_CANARY}'\n"
                    f"printf '%s\\n' '{OUTPUT_CANARY}' >&2\n"
                    "exit \"$FIXTURE_ACME_EXIT\"\n",
                    encoding="utf-8",
                )
                fake_acme.chmod(0o755)
                port = server.server_address[1]
                vhost = f"127.0.0.1:{port}"
                env = {
                    "PATH": "/usr/bin:/bin",
                    "ACME_BIN": str(fake_acme),
                    "ACME_HOME": str(acme_home),
                    "VHOST_MANAGER_URL": f"http://{vhost}",
                    "VHOST_MANAGER_HOST": vhost,
                    "CURL_BIN": shutil.which("curl") or "/usr/bin/curl",
                    "PYTHON_BIN": sys.executable,
                    "LOGGER_BIN": shutil.which("logger") or "/usr/bin/logger",
                    "PENDING_DIR": str(pending),
                    "FIXTURE_ACME_EXIT": "19",
                }
                result = subprocess.run(
                    ["/bin/bash", str(BRIDGE)],
                    cwd=PROJECT_ROOT,
                    env=env,
                    capture_output=True,
                    check=False,
                    timeout=15,
                    text=True,
                )

                self.assertEqual(result.returncode, 19, result.stderr + result.stdout)
                self.assertNotIn(OUTPUT_CANARY, result.stdout)
                self.assertNotIn(OUTPUT_CANARY, result.stderr)
                self.assertEqual(len(server.received), 1)
                sent = server.received[0]
                normalized_headers = {
                    name.lower(): value for name, value in sent["headers"].items()
                }
                self.assertEqual(
                    normalized_headers.get("x-csrf-token"), "fixture-csrf"
                )
                self.assertEqual(
                    normalized_headers.get("origin"), f"http://{vhost}"
                )
                payload = json.loads(sent["body"])
                self.assertEqual(set(payload), {"operationId", "exitCode"})
                uuid.UUID(payload["operationId"])
                self.assertEqual(payload["exitCode"], 19)
                self.assertNotIn(OUTPUT_CANARY, sent["body"].decode("utf-8"))
                self.assertEqual(list(pending.iterdir()), [])
                self.assertEqual(pending.stat().st_mode & 0o777, 0o700)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()


if __name__ == "__main__":
    unittest.main()
