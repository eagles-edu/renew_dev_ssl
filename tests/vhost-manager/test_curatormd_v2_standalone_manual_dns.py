"""Exercise manual DNS renewal failure inside private filesystem mounts."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
RENEW_SCRIPT = PROJECT_ROOT / "acme_dns_manual_nginx_swap.sh"
REDACTOR = PROJECT_ROOT / "redact_manual_dns_log.py"
CHALLENGE_CANARY = "CURATOR_V2_TEST_ONLY_DNS_CHALLENGE_VALUE"


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


class StandaloneManualDNSWorkflowTests(unittest.TestCase):
    """Keep ACME output, logs, Nginx paths, and the result hook disposable."""

    def test_failed_issue_redacts_log_and_removes_transient_output(self) -> None:
        unshare = shutil.which("unshare")
        mount = shutil.which("mount")
        if not unshare or not mount:
            self.skipTest("user/mount namespaces are unavailable")

        domain = f"curator-{uuid.uuid4().hex[:12]}.example.test"
        with tempfile.TemporaryDirectory(prefix="vhost-manual-dns-namespace-") as raw:
            fixture = Path(raw)
            nginx = fixture / "etc-nginx"
            enabled = nginx / "sites-enabled"
            available = nginx / "sites-available"
            staged = available / "vhost_ssl"
            enabled.mkdir(parents=True)
            staged.mkdir(parents=True)
            (available / f"{domain}.conf").write_text(
                "server { listen 443 ssl; }\n", encoding="utf-8"
            )
            stage_config = staged / f"{domain}_ssl.conf"
            stage_config.write_text("server { listen 80; }\n", encoding="utf-8")
            (enabled / f"{domain}_ssl.conf").symlink_to(
                f"/etc/nginx/sites-available/vhost_ssl/{domain}_ssl.conf"
            )

            fixture_tmp = fixture / "tmp"
            fixture_tmp.mkdir()
            fixture_logs = fixture / "var-log"
            fixture_logs.mkdir()
            fixture_lock = fixture / "run-lock"
            fixture_lock.mkdir()
            bin_dir = fixture / "bin"
            bin_dir.mkdir()
            acme_home = fixture / "acme-home"
            acme_home.mkdir()
            consumer = fixture / "consumer"
            consumer.mkdir()
            shutil.copy2(RENEW_SCRIPT, consumer / RENEW_SCRIPT.name)
            shutil.copy2(REDACTOR, consumer / REDACTOR.name)
            helper = consumer / "vhost-manager/curatormd-v2/script_result_bridge.py"
            helper.parent.mkdir(parents=True)
            helper.write_text("# dispatched by the disposable python wrapper\n", encoding="utf-8")

            _write_executable(bin_dir / "nginx", "#!/bin/sh\nexit 0\n")
            _write_executable(
                bin_dir / "systemctl", "#!/bin/sh\nexit 0\n"
            )
            acme = acme_home / "acme.sh"
            _write_executable(
                acme,
                "#!/bin/sh\n"
                "case \" $* \" in\n"
                "  *' --issue '*)\n"
                "    printf \"Domain: '_acme-challenge.%s'\\n\" \"$FIXTURE_DOMAIN\"\n"
                f"    printf \"TXT value: '{CHALLENGE_CANARY}'\\n\"\n"
                "    printf \"Domain: '_acme-challenge.www.%s'\\n\" \"$FIXTURE_DOMAIN\"\n"
                f"    printf \"TXT value: '{CHALLENGE_CANARY}'\\n\"\n"
                "    printf 'Please add the TXT records\\n'\n"
                "    exit 1\n"
                "    ;;\n"
                "esac\n"
                "exit 0\n",
            )
            result_capture = fixture / "result-arguments.txt"
            _write_executable(
                bin_dir / "python3",
                "#!/bin/sh\n"
                "case \"${1:-}\" in\n"
                "  */script_result_bridge.py)\n"
                "    shift\n"
                "    printf '%s\\n' \"$*\" >> \"$FIXTURE_RESULT_CAPTURE\"\n"
                "    exit 0\n"
                "    ;;\n"
                "esac\n"
                "exec \"$REAL_PYTHON\" \"$@\"\n",
            )

            runner = fixture / "run-in-namespace.sh"
            runner.write_text(
                "#!/bin/sh\n"
                "set -eu\n"
                f"{mount} --make-rprivate /\n"
                f"{mount} --bind \"$FIXTURE_NGINX\" /etc/nginx\n"
                f"{mount} --bind \"$FIXTURE_LOGS\" /var/log\n"
                f"{mount} --bind \"$FIXTURE_LOCK\" /run/lock\n"
                "export PATH=\"$FIXTURE_BIN:/usr/bin:/bin\"\n"
                "export TMPDIR=\"$FIXTURE_TMP\"\n"
                "exec \"$FIXTURE_SCRIPT\" --domain \"$FIXTURE_DOMAIN\" --mode new\n",
                encoding="utf-8",
            )
            runner.chmod(0o755)
            result = subprocess.run(
                [unshare, "--user", "--map-root-user", "--mount", "--fork", str(runner)],
                input="y\n\nr\n",
                capture_output=True,
                check=False,
                cwd=PROJECT_ROOT,
                env={
                    **os.environ,
                    "FIXTURE_NGINX": str(nginx),
                    "FIXTURE_TMP": str(fixture_tmp),
                    "FIXTURE_LOGS": str(fixture_logs),
                    "FIXTURE_LOCK": str(fixture_lock),
                    "FIXTURE_BIN": str(bin_dir),
                    "FIXTURE_SCRIPT": str(consumer / RENEW_SCRIPT.name),
                    "FIXTURE_DOMAIN": domain,
                    "FIXTURE_RESULT_CAPTURE": str(result_capture),
                    "REAL_PYTHON": shutil.which("python3") or "/usr/bin/python3",
                    "ACME_HOME": str(acme_home),
                    "ACME_BIN": str(acme),
                },
                timeout=25,
                text=True,
            )

            self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
            log_files = list(fixture_logs.glob("acme-dns-manual-*.log"))
            self.assertEqual(len(log_files), 1)
            saved_log = log_files[0].read_text(encoding="utf-8")
            self.assertNotIn(CHALLENGE_CANARY, saved_log)
            self.assertIn("[REDACTED TXT value]", saved_log)
            self.assertEqual(list(fixture_tmp.iterdir()), [])
            self.assertTrue(result_capture.is_file())
            result_args = result_capture.read_text(encoding="utf-8")
            self.assertIn("manual_dns_renewal", result_args)
            self.assertIn(" 1", result_args)
            self.assertNotIn(domain, result_args)
            self.assertNotIn(CHALLENGE_CANARY, result_args)
            self.assertTrue((enabled / f"{domain}_ssl.conf").is_symlink())
            self.assertFalse((enabled / f"{domain}.conf").exists())


if __name__ == "__main__":
    unittest.main()
