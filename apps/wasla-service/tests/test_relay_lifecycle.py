"""Private temporary fixtures and fake workers; no network, UI or production state."""
import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from wasla.__main__ import build_parser
from wasla.relay import RelayError
from wasla.relay_lifecycle import OwnedRelay, load_relay_config


class RelayConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.path = self.root / "relay-config.json"
        self.url = "https://100.72.126.108:47621"
        self.pin = "a" * 64
        self.value = {"enabled": True, "base_url": "https://relay.example.com", "relay_token": "r" * 48,
                      "installation_id": "test-installation", "key_base64": base64.b64encode(b"k" * 32).decode(),
                      "local_url": self.url, "local_pin": self.pin}

    def load(self, value=None):
        self.path.write_text(json.dumps(self.value if value is None else value), encoding="utf-8")
        return load_relay_config(self.path, self.root, self.url, self.pin)

    def test_no_explicit_flag_is_disabled_even_with_relay_environment(self):
        with patch.dict("os.environ", {"WASLA_RELAY_ENABLED": "1", "WASLA_RELAY_TOKEN": "r" * 48}):
            self.assertIsNone(load_relay_config(None, self.root, self.url, self.pin))
        self.assertFalse(self.path.exists())
        args = build_parser().parse_args(["serve"])
        self.assertIsNone(args.relay_config)
        self.assertFalse(args.allow_desktop)
        self.assertFalse(args.allow_app_actions)

    def test_private_configuration_is_bound_to_backend_and_preserves_state(self):
        for name, body in (("devices.json", '{"existing":"device"}'), ("certificate.pem", "existing certificate")):
            (self.root / name).write_text(body, encoding="utf-8")
        config = self.load()
        self.assertEqual(config.state_root, self.root.resolve())
        self.assertEqual(config.key, b"k" * 32)
        self.assertEqual(config.local_url, self.url)
        self.assertEqual((self.root / "devices.json").read_text(), '{"existing":"device"}')
        self.assertEqual((self.root / "certificate.pem").read_text(), "existing certificate")
        self.assertNotIn(self.value["relay_token"], repr(config))

    def test_explicitly_disabled_config_opens_nothing(self):
        self.assertIsNone(self.load({"enabled": False}))

    def test_mismatched_tls_or_unknown_fields_fail_closed(self):
        for change in ({"local_pin": "b" * 64}, {"local_url": "https://127.0.0.1:47621"},
                       {"state_root": "/elsewhere"}, {"enabled": "true"}, {"relay_token": "short"},
                       {"key_base64": "bad"}, {"base_url": "http://relay.example.com"}):
            with self.subTest(change=list(change)), self.assertRaises(RelayError):
                self.load({**self.value, **change})

    def test_configuration_cannot_be_read_from_another_directory(self):
        with self.assertRaises(RelayError):
            load_relay_config(self.root / "other.json", self.root, self.url, self.pin)

    def test_missing_duplicate_or_oversized_file_is_rejected(self):
        with self.assertRaises(RelayError):
            load_relay_config(self.path, self.root, self.url, self.pin)
        for raw in ('{"enabled":false,"enabled":true}', "x" * 16385):
            self.path.write_text(raw, encoding="utf-8")
            with self.assertRaises(RelayError):
                load_relay_config(self.path, self.root, self.url, self.pin)


class OwnedRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_joins_only_the_owned_worker(self):
        started = threading.Event()
        completed = threading.Event()
        def work(stop):
            started.set()
            stop.wait(2)
            completed.set()
        worker = Mock()
        worker.run_forever.side_effect = work
        relay = OwnedRelay(object(), worker_factory=Mock(return_value=worker))
        self.assertFalse(relay.thread.is_alive())
        relay.start()
        self.assertTrue(started.wait(1))
        relay.request_stop()
        await relay.close()
        self.assertTrue(completed.is_set())
        self.assertFalse(relay.thread.is_alive())
        worker.run_forever.assert_called_once_with(relay.stop_event)
        self.assertFalse(relay.failed)

    async def test_unstarted_worker_can_be_closed_without_starting(self):
        worker = Mock()
        relay = OwnedRelay(object(), worker_factory=Mock(return_value=worker))
        await relay.close()
        worker.run_forever.assert_not_called()

    async def test_worker_failure_does_not_log_secrets(self):
        worker = Mock()
        worker.run_forever.side_effect = RuntimeError("private-token-must-not-appear")
        relay = OwnedRelay(object(), worker_factory=Mock(return_value=worker))
        with patch("builtins.print") as output:
            relay.start()
            await relay.close()
        self.assertTrue(relay.failed)
        self.assertNotIn("private-token-must-not-appear", str(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
