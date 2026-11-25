import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBrowser, observedLayout } from '@mohassan/browser';
import { expect, it } from 'vitest';
import { quoteCandidates } from '../apps/server/src/assistant/selection/ranker.js';

it('retains visible list and table evidence from the actual browser observation', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Compost</title><main><h1>Compost</h1><p>Compost is decomposed organic material.</p><h2>Preparation</h2><ol><li>Mix dry leaves with food scraps.</li><li hidden>Hidden instructions.</li></ol><table><tr><th>Material</th><td>Dry leaves</td></tr></table></main>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing browser fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  const profileDir = await mkdtemp(join(tmpdir(), 'mohassan-answer-browser-'));
  const browser = new AgentBrowser({ profileDir, testOrigins: [origin], allowedOrigins: [origin], channel: null, headless: true });
  try {
    const { page } = await browser.act('fixture-owner', 'answer-layout', { kind: 'open', text: origin }, {
      signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {},
    });
    expect(observedLayout(page)).toEqual([
      { kind: 'paragraph', heading: 'Compost', text: 'Compost is decomposed organic material.' },
      { kind: 'list', heading: 'Preparation', text: 'Mix dry leaves with food scraps.' },
      { kind: 'table', heading: 'Preparation', text: 'Material Dry leaves', cells: ['Material', 'Dry leaves'] },
    ]);
    expect(quoteCandidates(page).map(({ kind, text }) => [kind, text])).toContainEqual(['table', 'Material Dry leaves']);
    expect(JSON.stringify(page)).not.toContain('"layout"');
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profileDir, { recursive: true, force: true });
  }
});
