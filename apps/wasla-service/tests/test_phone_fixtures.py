"""The computer service forwards Mohassan's real replies to the phone unchanged.

tests/fixtures/phone/ (repository root) holds exchanges recorded from a real Mohassan
server by scripts/phone-fixtures.ts. The same files drive the TypeScript contract test
and the Swift checks, so the three sides agree on one recorded truth.
"""
import json
from pathlib import Path
import tempfile
import unittest

from aiohttp import web
from aiohttp.test_utils import TestServer
from wasla.mohassan import MohassanBridge
from wasla.server import MOHASSAN_FIELDS

FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "phone"
KEY = "0ad1c4b4-3a37-4f7e-9c6b-8d3e5f2a1b0c." + "K" * 43


def load():
    files = sorted(path for path in FIXTURES.glob("*.json") if path.name != "index.json")
    return {path.stem: json.loads(path.read_text(encoding="utf-8")) for path in files}


class PhoneFixtureTests(unittest.IsolatedAsyncioTestCase):
    def test_fixtures_exist(self):
        fixtures = load()
        self.assertGreaterEqual(len(fixtures), 20, "run: npx tsx scripts/phone-fixtures.ts")
        index = json.loads((FIXTURES / "index.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(item["file"] for item in index["fixtures"]), sorted(fixtures))

    def test_phone_requests_pass_the_closed_field_list(self):
        """Every body the phone sent in a recorded exchange is one the service lets through."""
        checked = 0
        for name, fixture in load().items():
            request = fixture["request"]
            if request["method"] != "POST" or "body" not in request:
                continue
            action = request["url"].rsplit("/", 1)[-1]
            kind = "create" if action == "conversations" else action
            self.assertIn(kind, MOHASSAN_FIELDS, name)
            allowed, required = MOHASSAN_FIELDS[kind]
            body = request["body"]
            self.assertFalse(set(body) - allowed, f"{name}: unsupported fields {set(body) - allowed}")
            self.assertFalse(required - set(body), f"{name}: missing fields {required - set(body)}")
            checked += 1
        self.assertGreaterEqual(checked, 6)

    async def test_bridge_forwards_recorded_bodies_unchanged(self):
        """Mohassan's real replies reach the phone byte for byte: no reshaping in the service."""
        fixtures = load()
        # One recorded exchange is served at a time: several fixtures read the same conversation at different moments.
        served = {}

        async def gateway(request):
            if request.headers.get("Authorization") != "Bearer " + KEY:
                return web.json_response({"error": {"code": "WASLA_GATEWAY_UNAUTHORIZED", "message": "x"}}, status=401)
            response = served.get(request.path)
            if response is None:
                return web.json_response({"error": {"code": "CHAT_NOT_FOUND", "message": "x"}}, status=404)
            return web.json_response(response["body"], status=response["status"])

        app = web.Application()
        app.router.add_route("GET", "/api/wasla/gateway/{tail:.*}", gateway)
        server = TestServer(app)
        await server.start_server()
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        bridge = MohassanBridge(root)
        bridge.save(f"http://127.0.0.1:{server.port}", KEY)
        try:
            served["/api/wasla/gateway/status"] = fixtures["status"]["response"]
            self.assertEqual(await bridge.status(), {"linked": True, "reachable": True})
            served["/api/wasla/gateway/conversations"] = fixtures["list"]["response"]
            self.assertEqual(await bridge.conversations(), fixtures["list"]["response"]["body"])
            forwarded = 0
            for name, fixture in fixtures.items():
                if not name.startswith("detail-") or fixture["response"]["status"] != 200:
                    continue
                path = fixture["request"]["url"]
                served[path] = fixture["response"]
                self.assertEqual(await bridge.detail(path.rsplit("/", 1)[-1]), fixture["response"]["body"], name)
                forwarded += 1
            self.assertGreaterEqual(forwarded, 10)
        finally:
            await bridge.close()
            await server.close()

    def test_recorded_states_the_phone_must_render(self):
        fixtures = load()
        body = lambda name: fixtures[name]["response"]["body"]  # noqa: E731
        self.assertIn("345", body("detail-completed")["messages"][-1]["text"])
        question = body("detail-question-fields")["question"]
        # Mohassan asks several questions in one card (`fields`); the service passes them through.
        self.assertEqual([field["id"] for field in question["fields"]], ["to", "kind", "details", "from"])
        self.assertEqual(body("detail-approval")["status"], "waiting_approval")
        self.assertEqual(body("detail-cancelled")["status"], "idle")
        for name in ("detail-failed-blocked-address",):
            self.assertEqual(body(name)["status"], "failed", name)
            self.assertTrue(body(name)["error"], name)
        for name, fixture in fixtures.items():
            if name.startswith("detail-"):
                self.assertNotIn("browser", fixture["response"]["body"], name)
                self.assertNotIn("recoveryToken", json.dumps(fixture["response"]["body"]), name)


if __name__ == "__main__":
    unittest.main()
