import importlib.util
import ipaddress
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


updater = load_module(
    "update_trusted_crawler_ranges", ROOT / "deploy/crowdsec/update-trusted-crawler-ranges.py"
)
ban_policy = load_module(
    "permanent_web_attack_bans", ROOT / "deploy/crowdsec/permanent-web-attack-bans.py"
)


def valid_feed(count=500):
    start = int(ipaddress.IPv4Address("8.8.8.1"))
    return "\n".join(f"{ipaddress.IPv4Address(start + index)}/32" for index in range(count))


class TrustedCrawlerFeedTests(unittest.TestCase):
    def test_parse_canonicalizes_deduplicates_and_supports_ipv4_and_ipv6(self):
        content = valid_feed() + "\n2606:4700::/32\n2606:4700::/32\n"
        networks = updater.parse_feed(content)
        self.assertEqual(len(networks), 501)
        self.assertIn(ipaddress.ip_network("2606:4700::/32"), networks)
        self.assertEqual(updater.canonical_content(networks).count("2606:4700::/32"), 1)

    def test_reject_empty_malformed_private_and_oversized_ranges(self):
        for content, message in (
            ("", "only 0 valid networks"),
            (valid_feed() + "\nnot-an-ip", "Invalid CIDR"),
            (valid_feed() + "\n10.0.0.0/8", "non-global network"),
            (valid_feed() + "\n8.0.0.0/7", "overly broad"),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                updater.parse_feed(content)

    def test_failed_download_keeps_last_known_good_files(self):
        with tempfile.TemporaryDirectory() as directory:
            cidrs = Path(directory) / "trusted-crawler-cidrs.txt"
            geo = Path(directory) / "trusted-crawler-map.conf"
            cidrs.write_text("8.8.8.8/32\n", encoding="utf-8")
            geo.write_text("8.8.8.8/32 1;\n", encoding="utf-8")

            def failed_fetch():
                raise RuntimeError("network unavailable")

            with self.assertRaisesRegex(RuntimeError, "network unavailable"):
                updater.refresh(failed_fetch, cidrs, geo)
            self.assertEqual(cidrs.read_text(encoding="utf-8"), "8.8.8.8/32\n")
            self.assertEqual(geo.read_text(encoding="utf-8"), "8.8.8.8/32 1;\n")

    def test_failed_nginx_validation_rolls_back_both_files(self):
        with tempfile.TemporaryDirectory() as directory:
            cidrs = Path(directory) / "trusted-crawler-cidrs.txt"
            geo = Path(directory) / "trusted-crawler-map.conf"
            cidrs.write_text("8.8.8.8/32\n", encoding="utf-8")
            geo.write_text("8.8.8.8/32 1;\n", encoding="utf-8")

            def reject():
                raise RuntimeError("nginx config rejected")

            with self.assertRaisesRegex(RuntimeError, "nginx config rejected"):
                updater.apply_feed(valid_feed(), cidrs, geo, reject)
            self.assertEqual(cidrs.read_text(encoding="utf-8"), "8.8.8.8/32\n")
            self.assertEqual(geo.read_text(encoding="utf-8"), "8.8.8.8/32 1;\n")


class TrustedCrawlerBanPolicyTests(unittest.TestCase):
    def setUp(self):
        self.proxies = (ipaddress.ip_network("103.166.183.0/27"),)
        self.crawlers = (ipaddress.ip_network("8.8.8.0/24"), ipaddress.ip_network("2606:4700::/32"))
        self.http_alert = {
            "kind": "crowdsec",
            "scenario": "crowdsecurity/http-probing",
            "remediation": True,
            "source": {"scope": "Ip", "value": "8.8.8.8"},
        }

    def test_trusted_ipv4_and_ipv6_crawler_alerts_do_not_become_permanent_bans(self):
        self.assertFalse(
            ban_policy.is_permanent_web_attack(self.http_alert, self.proxies, self.crawlers)
        )
        ipv6_alert = {
            **self.http_alert,
            "source": {"scope": "Ip", "value": "2606:4700::1234"},
        }
        self.assertFalse(
            ban_policy.is_permanent_web_attack(ipv6_alert, self.proxies, self.crawlers)
        )

    def test_unlisted_source_still_qualifies_for_permanent_ban(self):
        alert = {**self.http_alert, "source": {"scope": "Ip", "value": "91.92.40.188"}}
        self.assertTrue(ban_policy.is_permanent_web_attack(alert, self.proxies, self.crawlers))

    def test_existing_matching_bans_are_released_from_reconciled_state(self):
        previous = {
            ipaddress.ip_address("8.8.8.8"),
            ipaddress.ip_address("91.92.40.188"),
        }
        detected = {ipaddress.ip_address("2606:4700::1234")}
        addresses, removals = ban_policy.reconcile_addresses(
            previous, detected, set(), self.crawlers
        )
        self.assertEqual(addresses, {ipaddress.ip_address("91.92.40.188")})
        self.assertEqual(
            removals,
            {ipaddress.ip_address("8.8.8.8"), ipaddress.ip_address("2606:4700::1234")},
        )

    def test_trusted_crawler_file_rejects_malformed_and_broad_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trusted-crawler-cidrs.txt"
            path.write_text("invalid\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Invalid trusted crawler"):
                ban_policy.trusted_crawler_networks(path)
            path.write_text("8.0.0.0/7\n", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "too broad"):
                ban_policy.trusted_crawler_networks(path)


if __name__ == "__main__":
    unittest.main()
