"""Run the companion explicitly; never registers an unattended startup service."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import ipaddress
import json
import os
from pathlib import Path
import sys
import threading
import time

from aiohttp import web
from cryptography import x509

from .security import AuthStore, atomic_json, ensure_certificate, local_addresses, read_json, tls_context

DEFAULT_STATE = Path(__file__).resolve().parents[4] / "work" / "wasla-state"
DEFAULT_PORT = 47621


@contextlib.contextmanager
def single_server(root):
    with (root / "server.lock").open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise RuntimeError("A Wasla companion already uses this state directory.")
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


async def serve(args, store):
    from .desktop import WindowsDesktop
    from .services import LocalServices
    from .server import STATE, create_app
    address = ipaddress.ip_address(args.host)
    if address.version != 4 or address.is_unspecified or not (address.is_loopback or address.is_private or address in ipaddress.ip_network("100.64.0.0/10")):
        raise ValueError("Bind to one local LAN, Tailscale or loopback IPv4 address, never all interfaces or a public address.")
    if not 1024 <= args.port <= 65535:
        raise ValueError("Invalid port.")
    addresses = sorted(set(local_addresses()) | {args.host})
    fingerprint = ensure_certificate(store.root, addresses)
    cert = x509.load_pem_x509_certificate((store.root / "certificate.pem").read_bytes())
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    if address not in san.get_values_for_type(x509.IPAddress):
        raise ValueError("The selected IP is not in the saved certificate. Revoke devices and explicitly replace the certificate before re-pairing.")
    app = create_app(store, LocalServices(), WindowsDesktop(), args.allow_desktop)
    runner = web.AppRunner(app, access_log=None, shutdown_timeout=600)
    await runner.setup()
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    try:
        site = web.TCPSite(runner, args.host, args.port, ssl_context=tls_context(store.root))
        await site.start()
        status_path = store.root / "server-status.json"
        atomic_json(status_path, {"pid": os.getpid(), "host": args.host, "port": args.port,
            "started_at": time.time(), "desktop_enabled": args.allow_desktop})
        print(json.dumps({"ready": True, "url": f"https://{args.host}:{args.port}", "fingerprint": fingerprint,
            "desktop_enabled": args.allow_desktop}), flush=True)
        if args.stdin_control:
            def watch_stdin():
                for line in sys.stdin:
                    if line.strip() == "stop":
                        loop.call_soon_threadsafe(stopped.set)
                        return
                loop.call_soon_threadsafe(stopped.set)
            threading.Thread(target=watch_stdin, daemon=True).start()
        async def watch_stop_file():
            # File is private, includes this exact PID; stale requests cannot stop a later process.
            stop_path = store.root / "stop-request.json"
            while not stopped.is_set():
                command = read_json(stop_path, {})
                if command.get("pid") == os.getpid() and command.get("started_at") == read_json(status_path, {}).get("started_at"):
                    stopped.set()
                    return
                await asyncio.sleep(.5)
        stop_task = asyncio.create_task(watch_stop_file())
        try:
            await stopped.wait()
        finally:
            stop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stop_task
    finally:
        app[STATE].stopping = True
        app[STATE].lease = None
        await runner.cleanup()
        status_path = store.root / "server-status.json"
        if read_json(status_path, {}).get("pid") == os.getpid():
            status_path.unlink(missing_ok=True)
        print("Wasla stopped; owned image work cleaned up.", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Wasla Windows local companion")
    parser.add_argument("command", choices=["serve", "pair", "devices", "revoke", "identity"])
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--allow-desktop", action="store_true")
    parser.add_argument("--stdin-control", action="store_true")
    parser.add_argument("--device-id")
    args = parser.parse_args()
    store = AuthStore(args.state)
    if args.command == "serve":
        with single_server(store.root):
            asyncio.run(serve(args, store))
    elif args.command == "pair":
        fingerprint = ensure_certificate(store.root)
        print(json.dumps({"url": f"https://{args.host}:{args.port}", "fingerprint": fingerprint,
                          "code": store.create_pairing_code(), "expires_in": 300}, ensure_ascii=False))
    elif args.command == "devices":
        print(json.dumps(store.list_devices(), ensure_ascii=False))
    elif args.command == "revoke":
        store.revoke(args.device_id)
        print("Device access revoked.")
    elif args.command == "identity":
        print(json.dumps({"fingerprint": ensure_certificate(store.root), "addresses": local_addresses()}))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:
        print(f"Wasla could not start: {error}", file=sys.stderr)
        raise SystemExit(1)
