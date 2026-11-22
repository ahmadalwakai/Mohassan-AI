"""No HTTP/model calls: injected transport, temporary budget file, fake prices."""
from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from wasla.cloud import CloudIntelligence, MAX_OUTPUT, _NoRedirect
from wasla.services import ServiceError


FAKE_ENV = {
    "WASLA_CLOUD_ENABLED": "1", "OPENAI_API_KEY": "fake-test-key-never-used-on-network",
    "WASLA_CLOUD_MODEL": "explicit-test-model", "WASLA_CLOUD_DAILY_BUDGET_USD": "100",
    "WASLA_CLOUD_INPUT_USD_PER_MILLION": "1", "WASLA_CLOUD_OUTPUT_USD_PER_MILLION": "2",
    "WASLA_CLOUD_SEARCH_USD_PER_CALL": "0.01", "WASLA_CLOUD_CONTEXT_TOKEN_LIMIT": "131072",
}


def messages(text="Write a poem"):
    return [{"role": "user", "content": text}]


def response(text="A small poem about trees.", web=False):
    output, annotations = [], []
    if web:
        output.append({"type": "web_search_call", "status": "completed", "action": {"type": "search", "sources": [
            {"type": "url", "url": "https://weather.gov/example", "title": "Weather bulletin"}]}})
        start = len(text)
        text += " [native citation]"
        annotations.append({"type": "url_citation", "start_index": start, "end_index": len(text),
                            "title": "Weather bulletin", "url": "https://weather.gov/example"})
    output.append({"type": "message", "role": "assistant", "status": "completed", "content": [
        {"type": "output_text", "text": text, "annotations": annotations}]})
    return {"model": FAKE_ENV["WASLA_CLOUD_MODEL"], "status": "completed", "output": output,
            "usage": {"input_tokens": 100, "output_tokens": 50}}


async def immediate_thread(function, *args, **kwargs):
    return function(*args, **kwargs)


def run(coroutine):
    # All I/O is replaced by a synchronous fake; no socket/event-loop required.
    with patch("wasla.cloud.asyncio.to_thread", new=immediate_thread):
        try:
            coroutine.send(None)
        except StopIteration as done:
            return done.value
        finally:
            coroutine.close()
    raise AssertionError("Offline cloud test unexpectedly suspended for I/O.")


class CloudTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="wasla-cloud-test-")
        self.root = Path(self.temporary.name)
        self.calls = []
        self.fake_response = response()
        self.now = [1800000000]

    def tearDown(self):
        self.temporary.cleanup()

    def transport(self, payload, key):
        self.calls.append((deepcopy(payload), key))
        # The reservation must be durable before any upstream call starts.
        self.assertTrue((self.root / "cloud-budget.json").exists())
        return deepcopy(self.fake_response)

    def engine(self, env=None, transport=None):
        return CloudIntelligence(self.root, environ=FAKE_ENV if env is None else env,
                                 transport=transport or self.transport, clock=lambda: self.now[0])

    def test_disabled_by_default_without_creating_budget_or_network(self):
        engine = self.engine({})
        self.assertFalse(engine.configured)
        self.assertFalse(engine.settings()["cloud_enabled"])
        with self.assertRaises(ServiceError) as error:
            run(engine.answer(messages()))
        self.assertEqual(error.exception.code, "cloud_not_configured")
        self.assertFalse(self.calls)
        self.assertFalse((self.root / "cloud-budget.json").exists())

    def test_every_configuration_field_is_explicit_and_valid(self):
        for missing in FAKE_ENV:
            env = dict(FAKE_ENV)
            del env[missing]
            with self.subTest(missing=missing):
                self.assertFalse(self.engine(env).configured)
        for key, value in [("WASLA_CLOUD_ENABLED", "true"), ("OPENAI_API_KEY", "bad\n" + "x" * 20),
                           ("OPENAI_API_KEY", "bad\x00" + "x" * 20), ("WASLA_CLOUD_MODEL", ""),
                           ("WASLA_CLOUD_DAILY_BUDGET_USD", "0"), ("WASLA_CLOUD_INPUT_USD_PER_MILLION", "nan"),
                           ("WASLA_CLOUD_OUTPUT_USD_PER_MILLION", "Infinity"), ("WASLA_CLOUD_SEARCH_USD_PER_CALL", "-1"),
                           ("WASLA_CLOUD_CONTEXT_TOKEN_LIMIT", "0")]:
            with self.subTest(key=key, value=value):
                self.assertFalse(self.engine({**FAKE_ENV, key: value}).configured)

    def test_local_mode_fails_before_reservation_and_transport(self):
        with self.assertRaises(ServiceError) as error:
            run(self.engine().answer(messages(), mode="local"))
        self.assertEqual(error.exception.code, "cloud_disallowed_in_local_mode")
        self.assertFalse(self.calls)
        self.assertFalse((self.root / "cloud-budget.json").exists())

    def test_text_request_is_bounded_stateless_and_has_no_tools(self):
        engine = self.engine()
        result = run(engine.answer(messages()))
        payload, key = self.calls[0]
        self.assertEqual(payload["model"], FAKE_ENV["WASLA_CLOUD_MODEL"])
        self.assertFalse(payload["store"])
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["max_output_tokens"], MAX_OUTPUT)
        self.assertLessEqual(MAX_OUTPUT, 1500)
        self.assertEqual(payload["tools"], [])
        self.assertEqual(payload["tool_choice"], "none")
        self.assertEqual(payload["service_tier"], "default")
        self.assertNotIn("previous_response_id", payload)
        self.assertEqual(result["route"], "cloud")
        self.assertEqual(result["usage"]["estimated_cost_usd"], .0002)
        self.assertEqual(result["evidence"]["level"], "unverified")
        self.assertGreater(engine.settings()["cloud_spent_usd"], 0)
        self.assertIn("not_invoice", engine.settings()["cloud_budget_basis"])

    def test_live_web_and_auto_recency_allow_exactly_one_search(self):
        self.fake_response = response("The forecast describes rain.", web=True)
        for query, mode in [("Tell me about rainfall", "live_web"), ("أخبار اليوم", "auto")]:
            with self.subTest(query=query):
                result = run(self.engine().answer(messages(query), mode=mode))
                payload = self.calls[-1][0]
                self.assertEqual(payload["max_tool_calls"], 1)
                self.assertEqual(payload["tools"], [{"type": "web_search", "search_context_size": "low"}])
                self.assertEqual(payload["include"], ["web_search_call.action.sources"])
                self.assertEqual(payload["tool_choice"], "required")
                self.assertEqual(result["usage"]["search_calls"], 1)
                self.assertIsNone(result["usage"]["estimated_cost_usd"])
                self.assertEqual(result["evidence"]["level"], "limited")
                self.assertFalse(result["evidence"]["independence_verified"])
                self.assertEqual(result["sources"][0]["url"], "https://weather.gov/example")
                self.assertIn("[S1]", result["content"])
                self.assertEqual(result["citations"][0]["source_id"], "S1")
                self.assertIsNone(result["sources"][0]["published_at"])

    def test_budget_is_reserved_before_request_and_reused_across_instances(self):
        first = self.engine()
        result = run(first.answer(messages()))
        reserved = result["usage"]["reserved_cost_usd"]
        second = self.engine({**FAKE_ENV, "WASLA_CLOUD_DAILY_BUDGET_USD": str(reserved)})
        with self.assertRaises(ServiceError) as error:
            run(second.answer(messages()))
        self.assertEqual(error.exception.code, "cloud_budget_exceeded")
        self.assertEqual(len(self.calls), 1)
        self.assertAlmostEqual(second.settings()["cloud_spent_usd"], reserved)

    def test_unknown_outcome_keeps_reserve_without_retry_or_private_storage(self):
        attempts = []
        def failed(payload, key):
            attempts.append(1)
            raise TimeoutError("provider body with secret must not propagate")
        engine = self.engine(transport=failed)
        with self.assertRaises(ServiceError) as error:
            run(engine.answer(messages("PRIVATE_SECRET_2369")))
        self.assertEqual(error.exception.code, "cloud_unknown_outcome")
        self.assertNotIn("provider body", str(error.exception))
        self.assertEqual(attempts, [1])
        self.assertGreater(engine.settings()["cloud_spent_usd"], 0)
        ledger = (self.root / "cloud-budget.json").read_text()
        self.assertNotIn("PRIVATE_SECRET", ledger)
        self.assertNotIn(FAKE_ENV["OPENAI_API_KEY"], ledger)
        self.assertEqual(set(json.loads(ledger)), {"version", "days"})

    def test_utc_day_rollover_does_not_erase_previous_reservation(self):
        engine = self.engine()
        run(engine.answer(messages()))
        self.now[0] += 86400
        self.assertEqual(engine.settings()["cloud_spent_usd"], 0)
        run(engine.answer(messages()))
        self.assertEqual(len(json.loads((self.root / "cloud-budget.json").read_text())["days"]), 2)

    def test_corrupted_budget_fails_closed(self):
        (self.root / "cloud-budget.json").write_text('{"version":1,"days":{"bad":{"reserved_usd":"NaN","requests":2}}}')
        engine = self.engine()
        self.assertFalse(engine.settings()["cloud_enabled"])
        with self.assertRaises(ServiceError) as error:
            run(engine.answer(messages()))
        self.assertEqual(error.exception.code, "cloud_budget_unavailable")
        self.assertFalse(self.calls)

    def test_input_over_declared_context_bound_never_sends(self):
        engine = self.engine({**FAKE_ENV, "WASLA_CLOUD_CONTEXT_TOKEN_LIMIT": "2048"})
        with self.assertRaises(ServiceError) as error:
            run(engine.answer(messages()))
        self.assertEqual(error.exception.code, "cloud_context_limit")
        self.assertFalse(self.calls)

    def test_unsupported_urls_and_citations_are_not_displayed(self):
        for bad in ["See https://invented.example/ for details.", "Read file:///private/data", "An invented citation [S99]."]:
            with self.subTest(bad=bad):
                self.fake_response = response(bad, web=True)
                result = run(self.engine().answer(messages("latest news")))
                self.assertNotIn("invented.example", result["content"])
                self.assertNotIn("file:///", result["content"])
                self.assertNotIn("S99", result["content"])
                self.assertEqual(result["evidence"]["level"], "unverified")
                self.assertIn("unsupported_links_rejected", result["warnings"])

    def test_missing_web_calls_or_citations_refuses_verification(self):
        self.fake_response = response("An unsourced statement.")
        result = run(self.engine().answer(messages("latest news")))
        self.assertEqual(result["evidence"]["level"], "unverified")
        self.assertIn("insufficient_web_citations", result["warnings"])
        self.assertNotIn("unsourced statement", result["content"])

    def test_private_or_unsafe_source_urls_are_not_returned(self):
        self.fake_response = response("A claimed source.", web=True)
        self.fake_response["output"][0]["action"]["sources"][0]["url"] = "https://127.0.0.1/private"
        self.fake_response["output"][1]["content"][0]["annotations"][0]["url"] = "https://127.0.0.1/private"
        result = run(self.engine().answer(messages("latest news")))
        self.assertEqual(result["sources"], [])
        self.assertEqual(result["evidence"]["level"], "unverified")

    def test_incomplete_wrong_model_and_excess_tool_calls_keep_reservation(self):
        invalid = [response(), response(), response(web=True)]
        invalid[0]["status"] = "incomplete"
        invalid[1]["model"] = "another-model"
        invalid[2]["output"].insert(0, deepcopy(invalid[2]["output"][0]))
        for item in invalid:
            with self.subTest(item=item["status"]):
                self.fake_response = item
                engine = self.engine()
                before = engine.settings()["cloud_spent_usd"]
                with self.assertRaises(ServiceError):
                    run(engine.answer(messages("latest news")))
                self.assertGreater(engine.settings()["cloud_spent_usd"], before)

    def test_reasoning_and_nonreported_usage_are_not_fabricated(self):
        self.fake_response["output"].insert(0, {"type": "reasoning", "summary": [{"text": "PRIVATE_REASONING_MARKER"}]})
        self.fake_response.pop("usage")
        result = run(self.engine().answer(messages()))
        self.assertNotIn("PRIVATE_REASONING_MARKER", json.dumps(result))
        self.assertIsNone(result["usage"]["input_tokens"])
        self.assertIsNone(result["usage"]["estimated_cost_usd"])

    def test_redirects_are_rejected(self):
        with self.assertRaises(ServiceError) as error:
            _NoRedirect().redirect_request(None, None, 302, "Redirect", {}, "https://attacker.example/")
        self.assertEqual(error.exception.code, "cloud_redirect_rejected")


if __name__ == "__main__":
    unittest.main()
