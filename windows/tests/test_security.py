import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from wasla.security import AuthError, AuthStore, atomic_json, ensure_certificate, read_json, tls_context


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AuthStore(Path(self.temp.name) / 'state')

    def tearDown(self):
        self.temp.cleanup()

    def test_pairing_single_use_hashed_and_revocable(self):
        code = self.store.create_pairing_code()
        self.assertNotIn(code, (self.store.root / 'pairing.json').read_text())
        result = self.store.pair(code, 'iPhone')
        self.assertNotIn(result['token'], (self.store.root / 'devices.json').read_text())
        self.assertEqual(self.store.authenticate('Bearer ' + result['token']), result['device_id'])
        with self.assertRaises(AuthError):
            self.store.pair(code, 'other')
        self.store.revoke(result['device_id'])
        with self.assertRaises(AuthError):
            self.store.authenticate('Bearer ' + result['token'])

    def test_short_code_preserves_leading_zeroes_and_full_numeric_range(self):
        for random_value, expected in [(0, '00000000'), (123456, '00123456'), (99_999_999, '99999999')]:
            with self.subTest(random_value=random_value), patch('wasla.security.secrets.randbelow', return_value=random_value) as random:
                code = self.store.create_pairing_code()
                self.assertEqual(code, expected)
                self.assertRegex(code, r'^[0-9]{8}$')
                random.assert_called_once_with(100_000_000)
                self.assertEqual(len(self.store.pair(code, 'phone')['token']), 64)

    def test_code_lifetime_is_five_minutes_with_exact_expiry_boundary(self):
        with patch('wasla.security.time.time', return_value=1000):
            code = self.store.create_pairing_code()
        enrollment = read_json(self.store.root / 'pairing.json', {})
        self.assertEqual(enrollment['expires_at'], 1300)
        self.assertEqual(enrollment['sha256'], hashlib.sha256(code.encode()).hexdigest())
        with patch('wasla.security.time.time', return_value=1300), self.assertRaises(AuthError):
            self.store.pair(code, 'phone')
        self.assertEqual(self.store.list_devices(), [])

    def test_global_pairing_attempt_limit(self):
        code = self.store.create_pairing_code()
        for attempt in range(5):
            with self.assertRaises(AuthError):
                # Separate store instances and device names share one budget.
                AuthStore(self.store.root).pair('wrong', f'phone {attempt}')
        with self.assertRaises(AuthError):
            self.store.pair(code, 'phone')
        self.assertEqual(read_json(self.store.root / 'pairing.json', {})['attempts'], 5)
        self.assertEqual(self.store.list_devices(), [])

    def test_correct_fifth_attempt_succeeds_but_code_cannot_replay(self):
        code = self.store.create_pairing_code()
        for _ in range(4):
            with self.assertRaises(AuthError):
                self.store.pair('incorrect', 'phone')
        result = self.store.pair(code, 'phone')
        self.assertEqual(self.store.authenticate('Bearer ' + result['token']), result['device_id'])
        with self.assertRaises(AuthError):
            AuthStore(self.store.root).pair(code, 'another phone')

    def test_new_code_invalidates_previous_code(self):
        with patch('wasla.security.secrets.randbelow', side_effect=[12, 34]):
            previous = self.store.create_pairing_code()
            current = self.store.create_pairing_code()
        with self.assertRaises(AuthError):
            self.store.pair(previous, 'phone')
        self.assertTrue(self.store.pair(current, 'phone')['device_id'])

    def test_simultaneous_valid_pairing_only_creates_one_device(self):
        code = self.store.create_pairing_code()
        stores = [AuthStore(self.store.root), AuthStore(self.store.root)]
        def pair(store):
            try:
                return store.pair(code, 'phone')
            except AuthError:
                return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(pair, stores))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(len(self.store.list_devices()), 1)
        self.assertEqual(read_json(self.store.root / 'pairing.json', {}), {})

    def test_parallel_failures_do_not_exceed_global_attempt_budget(self):
        code = self.store.create_pairing_code()
        stores = [AuthStore(self.store.root) for _ in range(6)]
        def reject(store):
            with self.assertRaises(AuthError):
                store.pair('incorrect', 'phone')
        with ThreadPoolExecutor(max_workers=3) as executor:
            list(executor.map(reject, stores))
        self.assertEqual(read_json(self.store.root / 'pairing.json', {})['attempts'], 5)
        with self.assertRaises(AuthError):
            self.store.pair(code, 'phone')

    def test_expired_pairing_and_sessions(self):
        with self.assertRaises(AuthError):
            self.store.pair(self.store.create_pairing_code(-1), 'phone')
        result = self.store.pair(self.store.create_pairing_code(), 'phone')
        devices = read_json(self.store.root / 'devices.json', {})
        devices[result['device_id']]['expires_at'] = time.time() - 1
        atomic_json(self.store.root / 'devices.json', devices)
        with self.assertRaises(AuthError):
            self.store.authenticate('Bearer ' + result['token'])

    def test_certificate_identity_is_stable_and_valid(self):
        fingerprint = ensure_certificate(self.store.root, ['127.0.0.1'])
        self.assertEqual(len(fingerprint), 64)
        self.assertEqual(fingerprint, ensure_certificate(self.store.root))
        self.assertIsNotNone(tls_context(self.store.root))

    def test_revoke_all_also_closes_pairing(self):
        result = self.store.pair(self.store.create_pairing_code(), 'phone')
        code = self.store.create_pairing_code()
        self.store.revoke()
        self.assertEqual(self.store.list_devices(), [])
        with self.assertRaises(AuthError):
            self.store.pair(code, 'phone')


if __name__ == '__main__':
    unittest.main()
