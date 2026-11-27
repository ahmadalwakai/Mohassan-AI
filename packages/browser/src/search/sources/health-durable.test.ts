import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createDatabase, migrate } from '@mohassan/database';
import { expect, it, vi } from 'vitest';
import { SafeNetwork, type SafeResponse } from '../../network.js';
import { SearchEngine } from '../engine.js';
import { migrateSearch, SqlSearchStore } from '../store.js';
import { healthProviders } from './health.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/health/${name}`, import.meta.url));

it('persists health sources in the signed-in search cache', async () => {
  const database = await createDatabase();
  try {
    await migrate(database.db);
    await migrateSearch(database.db);
    const now = () => Date.UTC(2026, 10, 27);
    const network = new SafeNetwork();
    const responses = new Map<string, Omit<SafeResponse, 'url'>>([
      ['www.who.int/robots.txt', {
        status: 200, headers: { 'content-type': 'text/plain' }, body: fixture('who-robots.txt'),
      }],
      ['www.who.int/sitemap/sitemap.gz', {
        status: 200, headers: { 'content-type': 'application/octet-stream' }, body: gzipSync(fixture('who-sitemap.xml')),
      }],
      ['www.who.int/news-room/fact-sheets/detail/asthma', {
        status: 200, headers: { 'content-type': 'text/html' }, body: fixture('who-asthma-en.html'),
      }],
      // The MedlinePlus web-service host returned 404 for robots.txt on 2026-11-27.
      ['wsearch.nlm.nih.gov/robots.txt', { status: 404, headers: {}, body: Buffer.alloc(0) }],
      ['wsearch.nlm.nih.gov/ws/query', {
        status: 200, headers: { 'content-type': 'text/xml' }, body: fixture('medlineplus-asthma.xml'),
      }],
    ]);
    const request = vi.spyOn(network, 'request').mockImplementation(async (url, options) => {
      options?.signal?.throwIfAborted();
      const target = new URL(url);
      const response = responses.get(target.hostname + target.pathname);
      if (!response) throw new Error(`Unexpected health fixture request to ${target.origin}${target.pathname}`);
      return { ...response, url };
    });
    const makeEngine = () => new SearchEngine(network, {
      providers: healthProviders(network, now),
      store: new SqlSearchStore(database.db, now),
      now,
    });
    const question = 'What are the symptoms of asthma?';
    const owner = { ownerId: 'health-search-owner' };
    const first = await makeEngine().execute(question, 5, undefined, owner);
    expect(first.freshness).toBe('fresh');
    expect(first.failures).toEqual([]);
    expect(first.hits).toHaveLength(2);
    expect(first.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        url: 'https://medlineplus.gov/asthma.html',
        snippet: expect.stringContaining('MedlinePlus, National Library of Medicine — '),
      }),
      expect.objectContaining({
        url: 'https://www.who.int/news-room/fact-sheets/detail/asthma',
        snippet: expect.stringContaining('World Health Organization · Published 2026-04-28 — '),
      }),
    ]));

    const callsBeforeCacheHit = request.mock.calls.length;
    const second = await makeEngine().execute(question, 5, undefined, owner);
    expect(second).toEqual({ ...first, freshness: 'cached' });
    expect(request).toHaveBeenCalledTimes(callsBeforeCacheHit);
  } finally {
    await database.close();
  }
});
