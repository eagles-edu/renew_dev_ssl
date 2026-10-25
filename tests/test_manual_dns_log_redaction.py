"""Persistent manual DNS logs must not retain secrets or challenge values."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
REDACTOR = REPO_ROOT / "redact_manual_dns_log.py"


class ManualDNSLogRedactionTests(unittest.TestCase):
    """Exercise the same streaming filter used by the manual ACME script."""

    def test_redacts_manual_dns_values_credentials_and_private_keys(self) -> None:
        canary = "CANARY_DNS_TXT_VALUE_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
        credential = "CANARY_PASSWORD_VALUE_DO_NOT_PERSIST"
        api_key = "CANARY_API_KEY_VALUE_DO_NOT_PERSIST"
        key_body = "CANARY_PRIVATE_KEY_BODY_DO_NOT_PERSIST"
        source = "\n".join(
            (
                f"TXT value: {canary}",
                f"  _acme-challenge.example.invalid TXT: {canary}",
                f"Expected: '{canary}'",
                f"DNS answer: \"{canary}\"",
                f"pwd={credential}",
                f"api_key={api_key}",
                "-----BEGIN RSA PRIVATE KEY-----",
                key_body,
                "-----END RSA PRIVATE KEY-----",
                "safe status: certificate renewal completed",
                "",
            )
        )

        completed = subprocess.run(
            [sys.executable, str(REDACTOR)],
            input=source,
            text=True,
            capture_output=True,
            check=True,
        )

        self.assertNotIn(canary, completed.stdout)
        self.assertNotIn(credential, completed.stdout)
        self.assertNotIn(api_key, completed.stdout)
        self.assertNotIn(key_body, completed.stdout)
        self.assertIn("TXT value: [REDACTED TXT value]", completed.stdout)
        self.assertIn("pwd: [REDACTED credential]", completed.stdout)
        self.assertIn("safe status: certificate renewal completed", completed.stdout)


if __name__ == "__main__":
    unittest.main()
