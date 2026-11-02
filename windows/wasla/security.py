"""Local-only enrollment, certificate identity, device revocation and private state."""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import time
import uuid
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


class AuthError(ValueError):
    pass


def atomic_json(path: Path, value):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def protect_directory(path: Path):
    """Only the current Windows identity and SYSTEM may access runtime secrets."""
    path.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        path.chmod(0o700)
        return
    import win32api
    import win32con
    import win32security
    import ntsecuritycon
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    system = win32security.CreateWellKnownSid(win32security.WinLocalSystemSid, None)
    acl = win32security.ACL()
    flags = win32con.OBJECT_INHERIT_ACE | win32con.CONTAINER_INHERIT_ACE
    for identity in (sid, system):
        acl.AddAccessAllowedAceEx(win32security.ACL_REVISION_DS, flags, ntsecuritycon.FILE_ALL_ACCESS, identity)
    win32security.SetNamedSecurityInfo(
        str(path), win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
        None, None, acl, None,
    )


@contextlib.contextmanager
def state_lock(root: Path):
    with (root / "state.lock").open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def read_json(path: Path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def local_addresses():
    addresses = {"127.0.0.1"}
    import psutil
    try:
        candidates = {info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except socket.gaierror:
        candidates = set()
    candidates.update(address.address for rows in psutil.net_if_addrs().values() for address in rows if address.family == socket.AF_INET)
    for candidate in candidates:
        ip = ipaddress.ip_address(candidate)
        if (ip.is_private or ip in ipaddress.ip_network("100.64.0.0/10")) and not ip.is_link_local and not ip.is_unspecified:
            addresses.add(str(ip))
    return sorted(addresses, key=lambda address: address == "127.0.0.1")


def ensure_certificate(root: Path, addresses=None):
    cert_file, key_file = root / "certificate.pem", root / "private-key.pem"
    if cert_file.exists() != key_file.exists():
        raise AuthError("Certificate identity is incomplete; restore its backup before starting.")
    if not cert_file.exists():
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Wasla Windows")])
        now = datetime.now(timezone.utc)
        names = [x509.DNSName("localhost"), x509.DNSName(socket.gethostname())]
        names += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in (addresses or local_addresses())]
        cert = (
            x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                          data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                          encipher_only=False, decipher_only=False), critical=True)
            .sign(key, hashes.SHA256())
        )
        key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        if os.name != "nt":
            key_file.chmod(0o600)
    cert = x509.load_pem_x509_certificate(cert_file.read_bytes())
    if datetime.now(timezone.utc) >= cert.not_valid_after_utc:
        raise AuthError("Certificate expired. Explicitly replace it and re-pair each phone.")
    return cert.fingerprint(hashes.SHA256()).hex()


def tls_context(root: Path):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(root / "certificate.pem", root / "private-key.pem")
    context.options |= ssl.OP_NO_COMPRESSION
    return context


class AuthStore:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        protect_directory(self.root)

    def create_pairing_code(self, lifetime=300):
        code = secrets.token_urlsafe(32)
        with state_lock(self.root):
            atomic_json(self.root / "pairing.json", {"sha256": hashlib.sha256(code.encode()).hexdigest(),
                "expires_at": time.time() + lifetime, "attempts": 0})
        return code

    def pair(self, code: str, device_name: str):
        if not isinstance(code, str) or len(code) > 120 or not isinstance(device_name, str) or not 1 <= len(device_name.strip()) <= 80:
            raise AuthError("Invalid pairing data.")
        with state_lock(self.root):
            enrollment = read_json(self.root / "pairing.json", {})
            if enrollment.get("expires_at", 0) <= time.time() or enrollment.get("attempts", 0) >= 5 or not enrollment.get("sha256"):
                raise AuthError("Pairing is closed or expired. Create a new code on Windows.")
            enrollment["attempts"] += 1
            atomic_json(self.root / "pairing.json", enrollment)
            if not hmac.compare_digest(enrollment["sha256"], hashlib.sha256(code.encode()).hexdigest()):
                raise AuthError("Pairing code was rejected.")
            devices = read_json(self.root / "devices.json", {})
            device_id, token = uuid.uuid4().hex, secrets.token_urlsafe(48)
            devices[device_id] = {"name": device_name.strip(), "sha256": hashlib.sha256(token.encode()).hexdigest(),
                "created_at": time.time(), "expires_at": time.time() + 30 * 86400}
            atomic_json(self.root / "devices.json", devices)
            atomic_json(self.root / "pairing.json", {})
        return {"token": token, "device_id": device_id, "name": "Wasla Windows"}

    def authenticate(self, bearer: str):
        if not isinstance(bearer, str) or not bearer.startswith("Bearer ") or len(bearer) > 200:
            raise AuthError("Pair this device first.")
        token_hash = hashlib.sha256(bearer[7:].encode()).hexdigest()
        with state_lock(self.root):
            devices = read_json(self.root / "devices.json", {})
        for device_id, device in devices.items():
            if device.get("expires_at", 0) > time.time() and hmac.compare_digest(device.get("sha256", ""), token_hash):
                return device_id
        raise AuthError("The device session expired or was revoked.")

    def revoke(self, device_id=None):
        with state_lock(self.root):
            devices = read_json(self.root / "devices.json", {})
            if device_id is None:
                devices = {}
                atomic_json(self.root / "pairing.json", {})
            else:
                devices.pop(device_id, None)
            atomic_json(self.root / "devices.json", devices)

    def list_devices(self):
        with state_lock(self.root):
            devices = read_json(self.root / "devices.json", {})
        return [{"id": key, **{k: v for k, v in value.items() if k != "sha256"}} for key, value in devices.items()]
