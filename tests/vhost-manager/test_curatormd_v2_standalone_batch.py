"""Exercise the interactive batch wrapper with private state mounts."""

from __future__ import annotations

import errno
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BATCH_SCRIPT = PROJECT_ROOT / "renew_all_domains.sh"
RESULT_HELPER = PROJECT_ROOT / "vhost-manager/curatormd-v2/script_result_bridge.py"


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


class StandaloneBatchWorkflowTests(unittest.TestCase):
    """Keep batch progress, locks, child work, and reporting in fixture mounts."""

    def test_confirmed_batch_records_only_its_content_free_outcome(self) -> None:
        unshare = shutil.which("unshare")
        mount = shutil.which("mount")
        if not unshare or not mount:
            self.skipTest("user/mount namespaces are unavailable")

        domain = f"curator-{uuid.uuid4().hex[:12]}.example.test"
        with tempfile.TemporaryDirectory(prefix="vhost-batch-namespace-") as raw:
            fixture = Path(raw)
            fixture_lock = fixture / "run-lock"
            fixture_lock.mkdir()
            fixture_varlib = fixture / "var-lib"
            (fixture_varlib / "acme-dns-manual-nginx-swap").mkdir(parents=True)
            fixture_bin = fixture / "bin"
            fixture_bin.mkdir()
            inventory = fixture / "inventory.md"
            inventory.write_text(
                "## NEW\n\n"
                "| Main domain | SAN domains | Key length | CA | Expires | Status |\n"
                "| --- | --- | --- | --- | --- | --- |\n"
                f"| `{domain}` | `www.{domain}` | ec-256 | — | — | NEW |\n",
                encoding="utf-8",
            )
            child_result = fixture / "child-ran"
            child = fixture / "manual-renewal-fixture.sh"
            _write_executable(
                child,
                f'#!/bin/sh\nprintf "called\\n" > "{child_result}"\nexit 0\n',
            )
            updater = fixture / "inventory-updater-fixture.sh"
            _write_executable(
                updater,
                "#!/bin/sh\n"
                "cat > \"$FIXTURE_INVENTORY\" <<'INVENTORY'\n"
                "## CURRENT\n\n"
                "| Main domain | SAN domains | Key length | CA | Expires | Status |\n"
                "| --- | --- | --- | --- | --- | --- |\n"
                f"| `{domain}` | `www.{domain}` | ec-256 | — | 2030-01-01 | CURRENT |\n"
                "INVENTORY\n",
            )
            result_capture = fixture / "result-arguments.log"
            _write_executable(
                fixture_bin / "python3",
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_RESULT_CAPTURE"\nexit 0\n',
            )

            consumer = fixture / "consumer"
            (consumer / "vhost-manager/curatormd-v2").mkdir(parents=True)
            batch_copy = consumer / "renew_all_domains.sh"
            shutil.copy2(BATCH_SCRIPT, batch_copy)
            shutil.copy2(
                RESULT_HELPER,
                consumer / "vhost-manager/curatormd-v2/script_result_bridge.py",
            )
            runner = fixture / "run-in-namespace.sh"
            runner.write_text(
                "#!/bin/sh\n"
                "set -eu\n"
                f"{mount} --make-rprivate /\n"
                f"{mount} --bind \"$FIXTURE_LOCK\" /run/lock\n"
                f"{mount} --bind \"$FIXTURE_VARLIB\" /var/lib\n"
                "export PATH=\"$FIXTURE_BIN:/usr/bin:/bin\"\n"
                "exec \"$FIXTURE_BATCH\" --inventory \"$FIXTURE_INVENTORY\" "
                "--script \"$FIXTURE_CHILD\" --updater \"$FIXTURE_UPDATER\"\n",
                encoding="utf-8",
            )
            runner.chmod(0o755)

            master, slave = pty.openpty()
            process = subprocess.Popen(
                [unshare, "--user", "--map-root-user", "--mount", "--fork", str(runner)],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                close_fds=True,
                cwd=PROJECT_ROOT,
                env={
                    **os.environ,
                    "FIXTURE_LOCK": str(fixture_lock),
                    "FIXTURE_VARLIB": str(fixture_varlib),
                    "FIXTURE_BIN": str(fixture_bin),
                    "FIXTURE_BATCH": str(batch_copy),
                    "FIXTURE_INVENTORY": str(inventory),
                    "FIXTURE_CHILD": str(child),
                    "FIXTURE_UPDATER": str(updater),
                    "FIXTURE_RESULT_CAPTURE": str(result_capture),
                },
                text=False,
            )
            os.close(slave)
            transcript = bytearray()
            confirmed = False
            selected = False
            try:
                deadline = time.monotonic() + 20
                while process.poll() is None and time.monotonic() < deadline:
                    ready, _, _ = select.select([master], [], [], 0.1)
                    if not ready:
                        continue
                    try:
                        chunk = os.read(master, 4096)
                    except OSError as error:
                        if error.errno == errno.EIO:  # Linux PTY reports EIO when the slave closes.
                            process.wait(timeout=5)
                            break
                        raise
                    transcript.extend(chunk)
                    if not confirmed and b"Proceed with the list above?" in transcript:
                        os.write(master, b"y\n")
                        confirmed = True
                    if confirmed and not selected and b"ACTION: process" in transcript:
                        os.write(master, b"\n")
                        selected = True
                if process.poll() is None:
                    process.kill()
                    self.fail("batch fixture did not finish after both confirmations: " + transcript.decode(errors="replace"))
                while True:
                    ready, _, _ = select.select([master], [], [], 0)
                    if not ready:
                        break
                    try:
                        transcript.extend(os.read(master, 4096))
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
            finally:
                os.close(master)
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)

            self.assertEqual(process.returncode, 0, transcript.decode(errors="replace"))
            self.assertTrue(confirmed)
            self.assertTrue(selected)
            self.assertEqual(child_result.read_text(encoding="utf-8"), "called\n")
            progress = fixture_varlib / "acme-dns-manual-nginx-swap/progress.tsv"
            self.assertTrue(progress.is_file())
            self.assertIn(domain, progress.read_text(encoding="utf-8"))
            self.assertEqual(progress.stat().st_mode & 0o777, 0o600)
            self.assertTrue((fixture_lock / "acme-dns-manual-all.lock").exists())
            result_arguments = result_capture.read_text(encoding="utf-8")
            self.assertIn("domain_batch_renewal", result_arguments)
            self.assertIn(" 0", result_arguments)
            self.assertNotIn(domain, result_arguments)


if __name__ == "__main__":
    unittest.main()
