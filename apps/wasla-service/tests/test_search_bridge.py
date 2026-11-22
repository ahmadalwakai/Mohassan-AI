"""The phone's search runs on Mohassan's engine through the bridge (owner's decision, 2026-11-22)."""
import unittest

from wasla.server import STATE
import test_mohassan


class SearchBridgeTests(test_mohassan.MohassanBridgeTests):
    async def test_search_is_forwarded_to_mohassan_and_recorded(self):
        await self.link()
        response = await self.client.post("/v1/search", headers=self.headers, json={"query": "وثائق Tailscale"})
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())["tail"], "search")   # Mohassan's reply is returned untouched
        self.assertEqual([(m, p) for m, p, _, _ in self.mohassan.calls if "search" in p], [("GET", "/api/wasla/gateway/search?q=%D9%88%D8%AB%D8%A7%D8%A6%D9%82%20Tailscale")])
        self.assertTrue(self.app[STATE].last_search["ok"])
        status = await (await self.client.get("/v1/status", headers=self.headers)).json()
        self.assertTrue(status["capabilities"]["search"]["ready"])

    async def test_unlinked_search_fails_closed_and_status_says_why(self):
        response = await self.client.post("/v1/search", headers=self.headers, json={"query": "x"})
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())["error"]["code"], "mohassan_not_linked")
        self.assertFalse(self.app[STATE].last_search["ok"])
        status = await (await self.client.get("/v1/status", headers=self.headers)).json()
        self.assertFalse(status["capabilities"]["search"]["ready"])
        self.assertIn("البحث يمر عبر موحسن", status["capabilities"]["search"]["reason"])

    async def test_search_query_is_bounded(self):
        await self.link()
        for payload in ({"query": ""}, {"query": "x" * 401}, {"query": 5}, {"q": "x"}):
            response = await self.client.post("/v1/search", headers=self.headers, json=payload)
            self.assertEqual(response.status, 400, payload)
        self.assertEqual([p for _, p, _, _ in self.mohassan.calls if "search" in p], [])


if __name__ == "__main__":
    unittest.main()
