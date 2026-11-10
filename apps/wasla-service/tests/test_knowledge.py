"""Opt-in storage tests against isolated temporary SQLite databases only."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import uuid

from wasla.knowledge import KnowledgeStore
from wasla.services import ServiceError


def messages(text="A private question"):
    return [{"role": "user", "content": text}]


def answer(content="A private answer", route="local", sources=None):
    return {"content": content, "model": "fake-local", "route": route,
            "sources": sources or [], "evidence": {"level": "limited", "note": "Only an extract."},
            "timing_ms": 25.5, "cache_hit": False,
            "usage": {"input_tokens": None, "output_tokens": None}}


def source():
    return {"id": "S1", "title": "Public source", "url": "https://example.com/source",
            "snippet": "A source extract that is not usage telemetry.", "published_at": None,
            "retrieved_at": "2026-01-02T03:04:05Z"}


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory(prefix="wasla-knowledge-test-")
        self.root = Path(self.temporary.name)
        self.owner = str(uuid.uuid4())
        # Explicit empty URL prevents an inherited production/PostgreSQL setting.
        self.store = KnowledgeStore(self.root, database_url="", owner_id=self.owner)

    def tearDown(self):
        self.temporary.cleanup()

    def rows(self, table):
        self.assertIn(table, {"conversations", "messages", "web_sources", "research_runs", "usage_metrics", "knowledge_documents"})
        with self.store.transaction() as db:
            return [dict(row) for row in db.execute("SELECT * FROM " + table).fetchall()]

    def second_owner(self):
        return KnowledgeStore(self.root, database_url="", owner_id=str(uuid.uuid4()))

    def test_memory_is_disabled_by_default_and_requires_boolean_setting(self):
        self.assertEqual(self.store.settings(), {"memory_enabled": False, "storage": "sqlite"})
        self.assertTrue(self.store.set_settings(True)["memory_enabled"])
        self.assertFalse(self.store.set_settings(False)["memory_enabled"])
        for invalid in [1, 0, "true", None, [], {}]:
            with self.subTest(invalid=invalid), self.assertRaises(ServiceError):
                self.store.set_settings(invalid)

    def test_no_content_is_saved_without_explicit_remember_true(self):
        # Even an enabled preference cannot make a false/missing request opt-in.
        self.store.set_settings(True)
        for remember in [False, None, 0, 1, "true"]:
            with self.subTest(remember=remember):
                result = self.store.save_exchange(messages(), answer(route="research", sources=[source()]), remember=remember)
                self.assertIsNone(result)
        self.assertIsNone(self.store.save_exchange(messages(), answer()))
        for table in ["conversations", "messages", "web_sources", "research_runs"]:
            self.assertEqual(self.rows(table), [])

    def test_opt_out_does_not_append_or_validate_an_unused_conversation_id(self):
        conversation_id = self.store.save_exchange(messages("First question"), answer("First answer"), remember=True)
        self.assertIsNone(self.store.save_exchange(messages("Not saved"), answer("Not saved"), remember=False, conversation_id=conversation_id))
        self.assertIsNone(self.store.save_exchange(messages(), answer(), remember=False, conversation_id="invalid"))
        self.assertEqual(len(self.store.conversation(conversation_id)["messages"]), 2)

    def test_explicit_save_retains_only_new_pair_in_stable_sequence(self):
        instant = "2026-01-02T03:04:05+00:00"
        with patch("wasla.knowledge.utcnow", return_value=instant):
            conversation_id = self.store.save_exchange(messages("First question"), answer("First answer"), remember=True)
            history = messages("First question") + [{"role": "assistant", "content": "First answer"}] + messages("Second question")
            self.assertEqual(self.store.save_exchange(history, answer("Second answer"), remember=True, conversation_id=conversation_id), conversation_id)
        saved = self.store.conversation(conversation_id)
        self.assertEqual([(row["role"], row["content"]) for row in saved["messages"]],
                         [("user", "First question"), ("assistant", "First answer"), ("user", "Second question"), ("assistant", "Second answer")])
        self.assertEqual([row["ordinal"] for row in self.rows("messages")], [1, 2, 3, 4])
        self.assertEqual(len({row["created_at"] for row in saved["messages"]}), 1)
        self.assertEqual(len(self.store.conversations()), 1)

    def test_valid_uuid_spellings_return_the_same_messages(self):
        conversation_id = self.store.save_exchange(messages(), answer(), remember=True)
        expected = self.store.conversation(conversation_id)
        for spelling in [conversation_id.upper(), "{" + conversation_id + "}"]:
            with self.subTest(spelling=spelling):
                self.assertEqual(self.store.conversation(spelling), expected)

    def test_owner_cannot_read_append_or_delete_another_owners_conversation(self):
        conversation_id = self.store.save_exchange(messages("Owner one private text"), answer(), remember=True)
        other = self.second_owner()
        self.assertEqual(other.conversations(), [])
        with self.assertRaises(ServiceError) as missing:
            other.conversation(conversation_id)
        self.assertEqual(missing.exception.status, 404)
        with self.assertRaises(ServiceError) as append:
            other.save_exchange(messages("Cross-owner write"), answer(), remember=True, conversation_id=conversation_id)
        self.assertEqual(append.exception.status, 404)
        self.assertFalse(other.delete_conversation(conversation_id)["deleted"])
        self.assertEqual(len(self.store.conversation(conversation_id)["messages"]), 2)
        self.assertEqual(other.conversations(), [])

    def test_owner_scopes_documents_settings_versions_and_metrics(self):
        private = self.store.add_document("Private project", "Only the first owner should retrieve this private project.")
        self.store.set_settings(True)
        self.store.record_usage(answer())
        other = self.second_owner()
        self.assertEqual(other.documents(), [])
        self.assertEqual(other.knowledge_lookup("device-two", "private project", 4), [])
        self.assertFalse(other.delete_document(private["id"])["deleted"])
        self.assertFalse(other.settings()["memory_enabled"])
        self.assertEqual(other.metrics()["requests"], 0)
        self.assertEqual(other.metrics()["memory_items"], 0)
        other.add_document("Second owner", "Separate private document")
        self.assertEqual(len(self.store.documents()), 1)
        self.assertEqual(self.store.documents()[0]["id"], private["id"])

    def test_paired_devices_share_installation_owned_knowledge(self):
        saved = self.store.add_document("Project preference", "The project preference is concise weekly updates.")
        one = self.store.knowledge_lookup("paired-iphone", "project preference", 4)
        two = self.store.knowledge_lookup("paired-browser", "project preference", 4)
        self.assertEqual(one, two)
        self.assertEqual(one[0]["id"], saved["id"])
        self.assertEqual(self.store.knowledge_version("paired-iphone"), self.store.knowledge_version("paired-browser"))

    def test_sources_and_research_runs_require_research_and_remember(self):
        self.store.save_exchange(messages(), answer(route="research", sources=[source()]), remember=False)
        self.store.save_exchange(messages(), answer(route="local", sources=[source()]), remember=True)
        self.store.save_exchange(messages(), answer(route="knowledge", sources=[source()]), remember=True)
        self.assertEqual(self.rows("web_sources"), [])
        self.assertEqual(self.rows("research_runs"), [])
        conversation_id = self.store.save_exchange(messages(), answer(route="research", sources=[source(), {"id": "K1", "title": "Personal note", "url": None}]), remember=True)
        sources, runs = self.rows("web_sources"), self.rows("research_runs")
        self.assertEqual(len(sources), 1)
        self.assertEqual(len(runs), 1)
        self.assertEqual(sources[0]["owner_id"], self.owner)
        self.assertEqual(sources[0]["conversation_id"], conversation_id)
        self.assertEqual(sources[0]["url"], source()["url"])
        self.assertIsNone(sources[0]["published_at"])
        self.assertEqual(sources[0]["retrieved_at"], source()["retrieved_at"])
        self.assertEqual(json.loads(runs[0]["evidence_json"])["level"], "limited")

    def test_deleting_conversation_cascades_its_messages_runs_and_sources(self):
        first = self.store.save_exchange(messages("Delete me"), answer(route="research", sources=[source()]), remember=True)
        retained = self.store.save_exchange(messages("Keep me"), answer(route="research", sources=[source()]), remember=True)
        self.store.record_usage(answer(route="research"))
        self.assertTrue(self.store.delete_conversation(first)["deleted"])
        self.assertFalse(self.store.delete_conversation(first)["deleted"])
        for table in ["messages", "web_sources", "research_runs"]:
            records = self.rows(table)
            self.assertTrue(records)
            self.assertTrue(all(row["conversation_id"] == retained for row in records))
        self.assertEqual(len(self.rows("messages")), 2)
        self.assertEqual(len(self.store.conversation(retained)["messages"]), 2)
        # Aggregate, content-free telemetry is separate from saved conversations.
        self.assertEqual(self.store.metrics()["requests"], 1)

    def test_partial_save_rolls_back_every_content_table(self):
        malformed_source = {"url": "https://example.com/missing-title"}
        with self.assertRaises(KeyError):
            self.store.save_exchange(messages(), answer(route="research", sources=[malformed_source]), remember=True)
        for table in ["conversations", "messages", "web_sources", "research_runs"]:
            self.assertEqual(self.rows(table), [])

    def test_arabic_lexical_lookup_normalizes_hamza_diacritics_and_alef_maqsura(self):
        saved = self.store.add_document("أَهدافُ المُشْرُوع", "خُطَّةُ المشروع لدى أحمد تتضمن إعدادَ تحديثاتٍ أسبوعية.")
        hits = self.store.knowledge_lookup("phone", "اهداف المشروع لدي احمد", 4)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["id"], saved["id"])
        self.assertNotIn("search_text", hits[0])
        self.assertEqual(self.store.knowledge_lookup("phone", "ما هو في من", 4), [])
        self.assertEqual(self.store.knowledge_lookup("phone", "unrelatedword", 4), [])

    def test_retrieval_is_bounded_and_ranks_matching_terms(self):
        best = self.store.add_document("Alpha beta", "Both alpha beta terms occur here.")
        for i in range(12):
            self.store.add_document("Alpha " + str(i), "Only alpha appears in this note.")
        hits = self.store.knowledge_lookup("phone", "alpha beta", 100)
        self.assertEqual(len(hits), 8)
        self.assertEqual(hits[0]["id"], best["id"])
        self.assertEqual(len(self.store.knowledge_lookup("phone", "alpha beta", 2)), 2)

    def test_document_changes_invalidate_the_knowledge_version(self):
        before = self.store.knowledge_version("phone")
        saved = self.store.add_document("One", "Some saved content")
        added = self.store.knowledge_version("phone")
        self.assertGreater(added, before)
        self.assertEqual(added, self.store.knowledge_version("browser"))
        self.assertTrue(self.store.delete_document(saved["id"])["deleted"])
        self.assertGreater(self.store.knowledge_version("phone"), added)

    def test_document_sizes_and_count_are_bounded(self):
        self.store.add_document("t" * 160, "c" * 20000)
        for title, content in [("t" * 161, "content"), ("title", "c" * 20001), ("", "content"), ("title", " "), ("title", "bad\x00content"), (None, "text")]:
            with self.subTest(title=str(title)[:20]), self.assertRaises(ServiceError):
                self.store.add_document(title, content)
        with self.store.transaction() as db:
            for i in range(499):
                db.execute("INSERT INTO knowledge_documents(id,owner_id,title,content,search_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                           (str(uuid.uuid4()), self.owner, "title", "content", "title content", "2026-01-01", "2026-01-01"))
        self.assertEqual(len(self.store.documents()), 500)
        with self.assertRaises(ServiceError) as full:
            self.store.add_document("Overflow", "This must not be inserted.")
        self.assertEqual(full.exception.code, "knowledge_full")
        self.assertEqual(len(self.store.documents()), 500)

    def test_usage_metrics_store_numbers_without_prompts_answers_or_sources(self):
        secret = "PRIVATE_PROMPT_MARKER_9348"
        response = answer(secret, route="research", sources=[{**source(), "snippet": secret}])
        response["evidence"]["note"] = secret
        response["prompt"] = secret
        self.store.record_usage(response)
        response = answer(secret, route="calculator")
        response["cache_hit"] = True
        response["timing_ms"] = 4.5
        self.store.record_usage(response)
        records = self.rows("usage_metrics")
        self.assertNotIn(secret, json.dumps(records))
        self.assertEqual(set(records[0]), {"id", "owner_id", "route", "latency_ms", "cache_hit", "input_tokens", "output_tokens", "estimated_cost_usd", "created_at"})
        self.assertIsNone(records[0]["input_tokens"])
        metrics = self.store.metrics()
        self.assertEqual(metrics["requests"], 2)
        self.assertEqual(metrics["web_requests"], 1)
        self.assertEqual(metrics["local_requests"], 1)
        self.assertEqual(metrics["cache_hits"], 1)
        self.assertEqual(metrics["latency_ms"], 15.0)
        self.assertEqual(self.rows("conversations"), [])

    def test_content_is_parameterized_and_invalid_identifiers_fail(self):
        literal = "Robert'); DROP TABLE knowledge_documents; --"
        saved = self.store.add_document(literal, literal)
        self.assertEqual(self.store.documents()[0]["content"], literal)
        self.assertTrue(self.store.delete_document(saved["id"])["deleted"])
        for operation in [self.store.conversation, self.store.delete_conversation, self.store.delete_document]:
            with self.assertRaises(ServiceError) as invalid:
                operation("' OR 1=1 --")
            self.assertEqual(invalid.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
