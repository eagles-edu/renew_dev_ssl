"""Bound the content-free standalone producer retry queue."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BRIDGE = PROJECT_ROOT / "vhost-manager/curatormd-v2/script_result_bridge.py"


class StandaloneResultBridgeTests(unittest.TestCase):
    """Keep offline producer results private and bounded."""

    def test_full_queue_fails_without_claiming_the_new_result_was_queued(self) -> None:
        with tempfile.TemporaryDirectory(prefix="curator-script-queue-") as raw_temp:
            queue = Path(raw_temp) / "pending"
            queue.mkdir(mode=0o700)
            for index in range(100):
                (queue / f"existing-{index:03}.json").write_text("{}", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(BRIDGE), "manual_dns_renewal", str(uuid.uuid4()), "1"],
                capture_output=True,
                check=False,
                cwd=PROJECT_ROOT,
                env={
                    **os.environ,
                    "CURATOR_V2_SCRIPT_PENDING_DIR": str(queue),
                    "VHOST_MANAGER_URL": "http://example.invalid:4310",
                },
                timeout=5,
                text=True,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("could not be queued", result.stderr)
            self.assertEqual(len(list(queue.glob("*.json"))), 100)


if __name__ == "__main__":
    unittest.main()
