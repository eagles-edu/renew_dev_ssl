"""Tests for bounded, content-free manual DNS log expiry."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "deploy"
    / "acme-log-expiry"
    / "expire_manual_dns_logs.py"
)
SPEC = importlib.util.spec_from_file_location("manual_dns_log_expiry", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ManualDNSLogExpiryTests(unittest.TestCase):
    """Keep expiry scoped to old manual-DNS regular files."""

    def test_expiry_removes_only_stale_matching_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            now = 2_000_000_000.0
            stale = root / "acme-dns-manual-example.test-1.log"
            stale.write_text("never read", encoding="utf-8")
            stale.touch()
            import os

            os.utime(stale, (now - MODULE.CLEAN_AFTER_SECONDS - 1,) * 2)

            recent = root / "acme-dns-manual-example.test-2.log"
            recent.write_text("preserve", encoding="utf-8")
            os.utime(recent, (now - MODULE.CLEAN_AFTER_SECONDS + 1,) * 2)

            unrelated = root / "other-example.test.log"
            unrelated.write_text("preserve", encoding="utf-8")
            os.utime(unrelated, (now - MODULE.CLEAN_AFTER_SECONDS - 1,) * 2)

            link = root / "acme-dns-manual-link.log"
            link.symlink_to(unrelated)

            removed = MODULE.expire_logs(root, now=now)

            self.assertEqual(removed, 1)
            self.assertFalse(stale.exists())
            self.assertTrue(recent.exists())
            self.assertTrue(unrelated.exists())
            self.assertTrue(link.is_symlink())

    def test_expiry_refuses_a_symlink_as_the_log_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "logs"
            target.mkdir()
            link = root / "log-link"
            link.symlink_to(target, target_is_directory=True)

            with self.assertRaises(NotADirectoryError):
                MODULE.expire_logs(link)


if __name__ == "__main__":
    unittest.main()
