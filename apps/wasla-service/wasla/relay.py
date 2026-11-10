"""Opt-in outbound relay. No network or private-state access occurs on import.

Run explicitly with ``python -m wasla.relay`` and WASLA_RELAY_ENABLED=1.
Required environment variables: WASLA_RELAY_URL, WASLA_RELAY_TOKEN,
WASLA_RELAY_INSTALLATION_ID, WASLA_RELAY_KEY_BASE64, WASLA_RELAY_LOCAL_URL,
WASLA_RELAY_LOCAL_PIN. WASLA_RELAY_STATE optionally selects private state.

The local allowlist deliberately excludes desktop, images, arbitrary URLs and
query parameters. Only encrypted envelopes travel through the cloud queue.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import hmac
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit
import uuid

from cryptography import x509
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .security import atomic_json, protect_directory, read_json, state_lock

MAX_BYTES = 1024 * 1024
MAX_WIRE_BYTES = 1_500_000
MAX_RECEIPTS = 4096
MAX_JOURNAL_BYTES = 16 * MAX_BYTES
REQUEST_TIMEOUT = 240
MAX_REQUEST_LIFETIME = 360
from .paths import STATE_DIR as DEFAULT_STATE
_ID = re.compile(r'[A-Za-z0-9_-]{8,128}')
_TOKEN = re.compile(r'[A-Za-z0-9._~-]{32,512}')
_ENVELOPE = re.compile(r'[A-Za-z0-9_-]+')
_ROUTES = {
    '/v1/status': {'GET'}, '/v1/pair': {'POST'}, '/v1/chat': {'POST'},
    '/v1/knowledge': {'GET', 'POST'}, '/v1/conversations': {'GET'},
    '/v1/settings': {'GET', 'PATCH'}, '/v1/metrics': {'GET'}, '/v1/session': {'DELETE'},
}


class RelayError(ValueError):
    """Messages contain no tokens, plaintext bodies or exception details."""


class RelayExpiredError(RelayError):
    pass


def _check_expiry(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise RelayError('A finite encrypted request expiry is required')
    remaining = value - time.time()
    if remaining <= 0:
        raise RelayExpiredError('Encrypted relay request expired')
    if remaining > MAX_REQUEST_LIFETIME:
        raise RelayError('Encrypted relay request lifetime is too long')
    return remaining


def _uuid(value):
    try:
        return type(value) is str and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def _origin(value, *, local=False):
    if type(value) is not str or any(ord(c) < 33 or c in '\\%' for c in value):
        raise RelayError('Invalid relay origin')
    try:
        parts = urlsplit(value)
        host, port = parts.hostname, parts.port
        if (parts.scheme != 'https' or not host or parts.username is not None or parts.password is not None
                or parts.path not in ('', '/') or parts.query or parts.fragment):
            raise ValueError()
        if local:
            if host != 'localhost':
                address = ipaddress.ip_address(host)
                if address.is_unspecified or address.is_multicast or not (
                        address.is_loopback or address.is_private or address in ipaddress.ip_network('100.64.0.0/10')):
                    raise ValueError()
            if port is not None and not 1 <= port <= 65535:
                raise ValueError()
        else:
            if port not in (None, 443) or '.' not in host:
                raise ValueError()
            try:
                address = ipaddress.ip_address(host)
            except ValueError:
                if host.endswith(('.local', '.localhost', '.internal', '.lan', '.test', '.invalid')):
                    raise ValueError()
                if not re.fullmatch(r'[A-Za-z0-9.-]+', host):
                    raise ValueError()
            else:
                if not address.is_global:
                    raise ValueError()
        return value.rstrip('/')
    except ValueError:
        raise RelayError('An exact HTTPS origin is required') from None


@dataclass(frozen=True)
class RelayConfig:
    base_url: str
    relay_token: str = field(repr=False)
    installation_id: str
    key: bytes = field(repr=False)
    local_url: str
    local_pin: str
    state_root: Path = DEFAULT_STATE

    def __post_init__(self):
        object.__setattr__(self, 'base_url', _origin(self.base_url))
        object.__setattr__(self, 'local_url', _origin(self.local_url, local=True))
        if type(self.relay_token) is not str or not _TOKEN.fullmatch(self.relay_token):
            raise RelayError('A dedicated strong relay bearer token is required')
        if type(self.installation_id) is not str or not _ID.fullmatch(self.installation_id):
            raise RelayError('Invalid installation ID')
        if type(self.key) is not bytes or len(self.key) != 32:
            raise RelayError('A 32-byte AES-256 key is required')
        if type(self.local_pin) is not str or not re.fullmatch(r'[0-9a-fA-F]{64}', self.local_pin):
            raise RelayError('A SHA-256 local certificate pin is required')
        object.__setattr__(self, 'local_pin', self.local_pin.lower())
        object.__setattr__(self, 'state_root', Path(self.state_root))

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        if env.get('WASLA_RELAY_ENABLED') != '1':
            return None
        names = ['URL', 'TOKEN', 'INSTALLATION_ID', 'KEY_BASE64', 'LOCAL_URL', 'LOCAL_PIN']
        if any(not env.get('WASLA_RELAY_' + name) for name in names):
            raise RelayError('Relay is enabled but configuration is incomplete')
        try:
            encoded = env['WASLA_RELAY_KEY_BASE64']
            if not re.fullmatch(r'[A-Za-z0-9+/_-]{43}=?', encoded):
                raise ValueError()
            key = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True)
        except (ValueError, TypeError):
            raise RelayError('Relay key must be base64 for exactly 32 bytes') from None
        return cls(env['WASLA_RELAY_URL'], env['WASLA_RELAY_TOKEN'], env['WASLA_RELAY_INSTALLATION_ID'],
                   key, env['WASLA_RELAY_LOCAL_URL'], env['WASLA_RELAY_LOCAL_PIN'],
                   Path(env.get('WASLA_RELAY_STATE', DEFAULT_STATE)))


def _json_bytes(value):
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise RelayError('Invalid JSON payload') from None
    if len(encoded) > MAX_BYTES:
        raise RelayError('Payload exceeds the relay limit')
    return encoded


def _read_json(raw, maximum=MAX_BYTES):
    if type(raw) is not bytes or len(raw) > maximum:
        raise RelayError('Response exceeds the relay limit')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise RelayError('Duplicate JSON fields')
            result[key] = value
        return result
    def constant(_):
        raise RelayError('Non-finite JSON number')
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError):
        raise RelayError('Invalid JSON response') from None


def _b64encode(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def _b64decode(value, maximum):
    if type(value) is not str or len(value) > (maximum * 4 + 2) // 3 or not _ENVELOPE.fullmatch(value):
        raise RelayError('Invalid encrypted envelope')
    try:
        decoded = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
    except ValueError:
        raise RelayError('Invalid encrypted envelope') from None
    if len(decoded) > maximum or _b64encode(decoded) != value:
        raise RelayError('Invalid encrypted envelope')
    return decoded


class EnvelopeCipher:
    def __init__(self, key, installation_id):
        if type(key) is not bytes or len(key) != 32 or not _ID.fullmatch(installation_id):
            raise RelayError('Invalid envelope configuration')
        self._cipher, self.installation_id = AESGCM(key), installation_id

    def _aad(self, direction, job_id):
        if direction not in ('request', 'response') or not _uuid(job_id):
            raise RelayError('Invalid encrypted job identity')
        return f'wasla:{direction}:v1:{self.installation_id}:{job_id}'.encode('utf-8')

    def seal(self, value, direction, job_id):
        nonce = secrets.token_bytes(12)
        encrypted = self._cipher.encrypt(nonce, _json_bytes(value), self._aad(direction, job_id))
        return {'nonce': _b64encode(nonce), 'ciphertext': _b64encode(encrypted)}

    def open(self, envelope, direction, job_id):
        if type(envelope) is not dict or set(envelope) != {'nonce', 'ciphertext'}:
            raise RelayError('Invalid encrypted envelope')
        nonce = _b64decode(envelope['nonce'], 12)
        ciphertext = _b64decode(envelope['ciphertext'], MAX_BYTES + 16)
        if len(nonce) != 12 or len(ciphertext) < 16:
            raise RelayError('Invalid encrypted envelope')
        try:
            raw = self._cipher.decrypt(nonce, ciphertext, self._aad(direction, job_id))
        except Exception:
            raise RelayError('Encrypted request authentication failed') from None
        value = _read_json(raw)
        _json_bytes(value)
        return value


def validate_request(value):
    if type(value) is not dict or not {'method', 'path', 'expires_at'} <= set(value) or set(value) - {'method', 'path', 'body', 'authorization', 'expires_at'}:
        raise RelayError('Unsupported relay request fields')
    _check_expiry(value['expires_at'])
    method, path = value['method'], value['path']
    if type(method) is not str or type(path) is not str or len(path) > 128:
        raise RelayError('Invalid relay route')
    allowed = _ROUTES.get(path, set())
    match = re.fullmatch(r'/v1/(knowledge|conversations)/([^/]+)', path)
    if match and _uuid(match[2]):
        allowed = {'DELETE'} if match[1] == 'knowledge' else {'GET', 'DELETE'}
    if method not in allowed:
        raise RelayError('This local route or method is not available through the relay')
    if method in ('GET', 'DELETE') and 'body' in value:
        raise RelayError('This method does not accept a relay body')
    if method in ('POST', 'PATCH') and type(value.get('body')) is not dict:
        raise RelayError('A JSON object body is required')
    authorization = value.get('authorization')
    if authorization is not None and (type(authorization) is not str or not re.fullmatch(r'Bearer [A-Za-z0-9_-]{32,200}', authorization)):
        raise RelayError('Invalid local authorization header')
    _json_bytes(value)
    return value


def pinned_context(local_url, expected_pin, fetch_certificate=None):
    """Fetch only a certificate, pin it, then use full TLS verification for HTTP.

    Bootstrap sends no HTTP request or credentials. Every subsequent connection
    verifies certificate trust, SAN/hostname, validity dates, and the exact pin.
    """
    parts = urlsplit(_origin(local_url, local=True))
    fetch_certificate = fetch_certificate or ssl.get_server_certificate
    pem = fetch_certificate((parts.hostname, parts.port or 443), timeout=10)
    try:
        cert = x509.load_pem_x509_certificate(pem.encode('ascii'))
        actual = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest()
        now = datetime.now(timezone.utc)
        if not hmac.compare_digest(actual, expected_pin.lower()):
            raise ValueError()
        if not cert.not_valid_before_utc <= now < cert.not_valid_after_utc:
            raise ValueError()
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        try:
            address = ipaddress.ip_address(parts.hostname)
        except ValueError:
            if parts.hostname not in san.get_values_for_type(x509.DNSName):
                raise ValueError()
        else:
            if address not in san.get_values_for_type(x509.IPAddress):
                raise ValueError()
    except Exception:
        raise RelayError('Local TLS identity verification failed') from None
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_verify_locations(cadata=pem)
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


class _PinnedConnection(http.client.HTTPSConnection):
    def __init__(self, *args, expected_pin=None, **kwargs):
        self.expected_pin = expected_pin
        super().__init__(*args, **kwargs)

    def connect(self):
        super().connect()
        if self.expected_pin is not None:
            actual = hashlib.sha256(self.sock.getpeercert(binary_form=True)).hexdigest()
            if not hmac.compare_digest(actual, self.expected_pin):
                self.close()
                raise RelayError('Local TLS identity changed')


class HTTPTransport:
    """One connection per call; no redirects, proxy environment, or retries."""
    def request(self, method, url, *, headers, body=None, context=None, pin=None,
                timeout=REQUEST_TIMEOUT, max_bytes=MAX_BYTES):
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.username or parts.password or parts.query or parts.fragment:
            raise RelayError('Invalid HTTP destination')
        deadline = time.monotonic() + min(timeout, REQUEST_TIMEOUT)
        connection = _PinnedConnection(parts.hostname, parts.port or 443,
            context=context or ssl.create_default_context(), expected_pin=pin, timeout=min(10, timeout / 2))
        active_socket = None
        def expire():
            current = active_socket or connection.sock
            if current is not None:
                try:
                    current.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()
        timer = threading.Timer(min(timeout, REQUEST_TIMEOUT), expire)
        timer.daemon = True
        def remaining():
            value = deadline - time.monotonic()
            if value <= 0:
                raise TimeoutError('Relay request timed out')
            if active_socket:
                active_socket.settimeout(value)
        timer.start()
        try:
            connection.connect()
            active_socket = connection.sock
            remaining()
            connection.request(method, parts.path or '/', body=body, headers=headers)
            remaining()
            response = connection.getresponse()
            declared = response.getheader('Content-Length')
            if declared is not None and (not declared.isdigit() or int(declared) > max_bytes):
                raise RelayError('Response exceeds the relay limit')
            if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
                raise RelayError('Compressed relay responses are not supported')
            chunks, total = [], 0
            while True:
                remaining()
                chunk = response.read1(min(65536, max_bytes + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise RelayError('Response exceeds the relay limit')
                chunks.append(chunk)
            return response.status, b''.join(chunks)
        finally:
            timer.cancel()
            connection.close()


def _error(status, code, message):
    return {'status': status, 'body': {'error': {'code': code, 'message': message}}}


class RelayWorker:
    def __init__(self, config, *, transport=None, certificate_fetcher=None, worker_id=None):
        self.config, self.transport = config, transport or HTTPTransport()
        self.cipher = EnvelopeCipher(config.key, config.installation_id)
        self.worker_id = worker_id or str(uuid.uuid4())
        if not _uuid(self.worker_id):
            raise RelayError('Invalid worker ID')
        self._certificate_fetcher = certificate_fetcher
        self._pending_upload = None
        self._pending_upload_expires = 0
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        # A separate lock directory avoids holding AuthStore's state.lock while
        # an HTTP request to the local server needs that same authentication lock.
        self.journal_root = config.state_root / 'relay'
        protect_directory(self.journal_root)

    def _cloud(self, path, payload):
        body = json.dumps(payload, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if len(body) > MAX_WIRE_BYTES:
            raise RelayError('Encrypted relay payload is too large')
        return self.transport.request('POST', self.config.base_url + path,
            headers={'Authorization': 'Bearer ' + self.config.relay_token, 'Content-Type': 'application/json',
                     'Accept-Encoding': 'identity'}, body=body, timeout=30, max_bytes=MAX_WIRE_BYTES)

    def _forward(self, request):
        if self._stop_event.is_set():
            raise RelayError('Relay is stopping')
        _check_expiry(request['expires_at'])
        context = pinned_context(self.config.local_url, self.config.local_pin, self._certificate_fetcher)
        headers = {'Accept-Encoding': 'identity', 'Accept': 'application/json'}
        if request.get('authorization'):
            headers['Authorization'] = request['authorization']
        body = None
        if 'body' in request:
            body = _json_bytes(request['body'])
            headers['Content-Type'] = 'application/json'
        remaining = _check_expiry(request['expires_at'])
        if self._stop_event.is_set():
            raise RelayError('Relay is stopping')
        status, raw = self.transport.request(request['method'], self.config.local_url + request['path'],
            headers=headers, body=body, context=context, pin=self.config.local_pin,
            timeout=min(REQUEST_TIMEOUT, remaining), max_bytes=MAX_BYTES - 1024)
        if not 200 <= status <= 599 or 300 <= status < 400:
            raise RelayError('Local redirects or invalid statuses are not allowed')
        parsed = _read_json(raw) if raw else None
        if type(parsed) is not dict:
            return _error(502, 'local_invalid_response', 'لم يُرجع الكمبيوتر استجابة JSON صالحة.')
        response = {'status': status, 'body': parsed}
        _json_bytes(response)
        return response

    def _pruned_journal(self, journal_path):
        try:
            if journal_path.exists() and journal_path.stat().st_size > MAX_JOURNAL_BYTES:
                raise RelayError('Relay receipt journal is too large')
            journal = read_json(journal_path, {})
        except (ValueError, OSError):
            raise RelayError('Cannot read the relay receipt journal') from None
        if type(journal) is not dict:
            raise RelayError('Invalid relay receipt journal')
        if any(type(value) is not dict or type(value.get('expires_at')) not in (int, float)
               or not math.isfinite(value['expires_at']) for value in journal.values()):
            raise RelayError('Invalid relay receipt expiry')
        now = time.time()
        current = {key: value for key, value in journal.items() if value['expires_at'] > now}
        if len(current) != len(journal):
            atomic_json(journal_path, current)
        return current

    def prune_receipts(self):
        with self._lock, state_lock(self.journal_root):
            self._pruned_journal(self.journal_root / 'receipts.json')

    def handle_job(self, job):
        if (type(job) is not dict or set(job) != {'id', 'lease_token', 'request'} or not _uuid(job.get('id'))
                or type(job.get('lease_token')) is not str or not re.fullmatch(r'[A-Za-z0-9._~-]{16,512}', job['lease_token'])):
            raise RelayError('Invalid leased relay job')
        job_id = job['id']
        # Authenticate before persisting an intent or forwarding any request.
        request = self.cipher.open(job['request'], 'request', job_id)
        self.prune_receipts()
        try:
            request = validate_request(request)
        except RelayExpiredError:
            return self.cipher.seal(_error(410, 'relay_request_expired', 'انتهت صلاحية الطلب؛ لم يُنفّذ.'), 'response', job_id)
        except RelayError:
            return self.cipher.seal(_error(400, 'relay_route_denied', 'هذا الطلب غير متاح عبر الاتصال السحابي.'), 'response', job_id)
        digest = hashlib.sha256(json.dumps(job['request'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        identity = hashlib.sha256((self.config.installation_id + ':' + job_id).encode()).hexdigest()
        journal_path = self.journal_root / 'receipts.json'
        with self._lock, state_lock(self.journal_root):
            journal = self._pruned_journal(journal_path)
            # A request can expire while waiting for another relay worker.
            try:
                _check_expiry(request['expires_at'])
            except RelayExpiredError:
                return self.cipher.seal(_error(410, 'relay_request_expired', 'انتهت صلاحية الطلب؛ لم يُنفّذ.'), 'response', job_id)
            if identity in journal:
                previous = journal[identity]
                if type(previous) is not dict or previous.get('digest') != digest:
                    raise RelayError('Relay job identity was reused with a different request')
                if previous.get('state') == 'completed':
                    # Authenticate stored encrypted data too; corruption fails closed.
                    self.cipher.open(previous['response'], 'response', job_id)
                    return previous['response']
                if previous.get('state') != 'pending':
                    raise RelayError('Invalid relay receipt state')
                result = _error(502, 'local_outcome_unknown', 'نتيجة الطلب السابق غير مؤكدة؛ لم يُعَد تنفيذه.')
            else:
                if len(journal) >= MAX_RECEIPTS or (journal_path.exists() and journal_path.stat().st_size > MAX_JOURNAL_BYTES - MAX_WIRE_BYTES):
                    raise RelayError('Relay receipt journal is full')
                journal[identity] = {'digest': digest, 'state': 'pending', 'expires_at': request['expires_at']}
                atomic_json(journal_path, journal)
                try:
                    result = self._forward(request)
                except Exception:
                    result = _error(502, 'local_outcome_unknown', 'تعذر تأكيد نتيجة الطلب المحلي؛ لم يُعَد تنفيذه.')
            envelope = self.cipher.seal(result, 'response', job_id)
            # Completion must not extend retention beyond the authenticated
            # expiry. Expired original envelopes cannot execute after pruning.
            journal = {key: value for key, value in journal.items() if value['expires_at'] > time.time()}
            if request['expires_at'] > time.time():
                journal[identity] = {'digest': digest, 'state': 'completed', 'response': envelope,
                                     'expires_at': request['expires_at']}
            atomic_json(journal_path, journal)
            return envelope

    def run_once(self):
        if self._stop_event.is_set():
            return False
        self.prune_receipts()
        if self._pending_upload is not None and self._pending_upload_expires <= time.time():
            self._pending_upload = None
        if self._pending_upload is None:
            status, raw = self._cloud('/api/relay/poll', {'installation_id': self.config.installation_id, 'worker_id': self.worker_id})
            if status != 200:
                raise RelayError('Relay poll failed')
            value = _read_json(raw, MAX_WIRE_BYTES)
            if type(value) is not dict or set(value) != {'job'}:
                raise RelayError('Invalid relay poll response')
            if value['job'] is None:
                return False
            if self._stop_event.is_set():
                return False
            job = value['job']
            response = self.handle_job(job)
            decrypted = self.cipher.open(job['request'], 'request', job['id'])
            expires = decrypted.get('expires_at') if type(decrypted) is dict else None
            self._pending_upload_expires = expires if type(expires) in (int, float) and math.isfinite(expires) else time.time() + 30
            self._pending_upload = {'installation_id': self.config.installation_id, 'job_id': job['id'],
                                    'lease_token': job['lease_token'], 'response': response}
        if self._stop_event.is_set():
            return False
        status, _ = self._cloud('/api/relay/result', self._pending_upload)
        if status in (404, 409, 410):
            # Lease expired: keep the durable receipt, obtain a fresh lease on a
            # later poll, and send the cached result without local execution.
            self._pending_upload = None
            raise RelayError('Relay result lease is no longer current')
        if not 200 <= status < 300:
            raise RelayError('Relay result upload failed')
        self._pending_upload = None
        return True

    def run_forever(self, stop_event=None):
        stop_event = stop_event or threading.Event()
        self._stop_event = stop_event
        delay = 1
        while not stop_event.is_set():
            try:
                worked = self.run_once()
                delay = 1
                if not worked:
                    stop_event.wait(1)
            except (RelayError, OSError, http.client.HTTPException):
                # Never print response bodies, request URLs, tokens or keys.
                print('Relay temporarily unavailable; pending local requests are not repeated.', flush=True)
                stop_event.wait(delay)
                delay = min(30, delay * 2)


def main(env=None):
    config = RelayConfig.from_env(env)
    if config is None:
        print('Wasla relay is disabled. No connection was opened.')
        return
    RelayWorker(config).run_forever()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
    except RelayError:
        print('Wasla relay could not start. Check its private configuration.')
        raise SystemExit(1)
