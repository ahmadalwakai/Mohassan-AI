"""/v1/status tells the phone what it can really use, each with its reason when it cannot."""
import unittest

from wasla.server import STATE
import test_server


class FakeBridge:
    configured = True
    def __init__(self, result):
        self.result = result
    async def status(self):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result
    async def running(self):
        return False
    async def close(self):
        pass


class StatusCapabilityTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_server.ServerTests.asyncSetUp
    asyncTearDown = test_server.ServerTests.asyncTearDown
    enroll = test_server.ServerTests.enroll

    async def status(self):
        response = await self.client.get('/v1/status', headers=self.headers)
        self.assertEqual(response.status, 200)
        return await response.json()

    async def test_linked_and_reachable_mohassan_is_ready_chat(self):
        self.app[STATE].mohassan = FakeBridge({"linked": True, "reachable": True})
        body = await self.status()
        self.assertEqual(body["capabilities"]["chat"], {"ready": True})
        self.assertEqual(body["model"], "Mohassan")
        self.assertEqual(body["chat_backend"], "mohassan")
        self.assertFalse(body["app_actions_enabled"])
        self.assertEqual(set(body["capabilities"]), {"chat", "search", "images", "desktop"})

    async def test_each_bridge_failure_has_its_own_reason(self):
        cases = [
            ({"linked": False, "reachable": False}, "وصلة غير مربوط"),
            ({"linked": True, "reachable": False, "error": "mohassan_unavailable"}, "موحسن متوقف"),
            ({"linked": True, "reachable": True, "error": "WASLA_GATEWAY_UNAUTHORIZED"}, "أُلغي ربط"),
            (RuntimeError("boom"), "موحسن متوقف"),
        ]
        for result, expected in cases:
            self.app[STATE].mohassan = FakeBridge(result)
            chat = (await self.status())["capabilities"]["chat"]
            with self.subTest(result=str(result)):
                self.assertFalse(chat["ready"])
                self.assertIn(expected, chat["reason"])

    async def test_search_images_and_desktop_report_their_state(self):
        self.app[STATE].mohassan = FakeBridge({"linked": True, "reachable": True})
        services = self.app[STATE].services
        body = await self.status()
        self.assertTrue(body["capabilities"]["search"]["ready"])           # Mohassan's engine, as ready as the bridge
        self.assertTrue(body["capabilities"]["images"]["ready"])           # the fake has no image_error
        self.assertTrue(body["capabilities"]["desktop"]["ready"])          # enabled in the fixture
        import time
        self.app[STATE].last_search = {"ok": False, "at": time.time(), "code": "search_unavailable", "message": "offline"}
        services.images_available = False
        services.image_error = type("E", (), {"code": "image_engine_missing"})()
        self.app[STATE].desktop_enabled = False
        body = await self.status()
        self.assertEqual(body["capabilities"]["search"]["code"], "search_unavailable")
        self.assertEqual(body["capabilities"]["images"]["code"], "image_engine_missing")
        self.assertFalse(body["images_available"])
        self.assertIn("غير مفعّل", body["capabilities"]["desktop"]["reason"])


if __name__ == "__main__":
    unittest.main()
