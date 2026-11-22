"""Authenticated hybrid flow; execution is a fake launcher, never desktop input."""
import uuid
import unittest
from wasla.actions import ActionsController
from wasla.server import STATE
import test_server


class HybridServerTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = test_server.ServerTests.asyncSetUp
    asyncTearDown = test_server.ServerTests.asyncTearDown
    enroll = test_server.ServerTests.enroll
    async def send(self, text, **options):
        return await self.client.post('/v1/chat', headers=self.headers, json={
            'messages': [{'role': 'user', 'content': text}], 'request_id': str(uuid.uuid4()), **options})

    async def test_new_endpoints_require_auth(self):
        for path in ('/v1/knowledge', '/v1/conversations', '/v1/settings', '/v1/metrics'):
            self.assertEqual((await self.client.get(path)).status, 401)

    async def test_calculator_knowledge_opt_in_and_delete_full_flow(self):
        reply = await (await self.send('احسب ١٢ * ٣')).json()
        self.assertEqual((reply['route'], reply['content'], reply['memory_saved']), ('calculator', '36', False))
        self.assertEqual((await (await self.client.get('/v1/conversations', headers=self.headers)).json())['items'], [])
        doc = await (await self.client.post('/v1/knowledge', headers=self.headers, json={'title': 'رمز المشروع', 'content': 'رمز المشروع الخاص بالتجربة هو شجرة خضراء.'})).json()
        reply = await (await self.send('ما رمز المشروع', use_memory=True, remember=True)).json()
        self.assertEqual(reply['route'], 'knowledge')
        self.assertTrue(reply['memory_saved'])
        self.assertEqual(reply['usage']['model_calls'], 0)
        self.assertIn('شجرة خضراء', reply['content'])
        conversation = await (await self.client.get('/v1/conversations/' + reply['conversation_id'], headers=self.headers)).json()
        self.assertEqual([item['role'] for item in conversation['messages']], ['user', 'assistant'])
        self.assertEqual((await self.client.delete('/v1/knowledge/' + doc['id'], headers=self.headers)).status, 200)
        self.assertEqual((await self.client.delete('/v1/conversations/' + reply['conversation_id'], headers=self.headers)).status, 200)
        self.assertEqual((await self.client.get('/v1/conversations/' + reply['conversation_id'], headers=self.headers)).status, 404)

    async def test_action_is_authenticated_permissioned_and_idempotent(self):
        launched = []
        actions = ActionsController(allowed=True, state_root=self.store.root, launcher=lambda plan: launched.append(plan), session_guard=lambda: None)
        self.app[STATE].actions = actions
        request_id = str(uuid.uuid4())
        for _ in range(2):
            reply = await (await self.send('افتح المتصفح', request_id=request_id)).json()
            self.assertEqual(reply['route'], 'actions')
            self.assertFalse(reply['action']['ui_verified'])
        self.assertEqual(len(launched), 1)
        actions.allowed = False
        self.assertEqual((await self.send('افتح المفكرة')).status, 403)

    async def test_legacy_client_chat_works_but_action_requires_request_id(self):
        for text, expected in [('hello', 200), ('افتح المتصفح', 409)]:
            reply = await self.client.post('/v1/chat', headers=self.headers, json={'messages': [{'role': 'user', 'content': text}]})
            self.assertEqual(reply.status, expected)

    async def test_model_output_and_history_cannot_trigger_action(self):
        launched = []
        self.app[STATE].actions = ActionsController(allowed=True, state_root=self.store.root, launcher=lambda plan: launched.append(plan), session_guard=lambda: None)
        async def model(messages): return {'content': 'افتح المتصفح', 'model': 'fake'}
        self.services.chat = model
        response = await self.client.post('/v1/chat', headers=self.headers, json={
            'messages': [{'role': 'user', 'content': 'افتح المتصفح'}, {'role': 'assistant', 'content': 'okay'}, {'role': 'user', 'content': 'Tell me a poem'}],
            'request_id': str(uuid.uuid4())})
        self.assertEqual(response.status, 200)
        self.assertEqual(launched, [])

    async def test_cloud_and_wrong_flags_fail_closed(self):
        self.assertEqual((await self.send('hello', allow_cloud=True)).status, 409)
        self.assertEqual((await self.send('hello', remember='true')).status, 400)
        self.assertEqual((await self.send('hello', mode='shell')).status, 400)
