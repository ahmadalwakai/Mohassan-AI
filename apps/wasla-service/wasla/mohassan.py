"""Bridge from the paired iPhone to Mohassan on this computer.

The phone already reaches this service over Tailscale with a pinned certificate
and its own device token. Requests under /v1/mohassan/* are checked here, then
sent to the Mohassan server on 127.0.0.1 with the gateway key that Mohassan
issued for this computer. Mohassan runs the chat with its own brain, tools,
questions and approvals; this module never decides anything itself.

- Loopback only: a Mohassan address outside this computer is refused.
- A closed list of chat calls. No sign-in values, browser screen or browser input.
- The key lives in the private state folder and never leaves this computer.
- One GPU: Mohassan work and image generation never run at the same time.
"""
from __future__ import annotations

import argparse
import asyncio
import ipaddress
import json
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

import aiohttp

from .paths import STATE_DIR
from .security import atomic_json, read_json, state_lock

CONFIG_FILE = "mohassan-gateway.json"
DEFAULT_URL = "http://127.0.0.1:4000"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
KEY = re.compile(r"[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\Z")
CODE = re.compile(r"[A-Za-z0-9_-]{16}\Z")
GATEWAY = "/api/wasla/gateway"
# A chat decision may take up to 240 s on the local model; reads stay short.
SLOW_SECONDS, READ_SECONDS = 30, 15


class BridgeError(Exception):
    def __init__(self, code, message, status=502):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def loopback_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme != "http" or parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise BridgeError("mohassan_address", "عنوان موحسن يجب أن يكون http على هذا الكمبيوتر.", 400)
    host = (parts.hostname or "").strip("[]")
    try:
        local = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = False
    if not local:
        raise BridgeError("mohassan_address", "عنوان موحسن يجب أن يكون على هذا الكمبيوتر (127.0.0.1).", 400)
    return f"http://{parts.netloc}"


def conversation_id(value: str) -> str:
    if not isinstance(value, str) or not UUID.fullmatch(value):
        raise BridgeError("not_found", "المحادثة غير موجودة.", 404)
    return value


class MohassanBridge:
    def __init__(self, root: Path, *, session_factory=None):
        self.root = Path(root)
        self._session_factory = session_factory or (lambda: aiohttp.ClientSession())
        self._session = None

    # Configuration in the private state folder.
    def config(self):
        data = read_json(self.root / CONFIG_FILE, {})
        url, key = data.get("url"), data.get("gateway_key")
        if not isinstance(url, str) or not isinstance(key, str) or not KEY.fullmatch(key):
            return None
        return {"url": loopback_url(url), "gateway_key": key}

    @property
    def configured(self) -> bool:
        return self.config() is not None

    def save(self, url: str, gateway_key: str):
        if not KEY.fullmatch(gateway_key):
            raise BridgeError("mohassan_key", "مفتاح موحسن غير صالح.", 400)
        with state_lock(self.root):
            atomic_json(self.root / CONFIG_FILE, {"url": loopback_url(url), "gateway_key": gateway_key})

    def forget(self):
        with state_lock(self.root):
            (self.root / CONFIG_FILE).unlink(missing_ok=True)

    async def close(self):
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def _request(self, method, path, *, body=None, key=None, url=None, timeout=READ_SECONDS):
        config = None if key else self.config()
        if not key and not config:
            raise BridgeError("mohassan_not_linked", "وصلة غير مربوط بموحسن على هذا الكمبيوتر.", 409)
        base = url or config["url"]
        headers = {"Accept": "application/json"}
        if key or config:
            headers["Authorization"] = "Bearer " + (key or config["gateway_key"])
        if self._session is None:
            self._session = self._session_factory()
        try:
            async with self._session.request(method, base + path, headers=headers, timeout=aiohttp.ClientTimeout(total=timeout),
                                             allow_redirects=False, **({"json": body} if body is not None else {})) as response:
                text = await response.text()
                status = response.status
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            raise BridgeError("mohassan_unavailable", "تعذر الوصول إلى موحسن على هذا الكمبيوتر. تأكد أنه يعمل.", 502) from None
        try:
            data = json.loads(text) if text else {}
        except ValueError:
            raise BridgeError("mohassan_unavailable", "رد موحسن غير مفهوم.", 502) from None
        if status >= 400:
            error = data.get("error") if isinstance(data, dict) else None
            code = error.get("code") if isinstance(error, dict) and isinstance(error.get("code"), str) else "mohassan_error"
            message = error.get("message") if isinstance(error, dict) and isinstance(error.get("message"), str) else "رفض موحسن الطلب."
            # A server fault on Mohassan is not this computer's fault, and its details stay there.
            raise BridgeError(code, message, status if 400 <= status < 500 else 502)
        return data

    async def pair(self, code: str, name: str = "Wasla", url: str = DEFAULT_URL):
        if not CODE.fullmatch(code or ""):
            raise BridgeError("mohassan_code", "رمز ربط موحسن غير صالح.", 400)
        base = loopback_url(url)
        session = self._session_factory()
        try:
            async with session.post(base + GATEWAY + "/pair", json={"code": code, "name": name[:80] or "Wasla"},
                                    timeout=aiohttp.ClientTimeout(total=READ_SECONDS), allow_redirects=False) as response:
                data = json.loads(await response.text() or "{}")
                if response.status != 200:
                    error = data.get("error", {}) if isinstance(data, dict) else {}
                    raise BridgeError(error.get("code", "mohassan_error"), error.get("message", "رفض موحسن رمز الربط."), response.status)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError):
            raise BridgeError("mohassan_unavailable", "تعذر الوصول إلى موحسن على هذا الكمبيوتر.", 502) from None
        finally:
            await session.close()
        self.save(base, data["gatewayKey"])
        return {"gateway_id": data["gatewayId"]}

    # The calls the phone may make.
    async def status(self):
        if not self.configured:
            return {"linked": False, "reachable": False}
        try:
            await self._request("GET", GATEWAY + "/status")
            return {"linked": True, "reachable": True}
        except BridgeError as error:
            return {"linked": error.code not in ("WASLA_GATEWAY_UNAUTHORIZED",), "reachable": error.code != "mohassan_unavailable", "error": error.code}

    async def running(self) -> bool:
        """True when Mohassan is working on any conversation (the GPU is in use)."""
        if not self.configured:
            return False
        try:
            data = await self._request("GET", GATEWAY + "/conversations")
        except BridgeError:
            return False
        # Mohassan wraps the list: {"conversations": [...]}.
        items = data.get("conversations") if isinstance(data, dict) else None
        return isinstance(items, list) and any(isinstance(item, dict) and item.get("status") == "running" for item in items)

    async def conversations(self):
        return await self._request("GET", GATEWAY + "/conversations")

    async def create(self, body):
        return await self._request("POST", GATEWAY + "/conversations", body=body, timeout=SLOW_SECONDS)

    async def detail(self, cid):
        return await self._request("GET", f"{GATEWAY}/conversations/{conversation_id(cid)}")

    async def remove(self, cid):
        return await self._request("DELETE", f"{GATEWAY}/conversations/{conversation_id(cid)}")

    async def events(self, cid, after):
        if not isinstance(after, int) or not 0 <= after <= 100000:
            raise BridgeError("invalid_request", "رقم الحدث غير صالح.", 400)
        return await self._request("GET", f"{GATEWAY}/conversations/{conversation_id(cid)}/campaign-events?after={after}")

    async def act(self, cid, action, body):
        if action not in ("messages", "respond", "approve", "cancel"):
            raise BridgeError("not_found", "هذا الإجراء غير متاح عبر وصلة.", 404)
        return await self._request("POST", f"{GATEWAY}/conversations/{conversation_id(cid)}/{action}", body=body, timeout=SLOW_SECONDS)


def main(argv=None):
    """Link this computer's Wasla service to the local Mohassan server.

    The owner creates a short code in the Mohassan web workspace, then runs:
        python -m wasla.mohassan pair <code> [--state <private state folder>]
    """
    # Messages are Arabic; a Windows console defaults to a code page that cannot print them.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(prog="python -m wasla.mohassan")
    sub = parser.add_subparsers(dest="command", required=True)
    pair = sub.add_parser("pair")
    pair.add_argument("code")
    pair.add_argument("--state", default=STATE_DIR, type=Path)
    pair.add_argument("--url", default=DEFAULT_URL)
    pair.add_argument("--name", default="Wasla")
    forget = sub.add_parser("forget")
    forget.add_argument("--state", default=STATE_DIR, type=Path)
    args = parser.parse_args(argv)
    bridge = MohassanBridge(args.state)
    try:
        if args.command == "forget":
            bridge.forget()
            print("أُزيل مفتاح موحسن من هذا الكمبيوتر. ألغِ الربط أيضًا من واجهة موحسن.")
            return 0
        result = asyncio.run(bridge.pair(args.code, args.name, args.url))
        print(f"رُبط وصلة بموحسن. معرّف الربط: {result['gateway_id']}")
        return 0
    except BridgeError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
