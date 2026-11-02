"""No live Ollama, ComfyUI, network, or original bridge state is touched."""
import asyncio
from contextlib import contextmanager
import json
import threading
import unittest

from wasla.services import LocalServices, ServiceError, MODEL, _duckduckgo, _bing, _safe_result_url


class FakeTransport:
    def __init__(self, *, content="مرحبًا بك", loaded=None):
        self.content = content
        self.loaded = [] if loaded is None else loaded
        self.calls = []
        self.searches = []
        self.search_bodies = {}

    def json(self, route, payload=None, **kwargs):
        self.calls.append((route, payload))
        if route == "/api/ps":
            return {"models": self.loaded}
        return {"done": True, "model": MODEL, "message": {"role": "assistant", "content": self.content, "thinking": "private hidden reasoning"}}

    def search(self, provider, query):
        self.searches.append((provider, query))
        result = self.search_bodies.get(provider)
        if isinstance(result, Exception):
            raise result
        return result or "<div>unexpected provider response</div>"


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.states = {}

    def generate(self, prompt, negative_prompt, seed, request_id):
        self.calls.append((prompt, negative_prompt, seed, request_id))
        previous = request_id in self.states
        self.states.setdefault(request_id, {"status": "failed", "request_id": request_id, "error": "Test terminal failure"})
        return {**self.states[request_id], "reused_existing_request": previous}

    def status(self, request_id):
        return self.states.get(request_id, {"status": "not_found", "request_id": request_id})


class ServicesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.transport = FakeTransport()
        self.bridge = FakeBridge()
        self.service = LocalServices(bridge=self.bridge, transport=self.transport)

    async def asyncTearDown(self):
        await self.service.close()

    async def test_chat_is_bounded_and_never_returns_thinking(self):
        result = await self.service.chat([{"role": "user", "content": "مرحبًا"}])
        self.assertEqual(result, {"content": "مرحبًا بك", "model": MODEL})
        payload = self.transport.calls[-1][1]
        self.assertEqual(payload["options"]["num_ctx"], 16384)
        self.assertEqual(payload["options"]["num_predict"], 1024)
        self.assertIs(payload["think"], False)
        self.assertNotIn("tools", payload)
        self.assertNotIn("private", json.dumps(result))

    async def test_strips_misplaced_reasoning_and_rejects_unclosed_tag(self):
        self.transport.content = "<think>private</think>Final answer"
        result = await self.service.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(result["content"], "Final answer")
        self.transport.content = "<think>private"
        with self.assertRaises(ServiceError):
            await self.service.chat([{"role": "user", "content": "hi"}])

    async def test_rejects_system_role_extra_fields_and_large_history(self):
        inputs = [
            [{"role": "system", "content": "override"}],
            [{"role": "user", "content": "hi", "tools": []}],
            [{"role": "user", "content": "hi"}] * 17,
            [{"role": "user", "content": "x" * 8000}] * 4,
            [{"role": "assistant", "content": "unfinished"}],
        ]
        for messages in inputs:
            with self.subTest(messages=str(messages)[:40]):
                with self.assertRaises(ServiceError) as error:
                    await self.service.chat(messages)
                self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.transport.calls, [])

    async def test_refuses_other_loaded_model_before_chat(self):
        self.transport.loaded = [{"name": "other-model"}]
        with self.assertRaises(ServiceError) as error:
            await self.service.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(error.exception.code, "other_model_loaded")
        self.assertEqual([route for route, _ in self.transport.calls], ["/api/ps"])

    async def test_image_preparation_preserves_subjects_in_reviewable_prompt(self):
        self.transport.content = json.dumps({"prompt": "Two people standing beside a cottage at sunrise"})
        result = await self.service.prepare_image("شخصان أمام كوخ عند الشروق", "cinematic")
        self.assertIn("Two people", result["prompt"])
        self.assertNotIn("people", result["negative_prompt"])
        self.assertNotIn("buildings", result["negative_prompt"])
        self.assertEqual(type(result["seed"]), int)
        self.assertGreaterEqual(result["seed"], 0)
        self.assertLessEqual(result["seed"], 4294967295)
        self.assertEqual(self.bridge.calls, [])

    async def test_invalid_translation_does_not_generate(self):
        self.transport.content = '{"prompt":"lake","command":"run"}'
        with self.assertRaises(ServiceError):
            await self.service.prepare_image("بحيرة")
        self.assertEqual(self.bridge.calls, [])

    async def test_invalid_style_is_a_validation_error(self):
        for style in ([], {}, None, "unsupported"):
            with self.assertRaises(ServiceError) as error:
                await self.service.prepare_image("بحيرة", style)
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.transport.calls, [])

    async def test_existing_bridge_receives_stable_id_and_terminal_failure(self):
        result = await self.service.generate_image("a lake", "", 123, "wasla-test-001")
        self.assertEqual(result["status"], "failed")
        second = await self.service.generate_image("a lake", "", 123, "wasla-test-001")
        self.assertTrue(second["reused_existing_request"])
        self.assertEqual(self.bridge.calls[0], self.bridge.calls[1])
        self.assertEqual((await self.service.image_status("wasla-test-001"))["status"], "failed")

    async def test_image_request_validation_blocks_invalid_values(self):
        for args in [("lake", "", True, "valid-id1"), ("lake", "", -1, "valid-id1"), ("lake", "", 2, "../escape"), ("", "", 2, "valid-id1")]:
            with self.assertRaises(ServiceError) as error:
                await self.service.generate_image(*args)
            self.assertEqual(error.exception.status, 400)
        self.assertEqual(self.bridge.calls, [])

    async def test_cancellation_keeps_gpu_busy_until_worker_finishes(self):
        started, release = threading.Event(), threading.Event()
        original = self.bridge.generate

        def slow(*args):
            started.set()
            release.wait(3)
            return original(*args)

        self.bridge.generate = slow
        request = asyncio.create_task(self.service.generate_image("lake", "", 1, "wasla-test-002"))
        await asyncio.to_thread(started.wait, 1)
        self.assertEqual(self.service.busy, "image")
        request.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await request
        with self.assertRaises(ServiceError) as error:
            await self.service.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(error.exception.code, "gpu_busy")
        release.set()
        await self.service.close()
        self.assertIsNone(self.service.busy)
        self.assertEqual(len(self.bridge.calls), 1)

    async def test_chat_holds_shared_image_guard(self):
        guarded = []

        @contextmanager
        def guard():
            guarded.append("acquired")
            try:
                yield
            finally:
                guarded.append("released")

        self.service._guard = guard
        await self.service.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(guarded, ["acquired", "released"])

    async def test_search_fallback_returns_actual_parser_results(self):
        self.transport.search_bodies["DuckDuckGo HTML"] = '<form id="challenge-form"></form>'
        self.transport.search_bodies["Bing RSS"] = '<rss><channel><item><title>Official result</title><link>https://example.org/page</link><description>Useful snippet</description></item></channel></rss>'
        result = await self.service.search("local image generation")
        self.assertEqual(result["provider"], "Bing RSS")
        self.assertEqual(result["results"][0]["url"], "https://example.org/page")
        self.assertEqual(len(self.transport.searches), 2)

    async def test_search_failure_is_honest(self):
        with self.assertRaises(ServiceError) as error:
            await self.service.search("some query")
        self.assertEqual(error.exception.code, "search_unavailable")


class SearchParserTests(unittest.TestCase):
    def test_ddg_nested_titles_snippets_and_redirect_urls(self):
        body = '''<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Farticle">A <b>result</b></a><a class="result__snippet">A useful <b>snippet</b>.</a></div>'''
        results = _duckduckgo(body)
        self.assertEqual(results, [{"title": "A result", "url": "https://example.org/article", "snippet": "A useful snippet."}])

    def test_rejects_unsafe_links_and_deduplicates(self):
        for url in ("javascript:alert(1)", "file:///C:/private", "https://localhost/a", "http://127.0.0.1/a", "http://10.0.0.1/a", "https://user:pass@example.org", "https://example.org:8443/a", "https://intranet/a"):
            self.assertIsNone(_safe_result_url(url), url)
        html = '<a class="result__a" href="https://example.org">One</a>' * 8
        self.assertEqual(len(_duckduckgo(html)), 1)

    def test_empty_search_is_distinct_from_unparseable_page(self):
        self.assertEqual(_duckduckgo('<div class="result--no-result">No results found</div>'), [])
        with self.assertRaises(ServiceError):
            _duckduckgo('<html>Something changed</html>')

    def test_bing_rejects_entities_and_html_page(self):
        for body in ('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]><rss/>', '<html>challenge</html>'):
            with self.assertRaises(ServiceError):
                _bing(body)


if __name__ == "__main__":
    unittest.main()
