import { describe, expect, it } from 'vitest';
import type { AgentAction, AgentPage } from '@mohassan/browser';
import { runHands, webQuestion, type HandsIO, type HandsRead } from '../apps/server/src/assistant/hands.js';
import { nodeLatest, releaseQuestion } from '../apps/server/src/assistant/releases.js';

/** The text the page reader extracted from https://nodejs.org/dist/latest/ on 2026-11-22 (shortened). */
const LISTING = 'Index of /dist/latest/ ../ docs/ - - win-arm64/ - - win-x64/ - - SHASUMS256.txt.asc 11-Nov-2026 16:42 3.4 KB SHASUMS256.txt 11-Nov-2026 16:41 3.2 KB '
  + 'node-v26.13.1-aix-ppc64.tar.gz 11-Nov-2026 16:41 83 MB node-v26.13.1-arm64.msi 11-Nov-2026 16:41 33 MB node-v26.13.1-darwin-arm64.tar.gz 11-Nov-2026 16:41 58 MB '
  + 'node-v26.13.1-x64.msi 11-Nov-2026 16:43 35 MB';
const page = (url: string, text: string): AgentPage => ({
  id: url, url, title: 'Index of /dist/latest/', text, elements: [], signals: { captcha: false, password: false, otp: false, card: false },
  scroll: { top: 0, height: 1000, viewport: 800 }, hash: url, observedAt: '2026-11-22T07:10:00.000Z',
});
function io(reads: Record<string, HandsRead>, searched: string[]): HandsIO {
  return {
    page: async () => null,
    search: async query => { searched.push(query); return []; },
    read: async url => reads[url] ?? { kind: 'unreadable' },
    act: async (action: AgentAction) => page(action.text ?? 'https://none.example/', ''),
    prepare: async () => null,
    settle: async current => current,
    step: async () => {},
    pause: async () => {},
    approve: async () => {},
    hold: async () => {},
  };
}
const text = (outcome: Awaited<ReturnType<typeof runHands>>) => outcome.kind === 'done' ? outcome.text : '';
const FOLDER = 'https://nodejs.org/dist/latest/';

describe('latest-version questions from the official release page', () => {
  it('recognises the three real questions and leaves other subjects to the search', () => {
    // rq020, rq021, rq041 of artifacts/plan-2026-11-22/real-questions-v1.jsonl
    expect(releaseQuestion('ما هو آخر إصدار مستقر من Node.js؟')?.product).toBe('Node.js');
    expect(releaseQuestion('Node.js latest version')?.product).toBe('Node.js');
    expect(releaseQuestion('ابحث في الويب عن آخر إصدار مستقر من Node.js، افتح صفحة المصدر الرسمي، وأخبرني برقم الإصدار مع رابط المصدر')?.product).toBe('Node.js');
    expect(releaseQuestion('what is the latest version of node?')?.product).toBe('Node.js');
    expect(releaseQuestion('أحدث نسخة من نود')?.product).toBe('Node.js');
    expect(releaseQuestion('آخر إصدار من آيفون')).toBeNull();
    expect(releaseQuestion('latest version of node-sass')).toBeNull();
    expect(releaseQuestion('ما هو Node.js؟')).toBeNull();
    expect(releaseQuestion('latest news today')).toBeNull();
  });

  it('reads the version and its publication time from the folder listing', () => {
    expect(nodeLatest(LISTING)).toEqual({ version: 'v26.13.1', publishedAt: '2026-11-11T16:41:00.000Z' });
    // A folder that names two versions is not one release; a page without files states none.
    expect(nodeLatest(`${LISTING} node-v26.14.0-x64.msi 12-Nov-2026 09:00 35 MB`)).toBeNull();
    expect(nodeLatest('Index of /dist/latest/ ../ docs/')).toBeNull();
  });

  it('answers from the official page without searching, in the owner’s language, with the page and its read time', async () => {
    const searched: string[] = [];
    const arabic = await runHands({ steps: webQuestion('ما هو آخر إصدار مستقر من Node.js؟')!, next: 0, lang: 'ar' }, io({ [FOLDER]: { kind: 'page', page: page(FOLDER, LISTING) } }, searched));
    expect(searched).toEqual([]);
    expect(arabic).toMatchObject({ kind: 'done', status: 'completed' });
    expect(text(arabic).split('\n')[0]).toBe('آخر إصدار مستقر من Node.js هو v26.13.1، ونُشرت ملفاته في موقع Node.js الرسمي يوم 2026-11-11 الساعة 16:41 UTC.');
    expect(text(arabic)).toContain(`](${FOLDER}) · قُرئت 2026-11-22 07:10 UTC`);
    expect(text(arabic)).toContain('**للمزيد:** [صفحة إصدارات Node.js وخطوط الدعم](https://nodejs.org/en/about/previous-releases)');
    // The product's own page is the primary source: no «not checked in a second source» line.
    expect(text(arabic)).not.toContain('لم أتحقق');
    const english = await runHands({ steps: webQuestion('Node.js latest version')!, next: 0, lang: 'en' }, io({ [FOLDER]: { kind: 'page', page: page(FOLDER, LISTING) } }, searched));
    expect(text(english).split('\n')[0]).toBe('The latest stable Node.js release is v26.13.1; its files were published on the official Node.js site on 2026-11-11 at 16:41 UTC.');
    expect(text(english)).toContain('**Source:**');
  });

  it('falls back to the general search when the official page is unreadable or states no version', async () => {
    for (const read of [{ kind: 'disallowed' } as const, { kind: 'page', page: page(FOLDER, 'Index of /dist/latest/ ../ docs/') } as const]) {
      const searched: string[] = [];
      await runHands({ steps: webQuestion('ما هو آخر إصدار مستقر من Node.js؟')!, next: 0, lang: 'ar' }, io({ [FOLDER]: read }, searched));
      expect(searched).toEqual(['ما هو آخر إصدار مستقر من Node.js']);
    }
  });
});
