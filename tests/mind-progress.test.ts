import { describe, expect, it } from 'vitest';
import { createMind } from '../apps/server/src/assistant/mind/index.js';
import type { MindDeps } from '../apps/server/src/assistant/mind/contract.js';

const signal = () => new AbortController().signal;

function fakeDeps(pages: Record<string, string>, memory?: readonly string[]) {
  const steps: string[] = [], progress: string[] = [];
  const deps: MindDeps = {
    async read(url) {
      const text = pages[url] ?? '';
      return { url, status: text ? 200 : 404, text, html: `<html><body><p>${text}</p></body></html>`, headers: { 'content-type': 'text/html; charset=utf-8' } };
    },
    async search() { return Object.keys(pages).map(url => ({ title: 'Catalog entry', snippet: 'An entry about the house.', url })); },
    now: () => new Date('2026-03-11T10:25:00Z'),
    step: async label => { steps.push(label); },
    progress: async label => { progress.push(label); },
    ...(memory ? { memory: async () => memory } : {}),
  };
  return { deps, steps, progress };
}

describe('العقل يبلّغ مراحله الحقيقية', () => {
  it('records the search, then the batch of pages it reads, in that order', async () => {
    const { deps, steps } = fakeDeps({
      'https://gazette.archives.test/entry': 'Meadows House opened in 1934 after two years of building.',
      'https://mirror.archives.test/entry': 'Meadows House was opened in 1934.',
    });
    const reply = await createMind().handle('When did Meadows House open?', deps, signal());
    expect(reply.status).not.toBe('waiting_user');
    expect(steps[0]).toMatch(/^البحث عن «.+»$/u);
    expect(steps[1]).toBe('قراءة gazette.archives.test وmirror.archives.test');
  });

  it('shows that it is searching memory before a memory answer', async () => {
    const { deps, progress, steps } = fakeDeps({}, ['My home city is Bristol.']);
    await createMind().handle('From my memory, return my home city only.', deps, signal());
    expect(progress).toContain('يبحث في الذاكرة');
    expect(steps).toEqual([]);
  });
});
