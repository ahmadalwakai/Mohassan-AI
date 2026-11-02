import asyncio
from pathlib import Path
import tempfile
import time
import unittest

from aiohttp.test_utils import TestClient, TestServer
from wasla.security import AuthStore
from wasla.server import STATE, create_app


class FakeServices:
    busy = None
    def __init__(self):
        self.generations = 0
        self.release = asyncio.Event()
    async def close(self):
        self.release.set()
    async def chat(self, messages):
        return {'content': 'answer', 'model': 'test'}
    async def prepare_image(self, description, style):
        return {'prompt': description, 'negative_prompt': '', 'seed': 1}
    async def generate_image(self, **data):
        self.generations += 1
        await self.release.wait()
        return {'status': 'failed', 'error': 'Test terminal failure'}
    async def image_status(self, request_id):
        return {'status': 'not_found'}
    async def search(self, query):
        return {'query': query, 'results': [], 'provider': 'test'}


class FakeDesktop:
    def __init__(self):
        self.inputs = []
    def info(self):
        return {'width': 1920, 'height': 1200, 'monitor': 'primary'}
    def capture(self):
        return b'jpeg-test'
    def input(self, command):
        self.inputs.append(command)
        return {'ok': True}


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = AuthStore(Path(self.temp.name) / 'state')
        self.services, self.desktop = FakeServices(), FakeDesktop()
        self.app = create_app(self.store, self.services, self.desktop, desktop_enabled=True)
        self.client = TestClient(TestServer(self.app))
        await self.client.start_server()
        self.headers, self.device = await self.enroll('test-phone')

    async def enroll(self, name):
        code = self.store.create_pairing_code()
        response = await self.client.post('/v1/pair', json={'code': code, 'device_name': name})
        self.assertEqual(response.status, 200)
        data = await response.json()
        return {'Authorization': 'Bearer ' + data['token']}, data['device_id']

    async def asyncTearDown(self):
        self.services.release.set()
        await self.client.close()
        self.temp.cleanup()

    async def test_auth_required_for_every_capability(self):
        for path in ['/v1/status', '/v1/desktop/frame', '/v1/images/abcdefgh/content']:
            response = await self.client.get(path)
            self.assertEqual(response.status, 401)
        response = await self.client.get('/v1/status', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')

    async def test_cross_origin_query_tokens_and_unknown_fields_rejected(self):
        response = await self.client.get('/v1/status', headers={**self.headers, 'Origin': 'https://evil.example'})
        self.assertEqual(response.status, 403)
        response = await self.client.get('/v1/status?token=secret', headers=self.headers)
        self.assertEqual(response.status, 400)
        response = await self.client.post('/v1/chat', headers=self.headers, json={'messages': [], 'command': 'bad'})
        self.assertEqual(response.status, 400)
        response = await self.client.post('/v1/chat', headers=self.headers, json={'messages': 'x' * 70000})
        self.assertEqual(response.status, 413)

    async def test_desktop_requires_enabled_lease_and_ends(self):
        response = await self.client.get('/v1/desktop/frame', headers=self.headers)
        self.assertEqual(response.status, 403)
        self.app[STATE].desktop_enabled = False
        response = await self.client.post('/v1/desktop/session', headers=self.headers, json={})
        self.assertEqual(response.status, 403)
        self.app[STATE].desktop_enabled = True
        response = await self.client.post('/v1/desktop/session', headers=self.headers, json={})
        lease = await response.json()
        headers = {**self.headers, 'X-Wasla-Session': lease['session_id']}
        response = await self.client.get('/v1/desktop/frame', headers=headers)
        self.assertEqual(await response.read(), b'jpeg-test')
        response = await self.client.post('/v1/desktop/input', headers=headers, json={'action': 'text', 'text': 'hello'})
        self.assertEqual(response.status, 200)
        response = await self.client.delete('/v1/desktop/session', headers=headers)
        self.assertEqual(response.status, 200)
        response = await self.client.get('/v1/desktop/frame', headers=headers)
        self.assertEqual(response.status, 403)

    async def test_desktop_owner_expiry_and_local_revocation(self):
        response = await self.client.post('/v1/desktop/session', headers=self.headers, json={})
        lease = await response.json()
        other, _ = await self.enroll('second-phone')
        response = await self.client.post('/v1/desktop/session', headers=other, json={})
        self.assertEqual(response.status, 409)
        response = await self.client.get('/v1/desktop/frame', headers={**other, 'X-Wasla-Session': lease['session_id']})
        self.assertEqual(response.status, 403)
        headers = {**self.headers, 'X-Wasla-Session': lease['session_id']}
        self.app[STATE].lease['expires_at'] = time.time() - 1
        response = await self.client.get('/v1/desktop/frame', headers=headers)
        self.assertEqual(response.status, 403)
        self.store.revoke(self.device)
        response = await self.client.post('/v1/desktop/input', headers=headers, json={'action': 'click', 'button': 'left'})
        self.assertEqual(response.status, 401)
        self.assertEqual(self.desktop.inputs, [])

    async def test_image_idempotency_conflict_ownership_and_no_terminal_retry(self):
        data = {'request_id': 'wasla-test-001', 'prompt': 'a tree', 'negative_prompt': '', 'seed': 1}
        response = await self.client.post('/v1/images', headers=self.headers, json=data)
        self.assertEqual(response.status, 202)
        response = await self.client.post('/v1/images', headers=self.headers, json=data)
        self.assertEqual(response.status, 200)
        response = await self.client.post('/v1/images', headers=self.headers, json={**data, 'seed': 2})
        self.assertEqual(response.status, 409)
        other, _ = await self.enroll('second-phone')
        response = await self.client.get('/v1/images/wasla-test-001', headers=other)
        self.assertEqual(response.status, 404)
        self.services.release.set()
        await asyncio.gather(*self.app[STATE].workers)
        response = await self.client.get('/v1/images/wasla-test-001', headers=self.headers)
        self.assertEqual((await response.json())['status'], 'failed')
        response = await self.client.post('/v1/images', headers=self.headers, json=data)
        self.assertEqual((await response.json())['status'], 'failed')
        self.assertEqual(self.services.generations, 1)

    async def test_session_revoke(self):
        response = await self.client.delete('/v1/session', headers=self.headers)
        self.assertEqual(response.status, 200)
        response = await self.client.get('/v1/status', headers=self.headers)
        self.assertEqual(response.status, 401)


if __name__ == '__main__':
    unittest.main()
