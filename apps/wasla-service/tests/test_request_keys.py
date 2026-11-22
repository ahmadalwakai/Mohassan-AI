"""The phone's request keys and field answers pass through the service unchanged (plan phase 3)."""
import unittest

import test_mohassan

KEY = "6f1c2b8a-3d4e-4f5a-9b6c-7d8e9f0a1b2c"
CID = "8f2c1a9e-4b7d-4c3e-9a1f-2d5e6b7c8a90"
QID = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"


class RequestKeyTests(test_mohassan.MohassanBridgeTests):
    def sent(self, fragment):
        return [(method, path, body) for method, path, body, _ in self.mohassan.calls if fragment in path]

    async def test_keys_and_field_answers_reach_mohassan_unchanged(self):
        await self.link()
        bodies = {
            f"/v1/mohassan/conversations": {"goal": "كم يساوي 7 ضرب 6؟", "clientRequestId": KEY},
            f"/v1/mohassan/conversations/{CID}/messages": {"questionId": QID, "answers": [{"fieldId": "to", "value": "الأستاذ خالد"}], "clientRequestId": KEY},
            f"/v1/mohassan/conversations/{CID}/respond": {"questionId": QID, "optionId": "stop", "clientRequestId": KEY},
            f"/v1/mohassan/conversations/{CID}/approve": {"approvalId": QID, "approved": False, "clientRequestId": KEY},
        }
        for path, body in bodies.items():
            response = await self.client.post(path, headers=self.headers, json=body)
            self.assertEqual(response.status, 200, path)
        forwarded = [body for method, path, body in self.sent("/api/wasla/gateway/conversations") if method == "POST"]
        self.assertEqual(forwarded, list(bodies.values()))

    async def test_typed_answer_goes_as_a_message_not_through_respond(self):
        await self.link()
        typed = await self.client.post(f"/v1/mohassan/conversations/{CID}/respond", headers=self.headers, json={"questionId": QID, "text": "١٠٠ جنيه"})
        self.assertEqual(typed.status, 400)
        message = await self.client.post(f"/v1/mohassan/conversations/{CID}/messages", headers=self.headers, json={"text": "١٠٠ جنيه", "questionId": QID})
        self.assertEqual(message.status, 200)

    async def test_request_lookup_is_forwarded_and_validated(self):
        await self.link()
        found = await self.client.get(f"/v1/mohassan/requests/{KEY}", headers=self.headers)
        self.assertEqual(found.status, 200)
        self.assertEqual(self.sent("/requests/")[-1][:2], ("GET", f"/api/wasla/gateway/requests/{KEY}"))
        bad = await self.client.get("/v1/mohassan/requests/not-a-key", headers=self.headers)
        self.assertEqual(bad.status, 400)
        self.assertEqual(len(self.sent("/requests/")), 1)


if __name__ == "__main__":
    unittest.main()
