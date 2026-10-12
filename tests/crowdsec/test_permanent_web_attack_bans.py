import importlib.util
import ipaddress
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "deploy/crowdsec/permanent-web-attack-bans.py"
SPEC = importlib.util.spec_from_file_location("permanent_web_attack_bans", SCRIPT)
assert SPEC and SPEC.loader
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)


class PermanentWebAttackPolicyTests(unittest.TestCase):
    def setUp(self):
        self.proxies = (ipaddress.ip_network("103.166.183.0/27"),)

    def test_all_http_security_scenarios_with_remediation_are_permanent(self):
        for scenario in (
            "crowdsecurity/http-probing",
            "crowdsecurity/http-generic-bf",
            "crowdsecurity/http-backdoors-attempts",
            "crowdsecurity/http-sqli-probing",
            "ltsich/http-w00tw00t",
        ):
            with self.subTest(scenario=scenario):
                alert = {
                    "kind": "crowdsec",
                    "scenario": scenario,
                    "remediation": True,
                    "source": {"scope": "Ip", "value": "91.92.40.188"},
                }
                self.assertTrue(policy.is_permanent_web_attack(alert, self.proxies))

    def test_virtual_patch_exploit_is_permanent_for_untrusted_source(self):
        alert = {
            "kind": "waf",
            "scenario": "crowdsecurity/vpatch-CVE-2025-29927",
            "source": {"scope": "Ip", "value": "91.92.40.188"},
        }
        self.assertTrue(policy.is_permanent_web_attack(alert, self.proxies))

    def test_never_turn_a_trusted_proxy_alert_into_an_ip_ban(self):
        alert = {
            "kind": "waf",
            "scenario": "crowdsecurity/vpatch-CVE-2025-29927",
            "source": {"scope": "Ip", "value": "103.166.183.10"},
        }
        self.assertFalse(policy.is_permanent_web_attack(alert, self.proxies))

    def test_ignore_simulated_nonsecurity_range_and_nonremediated_alerts(self):
        base = {
            "kind": "crowdsec",
            "scenario": "crowdsecurity/http-probing",
            "remediation": True,
            "source": {"scope": "Ip", "value": "91.92.40.188"},
        }
        for changes in (
            {"simulated": True},
            {"source": {"scope": "Range", "value": "91.92.40.0/24"}},
            {"remediation": False},
            {"scenario": "crowdsecurity/ssh-bf"},
        ):
            with self.subTest(changes=changes):
                alert = {**base, **changes}
                self.assertFalse(policy.is_permanent_web_attack(alert, self.proxies))

    def test_proxy_ranges_are_read_from_nginx_trust_config(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "oneshield-realip.conf"
            config.write_text(
                "set_real_ip_from 103.166.183.0/27;\n"
                "real_ip_header X-Forwarded-For;\n",
                encoding="utf-8",
            )
            networks = policy.trusted_proxy_networks(config)
        self.assertTrue(policy.is_trusted_proxy(ipaddress.ip_address("103.166.183.10"), networks))
        self.assertFalse(policy.is_trusted_proxy(ipaddress.ip_address("91.92.40.188"), networks))


if __name__ == "__main__":
    unittest.main()
