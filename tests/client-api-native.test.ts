import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { nativeCalls } from '../scripts/client-api/native.js';

const root = resolve(import.meta.dirname, '..');

it('extracts paired-device Android requests and resolves the dynamic chat actions', () => {
  const android = nativeCalls(root).filter(call => call.client === 'Android');
  expect(android).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', path: '/v1/pair', transport: 'external', auth: 'anonymous' }),
    expect.objectContaining({ method: 'POST', path: '/v1/mohassan/conversations/:id/respond', transport: 'external', auth: 'owner' }),
    expect.objectContaining({ method: 'GET', path: '/v1/images/:request_id/content', transport: 'external', auth: 'owner' }),
  ]));
  expect(android.every(call => call.path.startsWith('/v1/') && !call.path.endsWith('/:action'))).toBe(true);
});

it('resolves the iOS pending chat, screenshot, and monitor paths from the read-only source ref', () => {
  const ios = nativeCalls(root).filter(call => call.client === 'iOS');
  expect(ios).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', path: '/api/chat/conversations/:id/messages' }),
    expect.objectContaining({ method: 'GET', path: '/api/chat/conversations/:id/screen' }),
    expect.objectContaining({ method: 'POST', path: '/api/chat/monitors/:id/pause' }),
    expect.objectContaining({ method: 'DELETE', path: '/api/push/devices/:token' }),
  ]));
  expect(ios.every(call => call.path.startsWith('/api/') && /^[a-f0-9]{40}$/.test(call.ref ?? ''))).toBe(true);
});
