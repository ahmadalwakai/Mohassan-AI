"""Real AES-GCM and certificate validation; all transports are mocked."""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import ssl
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import uuid

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from wasla.relay import (EnvelopeCipher, HTTPTransport, MAX_BYTES, RelayConfig, RelayError,
                         RelayWorker, _PinnedConnection, main, pinned_context, validate_request)
from wasla.security import atomic_json, read_json, state_lock


def certificate(host='127.0.0.1', starts=-1, ends=2):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Wasla test')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now + timedelta(days=starts))
            .not_valid_after(now + timedelta(days=ends))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(host))]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM).decode(), cert.fingerprint(hashes.SHA256()).hex()


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pem, cls.pin = certificate()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = RelayConfig('https://relay.example.com', 'r' * 48, 'installation-test', b'k' * 32,
                                  'https://127.0.0.1:47621', self.pin, self.root)
        self.transport = Mock()
        self.transport.request.return_value = (200, b'{"ok":true}')
        self.fetcher = Mock(return_value=self.pem)
        self.worker = self.new_worker()
        self.job_id = str(uuid.uuid4())

    def tearDown(self):
        self.temp.cleanup()

    def new_worker(self):
        return RelayWorker(self.config, transport=self.transport, certificate_fetcher=self.fetcher)

    def job(self, request=None, job_id=None):
        identity = job_id or self.job_id
        value = request if request is not None else {'method': 'POST', 'path': '/v1/chat', 'body': {'messages': []}, 'authorization': 'Bearer ' + 's' * 64}
        value = {'expires_at': time.time() + 300, **value}
        return {'id': identity, 'lease_token': 'l' * 32, 'request': self.worker.cipher.seal(value, 'request', identity)}

    def response(self, envelope, job_id=None):
        return self.worker.cipher.open(envelope, 'response', job_id or self.job_id)

    def test_disabled_configuration_does_not_construct_worker(self):
        self.assertIsNone(RelayConfig.from_env({}))
        with patch('wasla.relay.RelayWorker') as worker, patch('builtins.print'):
            main({})
        worker.assert_not_called()

    def test_configuration_requires_all_fields_and_32_byte_key(self):
        with self.assertRaises(RelayError):
            RelayConfig.from_env({'WASLA_RELAY_ENABLED': '1'})
        env = {'WASLA_RELAY_ENABLED': '1', 'WASLA_RELAY_URL': self.config.base_url,
               'WASLA_RELAY_TOKEN': self.config.relay_token, 'WASLA_RELAY_INSTALLATION_ID': self.config.installation_id,
               'WASLA_RELAY_KEY_BASE64': base64.b64encode(self.config.key).decode(),
               'WASLA_RELAY_LOCAL_URL': self.config.local_url, 'WASLA_RELAY_LOCAL_PIN': self.pin}
        self.assertEqual(RelayConfig.from_env(env).key, self.config.key)
        env['WASLA_RELAY_KEY_BASE64'] = base64.b64encode(b'k' * 16).decode()
        with self.assertRaises(RelayError):
            RelayConfig.from_env(env)
        self.assertNotIn(self.config.relay_token, repr(self.config))

    def test_configuration_rejects_arbitrary_paths_credentials_queries_and_non_https(self):
        for url in ['http://relay.example.com', 'https://x:y@relay.example.com', 'https://relay.example.com/api',
                    'https://relay.example.com?x=y', 'https://127.0.0.1', 'https://relay.example.com#hash']:
            with self.subTest(url=url), self.assertRaises(RelayError):
                RelayConfig(url, self.config.relay_token, self.config.installation_id, self.config.key,
                            self.config.local_url, self.pin, self.root)

    def test_crypto_roundtrip_uses_unpadded_base64url_and_fresh_nonce(self):
        one = self.worker.cipher.seal({'message': 'مرحبا'}, 'request', self.job_id)
        two = self.worker.cipher.seal({'message': 'مرحبا'}, 'request', self.job_id)
        self.assertNotEqual(one['nonce'], two['nonce'])
        self.assertRegex(one['nonce'], r'^[A-Za-z0-9_-]{16}$')
        self.assertNotIn('=', one['ciphertext'])
        self.assertEqual(self.worker.cipher.open(one, 'request', self.job_id), {'message': 'مرحبا'})

    def test_crypto_authenticates_direction_installation_and_job_id(self):
        envelope = self.worker.cipher.seal({'x': 1}, 'request', self.job_id)
        for cipher, direction, identity in [
            (self.worker.cipher, 'response', self.job_id),
            (EnvelopeCipher(self.config.key, 'other-installation'), 'request', self.job_id),
            (self.worker.cipher, 'request', str(uuid.uuid4())),
        ]:
            with self.assertRaises(RelayError):
                cipher.open(envelope, direction, identity)

    def test_crypto_rejects_tampering_padding_extra_fields_and_oversized_data(self):
        envelope = self.worker.cipher.seal({'x': 1}, 'request', self.job_id)
        altered = dict(envelope, ciphertext=('A' if envelope['ciphertext'][0] != 'A' else 'B') + envelope['ciphertext'][1:])
        for invalid in [altered, dict(envelope, nonce=envelope['nonce'] + '='), dict(envelope, extra=True),
                        dict(envelope, nonce='AA')]:
            with self.assertRaises(RelayError):
                self.worker.cipher.open(invalid, 'request', self.job_id)
        with self.assertRaises(RelayError):
            self.worker.cipher.seal({'x': 'x' * MAX_BYTES}, 'request', self.job_id)

    def test_near_limit_plaintext_is_accepted_despite_base64_expansion(self):
        job = self.job({'method': 'POST', 'path': '/v1/knowledge', 'body': {'text': 'x' * 900_000}})
        self.assertGreater(len(job['request']['ciphertext']), MAX_BYTES)
        self.assertEqual(self.response(self.worker.handle_job(job))['status'], 200)
        self.transport.request.assert_called_once()

    def test_exact_route_matrix(self):
        routes = [('/v1/status', 'GET'), ('/v1/pair', 'POST'), ('/v1/chat', 'POST'),
                  ('/v1/knowledge', 'GET'), ('/v1/knowledge', 'POST'), ('/v1/conversations', 'GET'),
                  ('/v1/settings', 'GET'), ('/v1/settings', 'PATCH'), ('/v1/metrics', 'GET'),
                  ('/v1/session', 'DELETE'), ('/v1/knowledge/' + self.job_id, 'DELETE'),
                  ('/v1/conversations/' + self.job_id, 'GET'), ('/v1/conversations/' + self.job_id, 'DELETE')]
        for path, method in routes:
            value = {'path': path, 'method': method, 'expires_at': time.time() + 300}
            if method in ('POST', 'PATCH'):
                value['body'] = {}
            with self.subTest(path=path, method=method):
                self.assertEqual(validate_request(value), value)

    def test_desktop_unlisted_methods_noncanonical_ids_and_query_paths_are_denied(self):
        for path, method in [('/v1/desktop/input', 'POST'), ('/v1/search', 'POST'), ('/v1/images', 'POST'),
                             ('/v1/conversations', 'POST'), ('/v1/knowledge/' + self.job_id, 'GET'),
                             ('/v1/conversations/' + self.job_id, 'PATCH'), ('/v1/knowledge/not-uuid', 'DELETE'),
                             ('/v1/conversations/' + self.job_id.upper(), 'GET'), ('/v1/status?x=1', 'GET'),
                             ('https://evil.example/v1/status', 'GET'), ('/v1/%73tatus', 'GET'),
                             ('/v1/../status', 'GET'), ('/v1/status/', 'GET')]:
            with self.subTest(path=path, method=method), self.assertRaises(RelayError):
                validate_request({'method': method, 'path': path, 'expires_at': time.time() + 300, **({'body': {}} if method in ('POST', 'PATCH') else {})})

    def test_header_injection_and_extra_host_are_denied(self):
        for change in [{'authorization': 'Bearer abc\r\nX-Host: evil'}, {'host': 'evil.example'}, {'body': {}}]:
            with self.assertRaises(RelayError):
                validate_request({'method': 'GET', 'path': '/v1/status', 'expires_at': time.time() + 300, **change})

    def test_expiry_is_required_bounded_and_cannot_be_a_bool(self):
        value = {'method': 'GET', 'path': '/v1/status'}
        with self.assertRaises(RelayError):
            validate_request(value)
        for expiry in [True, None, '123', time.time() - 1, time.time() + 361, float('nan')]:
            with self.subTest(expiry=expiry), self.assertRaises(RelayError):
                validate_request({**value, 'expires_at': expiry})

    def test_expired_job_is_rejected_and_pruned_receipt_cannot_reexecute(self):
        now = time.time()
        job = self.job({'method': 'GET', 'path': '/v1/status', 'expires_at': now + 10})
        self.worker.handle_job(job)
        self.transport.request.assert_called_once()
        with patch('wasla.relay.time.time', return_value=now + 11):
            result = self.response(self.worker.handle_job(job))
        self.assertEqual(result['status'], 410)
        self.assertEqual(read_json(self.worker.journal_root / 'receipts.json', {}), {})
        self.transport.request.assert_called_once()

    def test_idle_poll_prunes_expired_encrypted_responses(self):
        now = time.time()
        self.worker.handle_job(self.job({'method': 'GET', 'path': '/v1/status', 'expires_at': now + 10}))
        self.transport.request.return_value = (200, b'{"job":null}')
        with patch('wasla.relay.time.time', return_value=now + 11):
            self.assertFalse(self.worker.run_once())
        self.assertEqual(read_json(self.worker.journal_root / 'receipts.json', {}), {})

    def test_request_expiring_during_certificate_fetch_is_never_forwarded(self):
        now = time.time()
        job = self.job({'method': 'POST', 'path': '/v1/pair', 'body': {}, 'expires_at': now + 10})
        with patch('wasla.relay.time.time', return_value=now) as clock:
            def expire_during_fetch(*args, **kwargs):
                clock.return_value = now + 11
                return self.pem
            self.fetcher.side_effect = expire_during_fetch
            self.assertEqual(self.response(self.worker.handle_job(job))['status'], 502)
        self.transport.request.assert_not_called()
        self.assertEqual(read_json(self.worker.journal_root / 'receipts.json', {}), {})

    def test_empty_or_null_local_body_returns_error_object(self):
        for raw in [b'', b'null']:
            self.transport.request.return_value = (204, raw)
            job = self.job(job_id=str(uuid.uuid4()))
            result = self.response(self.worker.handle_job(job), job['id'])
            self.assertEqual(result['status'], 502)
            self.assertIsInstance(result['body'], dict)

    def test_local_tls_context_checks_san_date_trust_and_hostname(self):
        context = pinned_context(self.config.local_url, self.pin, self.fetcher)
        self.assertIs(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.fetcher.assert_called_once_with(('127.0.0.1', 47621), timeout=10)

    def test_wrong_pin_expired_future_or_wrong_san_certificate_is_rejected(self):
        examples = [(self.pem, '0' * 64), certificate(ends=-0.1), certificate(starts=1), certificate(host='127.0.0.2')]
        for pem, pin in examples:
            with self.subTest(pin=pin), self.assertRaises(RelayError):
                pinned_context(self.config.local_url, pin, Mock(return_value=pem))

    def test_connection_pin_is_checked_before_http_data_can_be_sent(self):
        connection = _PinnedConnection('localhost', expected_pin='0' * 64, context=ssl.create_default_context())
        connection.sock = Mock()
        connection.sock.getpeercert.return_value = b'another certificate'
        with patch('http.client.HTTPSConnection.connect'), patch.object(connection, 'close') as close, self.assertRaises(RelayError):
            connection.connect()
        close.assert_called_once()

    def test_local_request_uses_only_inner_authorization_and_verified_context(self):
        job = self.job()
        result = self.response(self.worker.handle_job(job))
        self.assertEqual(result, {'status': 200, 'body': {'ok': True}})
        call = self.transport.request.call_args
        self.assertEqual(call.args, ('POST', self.config.local_url + '/v1/chat'))
        self.assertEqual(call.kwargs['headers']['Authorization'], 'Bearer ' + 's' * 64)
        self.assertIs(call.kwargs['context'].verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(call.kwargs['pin'], self.pin)
        self.assertEqual(call.kwargs['timeout'], 240)
        self.assertNotIn(self.config.relay_token, str(call))

    def test_local_unauthorized_response_is_preserved(self):
        self.transport.request.return_value = (401, b'{"error":{"code":"unauthorized"}}')
        result = self.response(self.worker.handle_job(self.job({'method': 'GET', 'path': '/v1/status'})))
        self.assertEqual(result['status'], 401)

    def test_disallowed_or_unauthenticated_envelope_never_reaches_local_server(self):
        result = self.response(self.worker.handle_job(self.job({'method': 'POST', 'path': '/v1/desktop/input', 'body': {}})))
        self.assertEqual(result['status'], 400)
        job = self.job()
        job['request']['nonce'] = 'A' * 16
        with self.assertRaises(RelayError):
            self.worker.handle_job(job)
        self.transport.request.assert_not_called()

    def test_unknown_network_outcome_returns_502_and_is_never_retried_after_restart(self):
        self.transport.request.side_effect = TimeoutError()
        job = self.job()
        first = self.worker.handle_job(job)
        second = self.new_worker().handle_job(job)
        self.assertEqual(first, second)
        self.assertEqual(self.response(first)['status'], 502)
        self.transport.request.assert_called_once()

    def test_pending_journal_after_crash_does_not_forward_again(self):
        job = self.job()
        self.worker.handle_job(job)
        path = self.worker.journal_root / 'receipts.json'
        journal = read_json(path, {})
        entry = next(iter(journal.values()))
        entry['state'] = 'pending'
        entry.pop('response')
        atomic_json(path, journal)
        response = self.response(self.new_worker().handle_job(job))
        self.assertEqual(response['status'], 502)
        self.transport.request.assert_called_once()

    def test_reusing_job_id_with_new_envelope_is_denied(self):
        self.worker.handle_job(self.job())
        with self.assertRaises(RelayError):
            self.worker.handle_job(self.job())
        self.transport.request.assert_called_once()

    def test_journal_contains_no_authorization_or_plaintext_and_uses_separate_lock(self):
        def forward(*args, **kwargs):
            with state_lock(self.config.state_root):
                return (200, b'{"secret":"response-secret"}')
        self.transport.request.side_effect = forward
        self.worker.handle_job(self.job())
        stored = (self.worker.journal_root / 'receipts.json').read_text()
        for secret in ['response-secret', 'Bearer', 's' * 64, 'messages', self.config.relay_token]:
            self.assertNotIn(secret, stored)
        self.assertNotEqual(self.worker.journal_root, self.config.state_root)

    def test_redirect_or_oversized_local_response_is_not_followed(self):
        for status, body in [(302, b'{}'), (200, b'x' * (MAX_BYTES + 1))]:
            self.transport.request.reset_mock()
            self.transport.request.return_value = status, body
            job = self.job(job_id=str(uuid.uuid4()))
            result = self.response(self.worker.handle_job(job), job['id'])
            self.assertEqual(result['status'], 502)
            self.transport.request.assert_called_once()

    def test_poll_and_result_shapes_and_cloud_bearer(self):
        job = self.job()
        self.transport.request.side_effect = [(200, json.dumps({'job': job}).encode()), (200, b'{"ok":true}'), (200, b'{}')]
        self.assertTrue(self.worker.run_once())
        poll, local, upload = self.transport.request.call_args_list
        self.assertEqual(poll.args[1], self.config.base_url + '/api/relay/poll')
        self.assertEqual(poll.kwargs['headers']['Authorization'], 'Bearer ' + self.config.relay_token)
        self.assertEqual(json.loads(poll.kwargs['body']), {'installation_id': self.config.installation_id, 'worker_id': self.worker.worker_id})
        payload = json.loads(upload.kwargs['body'])
        self.assertEqual(set(payload), {'installation_id', 'job_id', 'lease_token', 'response'})
        self.assertEqual(payload['job_id'], self.job_id)
        self.assertEqual(self.response(payload['response'])['status'], 200)

    def test_result_upload_retry_does_not_poll_or_repeat_local_request(self):
        job = self.job()
        self.transport.request.side_effect = [(200, json.dumps({'job': job}).encode()), (200, b'{}'), TimeoutError(), (200, b'{}')]
        with self.assertRaises(TimeoutError):
            self.worker.run_once()
        self.assertTrue(self.worker.run_once())
        calls = self.transport.request.call_args_list
        self.assertEqual(calls[2].kwargs['body'], calls[3].kwargs['body'])
        self.assertEqual(sum(self.config.local_url in call.args[1] for call in calls), 1)

    def test_expired_lease_redelivery_uploads_cached_result_without_local_retry(self):
        job = self.job()
        fresh = dict(job, lease_token='n' * 32)
        self.transport.request.side_effect = [(200, json.dumps({'job': job}).encode()), (200, b'{}'), (409, b'{}'),
                                              (200, json.dumps({'job': fresh}).encode()), (200, b'{}')]
        with self.assertRaises(RelayError):
            self.worker.run_once()
        self.assertTrue(self.worker.run_once())
        calls = self.transport.request.call_args_list
        first, second = json.loads(calls[2].kwargs['body']), json.loads(calls[4].kwargs['body'])
        self.assertEqual(first['response'], second['response'])
        self.assertNotEqual(first['lease_token'], second['lease_token'])
        self.assertEqual(sum(self.config.local_url in call.args[1] for call in calls), 1)

    def test_intent_save_failure_never_forwards_local_request(self):
        with patch('wasla.relay.atomic_json', side_effect=OSError('disk unavailable')), self.assertRaises(OSError):
            self.worker.handle_job(self.job())
        self.transport.request.assert_not_called()

    def test_empty_poll_does_not_call_local_server(self):
        self.transport.request.return_value = (200, b'{"job":null}')
        self.assertFalse(self.worker.run_once())
        self.transport.request.assert_called_once()

    def test_poll_failure_backs_off_without_any_local_forwarding(self):
        self.transport.request.side_effect = OSError()
        stop = Mock()
        stop.is_set.side_effect = [False, False, False, True]
        with patch('builtins.print'):
            self.worker.run_forever(stop)
        self.assertEqual([call.args[0] for call in stop.wait.call_args_list], [1, 2, 4])
        self.fetcher.assert_not_called()

    def test_http_transport_never_retries_or_follows_redirects(self):
        connection = Mock()
        connection.getresponse.return_value.status = 302
        connection.getresponse.return_value.getheader.side_effect = lambda name, default=None: default
        connection.getresponse.return_value.read1.side_effect = [b'{}', b'']
        with patch('wasla.relay._PinnedConnection', return_value=connection), patch('wasla.relay.threading.Timer'):
            result = HTTPTransport().request('POST', 'https://relay.example.com/api/relay/poll', headers={}, body=b'{}')
        self.assertEqual(result, (302, b'{}'))
        connection.connect.assert_called_once()
        connection.request.assert_called_once()
        connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
