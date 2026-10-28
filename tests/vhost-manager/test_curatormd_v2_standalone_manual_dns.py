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

    def test_successful_issue_keeps_outputs_local_and_cleans_transients(self) -> None:
        unshare = shutil.which("unshare")
        mount = shutil.which("mount")
        if not unshare or not mount:
            self.skipTest("user/mount namespaces are unavailable")

        domain = f"curator-{uuid.uuid4().hex[:12]}.example.test"
        apex_token = f"CURATOR_V2_APEX_{uuid.uuid4().hex}"
        www_token = f"CURATOR_V2_WWW_{uuid.uuid4().hex}"
        with tempfile.TemporaryDirectory(prefix="vhost-manual-dns-success-") as raw:
            fixture = Path(raw)
            nginx = fixture / "etc-nginx"
            enabled = nginx / "sites-enabled"
            available = nginx / "sites-available"
            staged = available / "vhost_ssl"
            enabled.mkdir(parents=True)
            staged.mkdir(parents=True)
            domain_conf = available / f"{domain}.conf"
            domain_conf.write_text(
                "server_name " + domain + " www." + domain + ";\n"
                "ssl_certificate /etc/nginx/certs/fullchain.pem;\n"
                "ssl_certificate_key /etc/nginx/certs/private.key;\n",
                encoding="utf-8",
            )
            stage_conf = staged / f"{domain}_ssl.conf"
            stage_conf.write_text("server { listen 80; }\n", encoding="utf-8")
            stage_link = enabled / f"{domain}_ssl.conf"
            stage_link.symlink_to(
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

            _write_executable(
                bin_dir / "nginx",
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = -T ]; then\n"
                "  cat \"$FIXTURE_NGINX\"/sites-available/*.conf\n"
                "fi\n"
                "exit 0\n",
            )
            _write_executable(bin_dir / "systemctl", "#!/bin/sh\nexit 0\n")
            acme = acme_home / "acme.sh"
            _write_executable(
                acme,
                "#!/bin/sh\n"
                "case \" $* \" in\n"
                "  *' --issue '*)\n"
                "    mkdir -p \"$ACME_HOME/${FIXTURE_DOMAIN}_ecc\"\n"
                "    printf 'fixture cert\\n' > \"$ACME_HOME/${FIXTURE_DOMAIN}_ecc/fullchain.cer\"\n"
                "    printf 'fixture key\\n' > \"$ACME_HOME/${FIXTURE_DOMAIN}_ecc/${FIXTURE_DOMAIN}.key\"\n"
                "    printf \"Domain: '_acme-challenge.%s'\\n\" \"$FIXTURE_DOMAIN\"\n"
                "    printf \"TXT value: '%s'\\n\" \"$FIXTURE_APEX_TOKEN\"\n"
                "    printf \"Domain: '_acme-challenge.www.%s'\\n\" \"$FIXTURE_DOMAIN\"\n"
                "    printf \"TXT value: '%s'\\n\" \"$FIXTURE_WWW_TOKEN\"\n"
                "    exit 0\n"
                "    ;;\n"
                "  *' --install-cert '*)\n"
                "    while [ \"$#\" -gt 0 ]; do\n"
                "      case \"$1\" in\n"
                "        --key-file) key=$2; shift 2 ;;\n"
                "        --fullchain-file) cert=$2; shift 2 ;;\n"
                "        *) shift ;;\n"
                "      esac\n"
                "    done\n"
                "    mkdir -p \"$(dirname \"$key\")\" \"$(dirname \"$cert\")\"\n"
                "    printf 'fixture key\\n' > \"$key\"\n"
                "    printf 'fixture cert\\n' > \"$cert\"\n"
                "    ;;\n"
                "esac\n"
                "exit 0\n",
            )
            _write_executable(
                bin_dir / "dig",
                "#!/bin/sh\n"
                "query=''\n"
                "for arg in \"$@\"; do case \"$arg\" in _acme-challenge.*) query=$arg ;; esac; done\n"
                "case \" $* \" in\n"
                "  *' +authority SOA '*) printf '%s\\n' \"$FIXTURE_ZONE. 60 IN SOA ns1.fixture. hostmaster.fixture. 1 60 60 60 60\" ;;\n"
                "  *' +short NS '*) printf 'ns1.fixture.\\n' ;;\n"
                "  *' +short A '*) printf '192.0.2.1\\n' ;;\n"
                "  *' +short TXT '*)\n"
                "    case \"$query\" in *'.www.'*) printf '%s\\n' \"$FIXTURE_WWW_TOKEN\" ;; *) printf '%s\\n' \"$FIXTURE_APEX_TOKEN\" ;; esac\n"
                "    ;;\n"
                "  *' +comments +answer TXT '*)\n"
                "    printf ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\\n'\n"
                "    case \"$query\" in *'.www.'*) token=$FIXTURE_WWW_TOKEN ;; *) token=$FIXTURE_APEX_TOKEN ;; esac\n"
                "    printf '%s 60 IN TXT \\\"%s\\\"\\n' \"$query\" \"$token\"\n"
                "    ;;\n"
                "esac\n",
            )
            _write_executable(
                bin_dir / "openssl",
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = s_client ]; then printf 'fixture certificate\\n'; exit 0; fi\n"
                "args=\"$*\"\n"
                "out=''\n"
                "while [ \"$#\" -gt 0 ]; do\n"
                "  if [ \"$1\" = -out ]; then out=$2; shift 2; else shift; fi\n"
                "done\n"
                "if [ -n \"$out\" ]; then cat > \"$out\"; exit 0; fi\n"
                "case \" $args \" in *' -fingerprint '*) printf 'SHA256 Fingerprint=FIXTURE\\n' ;; esac\n"
                "exit 0\n",
            )
            result_capture = fixture / "result-arguments.txt"
            _write_executable(
                bin_dir / "python3",
                "#!/bin/sh\n"
                "case \"${1:-}\" in\n"
                "  */script_result_bridge.py) shift; printf '%s\\n' \"$*\" >> \"$FIXTURE_RESULT_CAPTURE\"; exit 0 ;;\n"
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
                input="y\n\n\ny\n",
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
                    "FIXTURE_ZONE": "example.test",
                    "FIXTURE_APEX_TOKEN": apex_token,
                    "FIXTURE_WWW_TOKEN": www_token,
                    "FIXTURE_RESULT_CAPTURE": str(result_capture),
                    "REAL_PYTHON": shutil.which("python3") or "/usr/bin/python3",
                    "ACME_HOME": str(acme_home),
                    "ACME_BIN": str(acme),
                },
                timeout=30,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            log_files = list(fixture_logs.glob("acme-dns-manual-*.log"))
            self.assertEqual(len(log_files), 1)
            saved_log = log_files[0].read_text(encoding="utf-8")
            self.assertNotIn(apex_token, saved_log)
            self.assertNotIn(www_token, saved_log)
            self.assertIn("[REDACTED TXT value]", saved_log)
            self.assertEqual(list(fixture_tmp.iterdir()), [])
            self.assertTrue((acme_home / f"{domain}_ecc" / "fullchain.cer").is_file())
            self.assertTrue((acme_home / f"{domain}_ecc" / f"{domain}.key").is_file())
            self.assertFalse(stage_link.exists())
            self.assertTrue((enabled / f"{domain}.conf").is_symlink())
            installed_cert = fixture / "etc-nginx/certs/fullchain.pem"
            installed_key = fixture / "etc-nginx/certs/private.key"
            self.assertTrue(installed_cert.is_file())
            self.assertTrue(installed_key.is_file())
            self.assertTrue(result_capture.is_file())
            result_args = result_capture.read_text(encoding="utf-8")
            self.assertRegex(result_args, r"^manual_dns_renewal [0-9a-f-]{36} 0\n$")
            self.assertNotIn(domain, result_args)
            self.assertNotIn(apex_token, result_args)
            self.assertNotIn(www_token, result_args)


if __name__ == "__main__":
    unittest.main()
