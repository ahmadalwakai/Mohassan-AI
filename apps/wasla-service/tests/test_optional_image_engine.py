"""The service starts, pairs and forwards to Mohassan even when the local image engine is gone.

The engine folder named in services.ENGINE_DIR disappeared from the owner's computer on
2026-11-22. Before this, LocalServices() raised at start-up and the phone could not reach
anything: pairing, status, desktop and the Mohassan bridge all went down with the images.
"""
import asyncio
from pathlib import Path
import tempfile
import unittest

from wasla.services import LocalServices, ServiceError


class FakeTransport:
    def json(self, route, payload=None, *, timeout=10):
        raise AssertionError("no model call expected")

    def search(self, provider, query):
        raise AssertionError("no search expected")


class OptionalImageEngineTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.missing = Path(tempfile.mkdtemp()) / "no-engine-here"
        self.service = LocalServices(self.missing, transport=FakeTransport())

    async def asyncTearDown(self):
        await self.service.close()

    def test_starts_without_the_engine_and_says_why(self):
        self.assertFalse(self.service.images_available)
        self.assertIsNotNone(self.service.image_error)
        self.assertEqual(self.service.image_error.code, "image_engine_missing")
        self.assertIsNone(self.service.busy)

    async def test_image_calls_fail_closed_with_the_reason(self):
        for call in (
            self.service.prepare_image("كوخ بجانب بحيرة", "natural"),
            self.service.generate_image("a cabin", "", 7, "wasla-test-001"),
            self.service.image_status("wasla-test-001"),
        ):
            with self.assertRaises(ServiceError) as caught:
                await call
            self.assertEqual(caught.exception.code, "image_engine_missing")
            self.assertEqual(caught.exception.status, 503)

    async def test_invalid_image_input_is_still_rejected_first(self):
        with self.assertRaises(ServiceError) as caught:
            await self.service.generate_image("a cabin", "", 7, "bad id")
        self.assertEqual(caught.exception.code, "invalid_request")


if __name__ == "__main__":
    unittest.main()
