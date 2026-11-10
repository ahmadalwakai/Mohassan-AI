"""No live Ollama, ComfyUI, network, or original bridge state is touched."""
import asyncio
from contextlib import contextmanager
import json
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit
from xml.sax.saxutils import escape

from wasla.services import LocalServices, ServiceError, MODEL, _HTTP, _duckduckgo, _bing, _safe_result_url


ARABIC_SEARCH = "ابحث عن وثائق Tailscale الرسمية لتوصيل iPhone بكمبيوتر Windows، وأظهر المصادر."


def rss(query, items=()):
    """Provider fixture with an accurately echoed query, including Arabic."""
    link = "https://www.bing.com/search?" + urlencode({"q": query, "format": "rss"})
    rows = "".join(
        f"<item><title>{escape(title)}</title><link>{escape(url)}</link>"
        f"<description>{escape(snippet)}</description></item>"
        for title, url, snippet in items
    )
    return f"<rss><channel><title>Bing: {escape(query)}</title><link>{escape(link)}</link>{rows}</channel></rss>"


TAILSCALE_RESULT = ("Tailscale documentation", "https://tailscale.com/kb", "Connect iPhone and Windows")


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
        self.transport.search_bodies["Bing RSS"] = rss("local image generation", [
            ("Local image generation", "https://example.org/page", "Generate an image locally")])
        result = await self.service.search("local image generation")
        self.assertEqual(result["provider"], "Bing RSS")
        self.assertEqual(result["results"][0]["url"], "https://example.org/page")
        self.assertEqual(len(self.transport.searches), 2)

    async def test_empty_first_provider_tries_relevant_second_provider(self):
        self.transport.search_bodies["DuckDuckGo HTML"] = '<div class="no-results">No results found</div>'
        self.transport.search_bodies["Bing RSS"] = rss(ARABIC_SEARCH, [TAILSCALE_RESULT])
        result = await self.service.search(ARABIC_SEARCH)
        self.assertEqual(result["provider"], "Bing RSS")
        self.assertEqual(result["results"][0]["url"], TAILSCALE_RESULT[1])
        self.assertEqual(self.transport.searches, [(name, ARABIC_SEARCH) for name in ("DuckDuckGo HTML", "Bing RSS")])
        self.assertEqual(self.transport.calls, [])  # Relevance checking never invokes the model.

    async def test_irrelevant_first_provider_tries_second_provider(self):
        self.transport.search_bodies["DuckDuckGo HTML"] = (
            '<a class="result__a" href="https://example.org/stocks">Barclays share price</a>')
        self.transport.search_bodies["Bing RSS"] = rss(ARABIC_SEARCH, [TAILSCALE_RESULT])
        result = await self.service.search(ARABIC_SEARCH)
        self.assertEqual(result["results"][0]["title"], TAILSCALE_RESULT[0])
        self.assertEqual(len(self.transport.searches), 2)

    async def test_mismatched_first_provider_tries_second_provider(self):
        self.transport.search_bodies["DuckDuckGo HTML"] = (
            '<input name="q" value="another query">'
            '<a class="result__a" href="https://tailscale.com">Tailscale</a>')
        self.transport.search_bodies["Bing RSS"] = rss(ARABIC_SEARCH, [TAILSCALE_RESULT])
        self.assertEqual((await self.service.search(ARABIC_SEARCH))["provider"], "Bing RSS")

    async def test_both_explicit_empty_results_remain_empty(self):
        self.transport.search_bodies["DuckDuckGo HTML"] = '<div class="no-results">No results found</div>'
        self.transport.search_bodies["Bing RSS"] = rss(ARABIC_SEARCH)
        result = await self.service.search(ARABIC_SEARCH)
        self.assertEqual(result["results"], [])
        self.assertEqual(len(self.transport.searches), 2)

    async def test_genuine_empty_is_preserved_when_other_provider_fails(self):
        self.transport.search_bodies["DuckDuckGo HTML"] = ServiceError("upstream_unavailable", "offline")
        self.transport.search_bodies["Bing RSS"] = rss(ARABIC_SEARCH)
        result = await self.service.search(ARABIC_SEARCH)
        self.assertEqual(result["results"], [])
        self.assertEqual(result["provider"], "Bing RSS")

    async def test_correct_query_echo_does_not_make_unrelated_feed_acceptable(self):
        self.transport.search_bodies["DuckDuckGo HTML"] = ServiceError("upstream_unavailable", "offline")
        for title in ("FLINTMANOR company information", "Barclays stock quotes"):
            self.transport.search_bodies["Bing RSS"] = rss(ARABIC_SEARCH, [
                (title, "https://example.org/company", "Shares and company registration")])
            with self.subTest(title=title), self.assertRaises(ServiceError) as error:
                await self.service.search(ARABIC_SEARCH)
            self.assertEqual(error.exception.code, "search_irrelevant")
        self.assertEqual(self.transport.calls, [])

    async def test_search_failure_is_honest(self):
        with self.assertRaises(ServiceError) as error:
            await self.service.search("some query")
        self.assertEqual(error.exception.code, "search_unavailable")


class SearchParserTests(unittest.TestCase):
    def test_bing_filters_unrelated_results_even_when_platforms_match(self):
        items = [
            ("Windows and iPhone accessories", "https://example.org/shop", "Buy cases"),
            TAILSCALE_RESULT,
            ("Barclays", "https://example.org/stocks", "Financial information"),
        ]
        results = _bing(rss(ARABIC_SEARCH, items), query=ARABIC_SEARCH)
        self.assertEqual([result["url"] for result in results], [TAILSCALE_RESULT[1]])

    def test_relevance_is_checked_before_six_result_display_limit(self):
        items = [(f"Unrelated company {index}", f"https://example.org/{index}", "Stocks") for index in range(6)]
        items.append(TAILSCALE_RESULT)
        self.assertEqual(_bing(rss(ARABIC_SEARCH, items), query=ARABIC_SEARCH)[0]["url"], TAILSCALE_RESULT[1])

    def test_bing_query_echo_mismatch_is_rejected_even_with_relevant_results(self):
        with self.assertRaises(ServiceError) as error:
            _bing(rss("different question", [TAILSCALE_RESULT]), query=ARABIC_SEARCH)
        self.assertEqual(error.exception.code, "search_query_mismatch")

    def test_bing_link_echo_must_also_match(self):
        body = rss(ARABIC_SEARCH, [TAILSCALE_RESULT]).replace(
            urlencode({"q": ARABIC_SEARCH, "format": "rss"}).replace("&", "&amp;"), "q=other&amp;format=rss")
        with self.assertRaises(ServiceError) as error:
            _bing(body, query=ARABIC_SEARCH)
        self.assertEqual(error.exception.code, "search_query_mismatch")

    def test_ddg_query_input_and_title_echo_mismatch_are_rejected(self):
        result = '<a class="result__a" href="https://tailscale.com">Tailscale</a>'
        for metadata in ('<input name="q" value="other">', '<title>other at DuckDuckGo</title>'):
            with self.subTest(metadata=metadata), self.assertRaises(ServiceError) as error:
                _duckduckgo(metadata + result, query="Tailscale")
            self.assertEqual(error.exception.code, "search_query_mismatch")

    def test_arabic_spelling_and_diacritics_are_normalized_for_relevance(self):
        query = "ابحث عن وَثَائِق تايلسكيل آيفون ويندوز"
        results = _bing(rss(query, [TAILSCALE_RESULT]), query=query)
        self.assertEqual(results[0]["url"], TAILSCALE_RESULT[1])

    def test_unusable_feed_items_are_not_reported_as_genuine_empty(self):
        with self.assertRaises(ServiceError) as error:
            _bing(rss("Tailscale", [("Tailscale", "file:///secret", "")]), query="Tailscale")
        self.assertEqual(error.exception.code, "invalid_search_response")

    def test_http_search_sends_exact_query_and_discourages_stale_responses(self):
        transport = _HTTP()
        with patch.object(transport, "_read", return_value=(b"<rss/>", "application/rss+xml")) as read:
            transport.search("Bing RSS", ARABIC_SEARCH)
        request = read.call_args.args[1]
        self.assertEqual(parse_qs(urlsplit(request.full_url).query), {"q": [ARABIC_SEARCH], "format": ["rss"]})
        self.assertEqual(request.get_header("Cache-control"), "no-cache")
        self.assertEqual(read.call_args.args[2:], (18, 1024 * 1024))

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
