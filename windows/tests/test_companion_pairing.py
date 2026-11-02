"""Headless callbacks only: no Tk window, service, private state or input."""
import unittest
from unittest.mock import Mock, patch

from companion import Companion, ordered_addresses


class CompanionPairingTests(unittest.TestCase):
    def setUp(self):
        self.panel = Companion.__new__(Companion)
        self.panel.process = Mock()
        self.panel.process.poll.return_value = None
        self.panel.stopping = False
        self.panel.uri = Mock()
        self.panel.fingerprint = Mock()
        self.panel.status = Mock()
        self.panel.pairing_note = Mock()
        self.panel._owned_status = Mock(return_value=object())
        self.panel._controls = Mock()
        self.panel.create_pairing = Mock()
        self.panel.stop = Mock()
        self.identity = ({'host': '100.72.126.108', 'port': 47621, 'desktop_enabled': False}, 'a' * 64)

    def test_verified_ready_service_creates_code_without_extra_click(self):
        self.panel._identity_ready(self.identity, None)
        self.panel.uri.set.assert_called_once_with('https://100.72.126.108:47621')
        self.assertTrue(self.panel.ready)
        self.panel.create_pairing.assert_called_once_with()

    def test_unverified_process_never_generates_code(self):
        self.panel._owned_status.return_value = None
        self.panel._identity_ready(self.identity, None)
        self.panel.create_pairing.assert_not_called()

    def test_closed_or_stopping_service_never_generates_code(self):
        self.panel.stopping = True
        self.panel._identity_ready(self.identity, None)
        self.panel.create_pairing.assert_not_called()
        self.panel.stopping = False
        self.panel.process.poll.return_value = 0
        self.panel._identity_ready(self.identity, None)
        self.panel.create_pairing.assert_not_called()

    def test_identity_error_stops_service_without_creating_code(self):
        self.panel._identity_ready(None, 'certificate unavailable')
        self.panel.stop.assert_called_once_with()
        self.panel.create_pairing.assert_not_called()

    def test_tailscale_address_is_selected_before_lan_or_loopback(self):
        with patch('companion.local_addresses', return_value=['127.0.0.1', '192.168.1.5', '100.72.126.108']):
            self.assertEqual(ordered_addresses(), ['100.72.126.108', '192.168.1.5', '127.0.0.1'])


if __name__ == '__main__':
    unittest.main()
