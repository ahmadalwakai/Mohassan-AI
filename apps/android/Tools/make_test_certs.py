"""Certificates for the unit tests of the pinned TLS client (app/src/test/resources).

Three self-signed certificates are written, in the exact shape the Wasla service
makes (apps/wasla-service/wasla/security.py: EC P-256, SAN with DNS and IP names,
serverAuth): one valid for a year, one that expired, and one valid for different
names. Their SHA-256 fingerprints are written beside them, so the tests compare the
client's hex against a value computed by another implementation.

    python apps/android/Tools/make_test_certs.py
"""
from datetime import datetime, timedelta, timezone
import ipaddress
import json
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

OUT = Path(__file__).resolve().parents[1] / "app" / "src" / "test" / "resources"


def make(names, not_before, not_after):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Wasla Windows")])
    return (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(not_before).not_valid_after(not_after)
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    usual = [x509.DNSName("localhost"), x509.DNSName("Desk-PC"), x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
             x509.IPAddress(ipaddress.ip_address("10.0.2.2")), x509.IPAddress(ipaddress.ip_address("100.72.126.108"))]
    certificates = {
        "server-valid": make(usual, now - timedelta(minutes=5), now + timedelta(days=3650)),
        "server-expired": make(usual, now - timedelta(days=400), now - timedelta(days=35)),
        "server-other-host": make([x509.IPAddress(ipaddress.ip_address("192.168.9.9"))], now - timedelta(minutes=5), now + timedelta(days=3650)),
    }
    fingerprints = {}
    for name, cert in certificates.items():
        (OUT / f"{name}.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        fingerprints[name] = cert.fingerprint(hashes.SHA256()).hex()
    (OUT / "fingerprints.json").write_text(json.dumps(fingerprints, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(fingerprints, indent=2))


if __name__ == "__main__":
    main()
