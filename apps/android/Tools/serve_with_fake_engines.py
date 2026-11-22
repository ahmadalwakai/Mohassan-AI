"""The real Wasla service with fake engines, for phone UI tests on a computer without them.

Everything the phone talks to is the real code from apps/wasla-service: the HTTPS
server with its pinned certificate, the 8-digit pairing, device tokens, the limits,
the knowledge store and the bridge to Mohassan (point it at a real Mohassan or at
Tools/fake_mohassan_gateway.py). Only the engines behind the API are stand-ins:

- chat (/v1/chat): answers after a moment and labels its route, sources and warnings;
- images: prepares a prompt, then "renders" a flat PNG after four seconds;
- search: two results, one of them a plain-http link the phone must refuse to open;
- desktop: a drawn 640x360 "screen" that shows the pointer and the last inputs, so the
  phone's trackpad, clicks and keys can be exercised without touching the real desktop.

    python apps/android/Tools/serve_with_fake_engines.py --service-dir <apps/wasla-service> \
        --state <private state folder> --host 192.168.1.10 --port 47621 --allow-desktop [--extra-san 10.0.2.2]

Then make a pairing code as usual:  python -m wasla pair --state <folder> --host <host> --port <port>
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
from pathlib import Path
import sys
import time
import urllib.parse

from PIL import Image, ImageDraw


class FakeServices:
    def __init__(self, root: Path):
        self.root = root
        self.busy = False
        self.images: dict[str, dict] = {}

    async def prepare_image(self, description: str, style: str = "natural") -> dict:
        return {"prompt": f"{style} photograph of {description.strip()}, soft light, high detail",
                "negative_prompt": "blurry, low quality, text, watermark", "seed": 123456789}

    async def generate_image(self, prompt: str, negative_prompt: str, seed: int, request_id: str) -> dict:
        self.busy = True
        try:
            await asyncio.sleep(4)
            image = Image.new("RGB", (512, 512), (31, 111, 92))
            draw = ImageDraw.Draw(image)
            draw.rectangle((40, 40, 472, 472), outline=(255, 255, 255), width=6)
            draw.text((60, 240), f"fake image  seed={seed}", fill=(255, 255, 255))
            draw.text((60, 260), prompt.encode("ascii", "ignore").decode()[:48], fill=(227, 239, 233))
            folder = self.root / "fake-images"
            folder.mkdir(exist_ok=True)
            path = folder / f"{request_id}.png"
            image.save(path, "PNG")
            self.images[request_id] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            return {"status": "succeeded"}
        finally:
            self.busy = False

    async def image_status(self, request_id: str) -> dict:
        info = self.images.get(request_id)
        return {"status": "succeeded", "image": info} if info else {"status": "failed", "error": "unknown request"}

    async def search(self, query: str) -> dict:
        return {"query": query, "provider": "fake-search", "results": [
            {"title": f"ويكيبيديا: {query}", "url": "https://ar.wikipedia.org/wiki/" + urllib.parse.quote(query),
             "snippet": f"مقالة تجريبية عن {query} من محرك البحث الوهمي؛ الرابط حقيقي ويُفتح في المتصفح."},
            {"title": "مصدر برابط http غير مدعوم", "url": "http://example.com/plain",
             "snippet": "هذا الرابط لا يُفتح من الهاتف لأنه ليس https؛ يجب أن يظهر «رابط غير مدعوم»."},
        ]}

    async def close(self) -> None:
        return None


class FakeIntelligence:
    async def answer(self, messages: list[dict], *, device_id: str, mode: str = "auto", use_memory: bool = False) -> dict:
        await asyncio.sleep(1.5)
        last = messages[-1]["content"]
        route = "research" if mode == "live_web" else "local"
        answer = {
            "content": f"رد تجريبي من محرك المحادثة المحلي الوهمي (المسار {mode}، الذاكرة {'نعم' if use_memory else 'لا'}) على: «{last[:200]}».",
            "model": "fake-brain", "route": route, "sources": [],
            "evidence": {"level": "limited", "note": "محرك اختبار؛ لا أدلة حقيقية خلف هذا الرد."},
            "warnings": ["search_query_simplified"] if mode == "live_web" else [], "cache_hit": False,
            "usage": {"provider": "local", "estimated_cost_usd": 0},
        }
        if mode == "live_web":
            answer["sources"] = [{"id": "s1", "title": "مصدر تجريبي", "url": "https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D8%B5%D9%81%D8%AD%D8%A9_%D8%A7%D9%84%D8%B1%D8%A6%D9%8A%D8%B3%D9%8A%D8%A9", "snippet": "مقتطف تجريبي."}]
        return answer


class FakeDesktop:
    def __init__(self) -> None:
        self.pointer = (0.5, 0.5)
        self.log: list[str] = []

    def info(self) -> dict:
        return {"width": 1280, "height": 720, "monitor": "primary"}

    def capture(self) -> bytes:
        image = Image.new("RGB", (640, 360), (30, 29, 27))
        draw = ImageDraw.Draw(image)
        for x in range(0, 640, 80):
            draw.line((x, 0, x, 330), fill=(52, 50, 45))
        for y in range(0, 330, 60):
            draw.line((0, y, 640, y), fill=(52, 50, 45))
        draw.rectangle((0, 330, 640, 360), fill=(24, 23, 21))
        draw.text((10, 338), time.strftime("%H:%M:%S") + "  fake desktop 1280x720", fill=(237, 235, 229))
        x, y = int(self.pointer[0] * 639), int(self.pointer[1] * 329)
        draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=(79, 181, 150))
        for index, entry in enumerate(self.log[-6:]):
            draw.text((10, 10 + index * 16), entry, fill=(166, 162, 152))
        out = io.BytesIO()
        image.save(out, "JPEG", quality=80)
        return out.getvalue()

    def input(self, command: dict) -> dict:
        action = command.get("action")
        if action == "move":
            self.pointer = (float(command.get("x", 0.5)), float(command.get("y", 0.5)))
        rest = {key: value for key, value in command.items() if key != "action"}
        self.log.append(f"{time.strftime('%H:%M:%S')} {action} {json.dumps(rest, ensure_ascii=True)}"[:70])
        return {"ok": True, "action": action}


async def serve(args: argparse.Namespace) -> None:
    from aiohttp import web
    from wasla.actions import ActionsController
    from wasla.security import AuthStore, ensure_certificate, local_addresses, tls_context
    from wasla.server import create_app

    store = AuthStore(Path(args.state))
    # An emulator reaches its host as 10.0.2.2: name it in the certificate when asked, before the first start.
    addresses = sorted(set(local_addresses()) | {args.host} | set(args.extra_san))
    fingerprint = ensure_certificate(store.root, addresses)
    app = create_app(store, FakeServices(store.root), FakeDesktop(), args.allow_desktop,
                     actions=ActionsController(allowed=False, state_root=store.root), intelligence=FakeIntelligence())
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port, ssl_context=tls_context(store.root))
    await site.start()
    print(json.dumps({"ready": True, "url": f"https://{args.host}:{args.port}", "fingerprint": fingerprint,
                      "desktop_enabled": args.allow_desktop, "engines": "fake"}), flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description="Real Wasla service, fake engines")
    parser.add_argument("--service-dir", required=True, help="the apps/wasla-service folder (holds the wasla package)")
    parser.add_argument("--state", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47621)
    parser.add_argument("--allow-desktop", action="store_true")
    parser.add_argument("--extra-san", action="append", default=[], help="extra IP for the certificate, e.g. 10.0.2.2 for an emulator (only used when the certificate is first made)")
    args = parser.parse_args()
    sys.path.insert(0, str(Path(args.service_dir).resolve()))
    asyncio.run(serve(args))


if __name__ == "__main__":
    main()
