"""Run the standalone Nginx setup utility inside private fixture mounts."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SETUP_SCRIPT = PROJECT_ROOT / "setup_nginx_vhost.sh"
RESULT_HELPER = PROJECT_ROOT / "vhost-manager/curatormd-v2/script_result_bridge.py"


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


class StandaloneNginxSetupTests(unittest.TestCase):
    """Verify an apply and its outcome hook without changing host files/services."""

    def test_apply_writes_only_fixture_mounts_and_emits_bounded_result(self) -> None:
        unshare = shutil.which("unshare")
        mount = shutil.which("mount")
        if not unshare or not mount:
            self.skipTest("user/mount namespaces are unavailable")

        domain = f"curator-{uuid.uuid4().hex[:12]}.example.test"
        host_available = Path(f"/etc/nginx/sites-available/{domain}.conf")
        host_enabled = Path(f"/etc/nginx/sites-enabled/{domain}.conf")
        host_webroot = Path(f"/home/{domain}")
        self.assertFalse(host_available.exists())
        self.assertFalse(host_enabled.exists())
        self.assertFalse(host_webroot.exists())

        with tempfile.TemporaryDirectory(prefix="vhost-nginx-setup-namespace-") as raw:
            fixture = Path(raw)
            fixture_nginx = fixture / "etc-nginx"
            (fixture_nginx / "sites-available").mkdir(parents=True)
            (fixture_nginx / "sites-enabled").mkdir()
            (fixture_nginx / "nginx.conf").write_text("user www-data;\n", encoding="utf-8")
            fixture_home = fixture / "home"
            fixture_home.mkdir()
            fixture_lock = fixture / "run-lock"
            fixture_lock.mkdir()
            fixture_bin = fixture / "bin"
            fixture_bin.mkdir()
            trace = fixture / "commands.log"
            result_capture = fixture / "result-arguments.log"

            _write_executable(
                fixture_bin / "nginx",
                '#!/bin/sh\nprintf "nginx %s\\n" "$*" >> "$FIXTURE_TRACE"\nexit 0\n',
            )
            _write_executable(
                fixture_bin / "systemctl",
                '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$FIXTURE_TRACE"\nexit 0\n',
            )
            _write_executable(fixture_bin / "id", "#!/bin/sh\nexit 0\n")
            _write_executable(
                fixture_bin / "runuser",
                '#!/bin/sh\n[ "$1" = -u ] || exit 2\nshift 3\nexec "$@"\n',
            )
            _write_executable(
                fixture_bin / "python3",
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FIXTURE_RESULT_CAPTURE"\nexit 0\n',
            )

            fixture_project = fixture / "consumer"
            (fixture_project / "vhost-manager/curatormd-v2").mkdir(parents=True)
            fixture_script = fixture_project / "setup_nginx_vhost.sh"
            shutil.copy2(SETUP_SCRIPT, fixture_script)
            shutil.copy2(
                RESULT_HELPER,
                fixture_project / "vhost-manager/curatormd-v2/script_result_bridge.py",
            )
            self.assertEqual(
                hashlib.sha256(fixture_script.read_bytes()).digest(),
                hashlib.sha256(SETUP_SCRIPT.read_bytes()).digest(),
            )

            runner = fixture / "run-in-namespace.sh"
            runner.write_text(
                "#!/bin/sh\n"
                "set -eu\n"
                f"{mount} --make-rprivate /\n"
                f"{mount} --bind \"$FIXTURE_NGINX\" /etc/nginx\n"
                f"{mount} --bind \"$FIXTURE_HOME\" /home\n"
                f"{mount} --bind \"$FIXTURE_LOCK\" /run/lock\n"
                "export PATH=\"$FIXTURE_BIN:/usr/bin:/bin\"\n"
                "exec \"$FIXTURE_SCRIPT\" --domain \"$FIXTURE_DOMAIN\" --backend off --apply\n",
                encoding="utf-8",
            )
            runner.chmod(0o755)
            result = subprocess.run(
                [unshare, "--user", "--map-root-user", "--mount", "--fork", str(runner)],
                capture_output=True,
                check=False,
                cwd=PROJECT_ROOT,
                env={
                    **os.environ,
                    "FIXTURE_NGINX": str(fixture_nginx),
                    "FIXTURE_HOME": str(fixture_home),
                    "FIXTURE_LOCK": str(fixture_lock),
                    "FIXTURE_BIN": str(fixture_bin),
                    "FIXTURE_SCRIPT": str(fixture_script),
                    "FIXTURE_DOMAIN": domain,
                    "FIXTURE_TRACE": str(trace),
                    "FIXTURE_RESULT_CAPTURE": str(result_capture),
                },
                timeout=20,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            config = fixture_nginx / "sites-available" / f"{domain}.conf"
            enabled = fixture_nginx / "sites-enabled" / f"{domain}.conf"
            self.assertTrue(config.is_file())
            self.assertTrue(enabled.is_symlink())
            self.assertEqual(
                os.readlink(enabled), f"/etc/nginx/sites-available/{domain}.conf"
            )
            self.assertTrue(
                (fixture_home / domain / "public_html/.well-known/acme-challenge").is_dir()
            )
            self.assertIn("nginx -t", trace.read_text(encoding="utf-8"))
            self.assertIn("systemctl reload nginx", trace.read_text(encoding="utf-8"))
            result_args = result_capture.read_text(encoding="utf-8")
            self.assertIn("nginx_vhost_setup", result_args)
            self.assertIn(" 0", result_args)
            self.assertNotIn(domain, result_args)
            self.assertFalse(host_available.exists())
            self.assertFalse(host_enabled.exists())
            self.assertFalse(host_webroot.exists())


if __name__ == "__main__":
    unittest.main()
