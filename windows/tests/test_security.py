import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest

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

    def test_global_pairing_attempt_limit(self):
        code = self.store.create_pairing_code()
        for _ in range(5):
            with self.assertRaises(AuthError):
                self.store.pair('wrong', 'phone')
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
