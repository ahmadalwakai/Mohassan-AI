from wasla.intelligence import Intelligence, compare_evidence, research_queries, _near_copy
from test_intelligence import FakeServices, OfflineAsyncCase, message


class EvidenceTests(OfflineAsyncCase):
    async def test_numeric_difference_survives_deduplication_and_is_not_proof(self):
        left = 'The observed population count for the same city in the same reporting period was 12000 residents.'
        right = left.replace('12000', '15000')
        self.assertFalse(_near_copy(left, right))
        result = compare_evidence([{'id': 'S1', 'snippet': left}, {'id': 'S2', 'snippet': right}])
        self.assertEqual(result['potential_conflicts'][0]['source_ids'], ['S1', 'S2'])
        self.assertFalse(result['contradictions_checked'])
        self.assertEqual(result['source_independence'], 'not_established')
        self.assertEqual(compare_evidence([{'id': 'S1', 'snippet': left}, {'id': 'S2', 'snippet': 'The battery needs 6 hours to charge.'}])['potential_conflicts'], [])

    async def test_plain_memory_lookup_avoids_model_but_writing_can_use_it(self):
        services = FakeServices()
        engine = Intelligence(services, knowledge_lookup=lambda *args: [{'id': 'note', 'title': 'Review', 'content': 'The project review is at three oclock.'}])
        response = await engine.answer(message('When is the project review?'), device_id='one', use_memory=True)
        self.assertEqual(response['model'], 'local-retrieval')
        self.assertEqual(response['usage']['model_calls'], 0)
        self.assertFalse(services.chats)
        await engine.answer(message('Draft a review update'), device_id='one', use_memory=True)
        self.assertEqual(len(services.chats), 1)

    async def test_mixed_language_query_keeps_original_and_only_one_fallback(self):
        original = 'ابحث عن وثائق Tailscale لتوصيل iPhone بكمبيوتر Windows'
        self.assertEqual(research_queries(original), [original, 'Tailscale iPhone Windows documentation'])
        self.assertEqual(research_queries('ما معنى Windows؟'), ['ما معنى Windows؟'])

    async def test_document_search_returns_sources_without_unnecessary_model(self):
        services = FakeServices()
        response = await Intelligence(services).answer(message('Find official documentation'), device_id='one')
        self.assertEqual(response['route'], 'research')
        self.assertEqual(response['model'], 'web-retrieval')
        self.assertEqual(response['evidence']['level'], 'limited')
        self.assertTrue(response['sources'])
        self.assertFalse(services.chats)
