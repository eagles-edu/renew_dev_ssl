"""Exercise standalone inventory refresh with fixture data and fake TLS tools."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid


PROJECT_ROOT = Path(__file__).resolve().parents[2]
INVENTORY_SCRIPT = PROJECT_ROOT / "update_domain_inventory.sh"


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


class StandaloneInventoryWorkflowTests(unittest.TestCase):
    """Keep inventory source, output, TLS fixtures, and temp files disposable."""

    def test_refresh_writes_fixture_inventory_and_content_free_receipt(self) -> None:
        domain = f"curator-{uuid.uuid4().hex[:12]}.example.test"
        with tempfile.TemporaryDirectory(prefix="vhost-inventory-workflow-") as raw:
            fixture = Path(raw)
            source = fixture / "source-inventory.md"
            source.write_text(f"{domain}\n", encoding="utf-8")
            output = fixture / "generated-inventory.md"
            nginx_enabled = fixture / "nginx-enabled"
            nginx_enabled.mkdir()
            temp_root = fixture / "tmp"
            temp_root.mkdir()
            bin_dir = fixture / "bin"
            bin_dir.mkdir()
            result_capture = fixture / "result-arguments.txt"

            _write_executable(
                bin_dir / "timeout",
                "#!/bin/sh\nshift\nexec \"$@\"\n",
            )
            _write_executable(
                bin_dir / "openssl",
                "#!/bin/sh\n"
                "if [ \"${1:-}\" = s_client ]; then printf 'fixture certificate\\n'; exit 0; fi\n"
                "[ \"${1:-}\" = x509 ] || exit 2\n"
                "shift\n"
                "while [ $# -gt 0 ]; do\n"
                "  case \"$1\" in\n"
                "    -out) shift; cat >/dev/null; printf 'fixture certificate\\n' > \"$1\"; exit 0 ;;\n"
                "    -enddate) echo 'notAfter=Jul  1 00:00:00 2030 GMT'; exit 0 ;;\n"
                "    -issuer) echo \"issuer=Let's Encrypt\"; exit 0 ;;\n"
                "    -text) printf 'X509v3 Subject Alternative Name:\\n DNS:%s, DNS:www.%s\\nid-ecPublicKey\\n' \"$FIXTURE_DOMAIN\" \"$FIXTURE_DOMAIN\"; exit 0 ;;\n"
                "  esac\n"
                "  shift\n"
                "done\n"
                "exit 2\n",
            )
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

            result = subprocess.run(
                [
                    "bash",
                    str(INVENTORY_SCRIPT),
                    "--source",
                    str(source),
                    "--output",
                    str(output),
                    "--nginx-dir",
                    str(nginx_enabled),
                ],
                capture_output=True,
                check=False,
                cwd=PROJECT_ROOT,
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
                    "TMPDIR": str(temp_root),
                    "FIXTURE_DOMAIN": domain,
                    "FIXTURE_RESULT_CAPTURE": str(result_capture),
                    "REAL_PYTHON": shutil.which("python3") or "/usr/bin/python3",
                },
                timeout=20,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            generated = output.read_text(encoding="utf-8")
            self.assertIn(domain, generated)
            self.assertIn("Let's Encrypt", generated)
            self.assertEqual(list(temp_root.iterdir()), [])
            result_args = result_capture.read_text(encoding="utf-8")
            self.assertIn("domain_inventory_refresh", result_args)
            self.assertIn(" 0", result_args)
            self.assertNotIn(domain, result_args)


if __name__ == "__main__":
    unittest.main()
