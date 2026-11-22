"""The phone reaches Mohassan only through the paired device, the closed call list and loopback."""
import json
import unittest
import uuid

from aiohttp import web
from aiohttp.test_utils import TestServer
from wasla.mohassan import BridgeError, MohassanBridge, loopback_url
from wasla.server import STATE
import test_server

KEY_SECRET = "K" * 43


class FakeMohassan:
    """Stands in for the Mohassan gateway routes; records every call it receives."""
    def __init__(self):
        self.calls, self.gateway_id, self.statuses = [], str(uuid.uuid4()), {}
        self.fail = None
        app = web.Application()
        app.router.add_post('/api/wasla/gateway/pair', self.pair)
        app.router.add_route('*', '/api/wasla/gateway/{tail:.*}', self.gateway)
        self.server = TestServer(app)

    @property
    def key(self):
        return f"{self.gateway_id}.{KEY_SECRET}"

    async def pair(self, request):
        data = await request.json()
        if data.get("code") != "A" * 16:
            return web.json_response({"error": {"code": "WASLA_PAIRING_INVALID", "message": "رمز غير صالح"}}, status=401)
        return web.json_response({"gatewayId": self.gateway_id, "gatewayKey": self.key})

    async def gateway(self, request):
        if request.headers.get("Authorization") != "Bearer " + self.key:
            return web.json_response({"error": {"code": "WASLA_GATEWAY_UNAUTHORIZED", "message": "مفتاح غير صالح"}}, status=401)
        body = await request.json() if request.can_read_body else None
        self.calls.append((request.method, request.path_qs, body, dict(request.headers)))
        if self.fail:
            return web.json_response({"error": {"code": self.fail[0], "message": self.fail[1]}}, status=self.fail[2])
        tail = request.match_info["tail"]
        if tail == "status":
            return web.json_response({"ok": True, "bridge": "mohassan"})
        if tail == "conversations" and request.method == "GET":
            # The same shape Mohassan's chat control returns.
            return web.json_response({"conversations": [{"id": cid, "title": "t", "status": status, "browserAccount": None, "updatedAt": "now"} for cid, status in self.statuses.items()]})
        if tail == "conversations":
            cid = str(uuid.uuid4())
            self.statuses[cid] = "running"
            return web.json_response({"id": cid, "status": "running", "messages": []})
        return web.json_response({"ok": True, "tail": tail})


class MohassanBridgeTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = test_server.ServerTests.asyncTearDown
    enroll = test_server.ServerTests.enroll

    async def asyncSetUp(self):
        await test_server.ServerTests.asyncSetUp(self)
        self.mohassan = FakeMohassan()
        await self.mohassan.server.start_server()
        self.base = str(self.mohassan.server.make_url("")).rstrip("/")
        self.bridge = self.app[STATE].mohassan

    async def asyncTearDown(self):
        await self.mohassan.server.close()
        await test_server.ServerTests.asyncTearDown(self)

    async def link(self):
        await self.bridge.pair("A" * 16, "Wasla test", self.base)

    def test_mohassan_address_must_be_this_computer(self):
        self.assertEqual(loopback_url("http://127.0.0.1:4000"), "http://127.0.0.1:4000")
        self.assertEqual(loopback_url("http://localhost:4000/"), "http://localhost:4000")
        for bad in ("https://127.0.0.1:4000", "http://100.72.126.108:4000", "http://example.com", "http://127.0.0.1:4000/api", "http://user:pw@127.0.0.1:4000", "ftp://127.0.0.1"):
            with self.assertRaises(BridgeError, msg=bad):
                loopback_url(bad)

    async def test_requires_the_paired_device(self):
        for method, path in (("GET", "/v1/mohassan/status"), ("GET", "/v1/mohassan/conversations"), ("POST", "/v1/mohassan/conversations")):
            self.assertEqual((await self.client.request(method, path, json={})).status, 401, path)

    async def test_unlinked_service_says_so(self):
        status = await (await self.client.get("/v1/mohassan/status", headers=self.headers)).json()
        self.assertEqual(status, {"linked": False, "reachable": False})
        response = await self.client.get("/v1/mohassan/conversations", headers=self.headers)
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"]["code"], "mohassan_not_linked")

    async def test_pairing_stores_the_key_privately_and_rejects_a_bad_code(self):
        with self.assertRaises(BridgeError):
            await self.bridge.pair("B" * 16, "Wasla test", self.base)
        self.assertFalse(self.bridge.configured)
        with self.assertRaises(BridgeError):
            await self.bridge.pair("A" * 16, "Wasla test", "http://192.168.1.5:4000")
        await self.link()
        self.assertTrue(self.bridge.configured)
        stored = json.loads((self.store.root / "mohassan-gateway.json").read_text(encoding="utf-8"))
        self.assertEqual(stored, {"url": self.base, "gateway_key": self.mohassan.key})
        status = await (await self.client.get("/v1/mohassan/status", headers=self.headers)).json()
        self.assertEqual(status, {"linked": True, "reachable": True})

    async def test_chat_calls_pass_through_with_the_key_and_never_return_it(self):
        await self.link()
        created = await self.client.post("/v1/mohassan/conversations", headers=self.headers, json={"goal": "مرحبا"})
        self.assertEqual(created.status, 200)
        cid = (await created.json())["id"]
        calls = [
            ("GET", "/v1/mohassan/conversations", None, "/api/wasla/gateway/conversations"),
            ("GET", f"/v1/mohassan/conversations/{cid}", None, f"/api/wasla/gateway/conversations/{cid}"),
            ("GET", f"/v1/mohassan/conversations/{cid}/events/7", None, f"/api/wasla/gateway/conversations/{cid}/campaign-events?after=7"),
            ("POST", f"/v1/mohassan/conversations/{cid}/cancel", {}, f"/api/wasla/gateway/conversations/{cid}/cancel"),
            ("DELETE", f"/v1/mohassan/conversations/{cid}", None, f"/api/wasla/gateway/conversations/{cid}"),
        ]
        self.mohassan.statuses.clear()
        for method, path, body, upstream in calls:
            response = await self.client.request(method, path, headers=self.headers, **({"json": body} if body is not None else {}))
            text = await response.text()
            self.assertEqual(response.status, 200, (path, text))
            self.assertNotIn(KEY_SECRET, text)
            self.assertEqual(self.mohassan.calls[-1][1], upstream)
        for action, body in (("messages", {"text": "تابع"}), ("respond", {"questionId": str(uuid.uuid4()), "optionId": "yes"}), ("approve", {"approvalId": str(uuid.uuid4()), "approved": False})):
            response = await self.client.post(f"/v1/mohassan/conversations/{cid}/{action}", headers=self.headers, json=body)
            self.assertEqual(response.status, 200, action)
            method, path, sent, headers = self.mohassan.calls[-1]
            self.assertEqual((method, path, sent), ("POST", f"/api/wasla/gateway/conversations/{cid}/{action}", body))
            # Nothing that identifies the phone or a browser reaches Mohassan.
            self.assertNotIn("Origin", headers)
            self.assertNotIn("Cookie", headers)
            self.assertEqual(headers["Authorization"], "Bearer " + self.mohassan.key)

    async def test_refuses_calls_outside_the_list_before_reaching_mohassan(self):
        await self.link()
        cid = str(uuid.uuid4())
        for path, body in ((f"/v1/mohassan/conversations/{cid}/secure", {"requestId": cid}), (f"/v1/mohassan/conversations/{cid}/browser", {}),
                           (f"/v1/mohassan/conversations/{cid}/messages", {"text": "x", "extra": 1}), ("/v1/mohassan/conversations", {"goal": "x", "browserAccount": "a"}),
                           (f"/v1/mohassan/conversations/{cid}/approve", {"approvalId": cid})):
            response = await self.client.post(path, headers=self.headers, json=body)
            self.assertIn(response.status, (400, 404), path)
        self.assertEqual((await self.client.get("/v1/mohassan/conversations/not-a-uuid", headers=self.headers)).status, 404)
        self.assertEqual((await self.client.get(f"/v1/mohassan/conversations/{cid}/events/abc", headers=self.headers)).status, 400)
        self.assertEqual(self.mohassan.calls, [])

    async def test_mohassan_refusals_and_outages_reach_the_phone_plainly(self):
        await self.link()
        cid = str(uuid.uuid4())
        self.mohassan.fail = ("CHAT_APPROVAL_CHANGED", "هذا الطلب لم يعد معلقًا.", 409)
        response = await self.client.post(f"/v1/mohassan/conversations/{cid}/approve", headers=self.headers, json={"approvalId": cid, "approved": True})
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"], {"code": "CHAT_APPROVAL_CHANGED", "message": "هذا الطلب لم يعد معلقًا."})
        self.mohassan.fail = ("INTERNAL", "stack trace here", 500)
        response = await self.client.get(f"/v1/mohassan/conversations/{cid}", headers=self.headers)
        self.assertEqual(response.status, 502)
        self.mohassan.fail = None
        await self.mohassan.server.close()
        response = await self.client.get("/v1/mohassan/conversations", headers=self.headers)
        self.assertEqual(response.status, 502)
        self.assertEqual((await response.json())["error"]["code"], "mohassan_unavailable")

    async def test_mohassan_and_images_never_share_the_gpu(self):
        await self.link()
        cid = str(uuid.uuid4())
        self.services.busy = "image"
        response = await self.client.post(f"/v1/mohassan/conversations/{cid}/messages", headers=self.headers, json={"text": "تابع"})
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"]["code"], "gpu_busy")
        # Stopping is always allowed.
        self.assertEqual((await self.client.post(f"/v1/mohassan/conversations/{cid}/cancel", headers=self.headers, json={})).status, 200)
        self.services.busy = None
        self.mohassan.statuses[cid] = "running"
        image = await self.client.post("/v1/images", headers=self.headers, json={"prompt": "قطة", "negative_prompt": "", "seed": 1, "request_id": "image-request-1"})
        self.assertEqual(image.status, 409)
        self.assertIn("موحسن", (await image.json())["error"]["message"])


if __name__ == "__main__":
    unittest.main()
