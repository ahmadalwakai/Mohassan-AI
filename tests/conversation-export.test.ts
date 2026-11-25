import { createPdfRenderer } from '@mohassan/pdf';
import type { ConversationSnapshot } from '@mohassan/contracts';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { renderConversationMarkdown, renderConversationPdf } from '../apps/server/src/conversation-export.ts';

// example.com is reserved for examples by RFC 2606 §3 (retrieved 2026-11-25).
// https://www.rfc-editor.org/rfc/rfc2606.html#section-3
const sources = [
  { title: 'التقرير الرسمي', url: 'https://example.com/report_(2026)?lang=ar&view=summary' },
  { title: 'صفحة المساعدة', url: 'https://example.com/help' },
];
const snapshot: ConversationSnapshot = {
  title: 'ملخص المحادثة',
  createdAt: '2026-11-25T09:00:00.000Z',
  messages: [
    { role: 'user', text: 'السؤال الأول عن المبيعات.', createdAt: '2026-11-25T09:00:01.000Z', sources: [] },
    { role: 'assistant', text: 'الجواب الأول: النمو جيد.', createdAt: '2026-11-25T09:00:02.000Z', sources: [sources[0]!] },
    { role: 'user', text: 'السؤال الثاني عن الترتيب.', createdAt: '2026-11-25T09:00:03.000Z', sources: [] },
    { role: 'assistant', text: 'الجواب الثاني عن العناوين.', createdAt: '2026-11-25T09:00:04.000Z', sources: [sources[1]!] },
  ],
};

describe('conversation export', () => {
  it('writes RTL Markdown with every timestamp and sources under the corresponding answers', () => {
    const markdown = renderConversationMarkdown(snapshot);
    const [heading, ...turns] = markdown.split(/^## /mu);
    expect(heading).toContain('<div lang="ar" dir="rtl">');
    expect(heading).toContain(`# ${snapshot.title}`);
    expect(heading).toContain(snapshot.createdAt);
    expect(turns).toHaveLength(snapshot.messages.length);
    for (const [index, message] of snapshot.messages.entries()) {
      const turn = turns[index]!;
      expect(turn).toContain(message.text);
      expect(turn).toContain(message.createdAt);
      expect([...turn.matchAll(/^- \[(.+)\]\(<([^>]+)>\)$/gmu)].map(([, title, url]) => ({ title, url }))).toEqual(message.sources);
    }
  });

  it('treats HTML and image syntax as text and excludes unsafe source destinations', () => {
    const markdown = renderConversationMarkdown({ ...snapshot, messages: [{
      ...snapshot.messages[1]!,
      text: '<script>body</script>\n![asset](https://example.com/asset)',
      sources: [{ title: 'invalid', url: 'javascript:alert(1)' }],
    }] });
    expect(markdown).toContain('&lt;script>body&lt;/script>');
    expect(markdown).toContain('\\![asset]');
    expect(markdown).not.toContain('javascript:');
  });

  it('extracts complete Arabic lines in reading order from the rendered PDF and embeds the source links', async () => {
    const renderer = createPdfRenderer();
    try {
      const bytes = await renderConversationPdf(snapshot, renderer);
      const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, verbosity: 0 });
      try {
        const pdf = await loading.promise;
        expect(pdf.numPages).toBe(1);
        const page = await pdf.getPage(1);
        const content = await page.getTextContent();
        // PDF page coordinates have y increasing upward. Sort lines top to bottom, then PDF.js's
        // already bidi-processed runs on each Arabic line from right to left. ISO 32000-1 §8.3.2.3,
        // retrieved 2026-11-25: https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
        const lines = new Map<number, { x: number; text: string }[]>();
        for (const item of content.items) {
          if (!('str' in item) || !item.str) continue;
          const [, , , , x, y] = item.transform;
          const line = lines.get(y) ?? [];
          line.push({ x, text: item.str });
          lines.set(y, line);
        }
        const extracted = [...lines.entries()].sort(([a], [b]) => b - a).map(([, line]) =>
          line.sort((a, b) => b.x - a.x).map(run => run.text).join('').normalize('NFKC'));
        const expectedText = [snapshot.title, ...snapshot.messages.flatMap(message => [message.text, ...message.sources.map(source => source.title)])];
        expect(extracted.filter(line => expectedText.includes(line))).toEqual(expectedText);
        for (const message of snapshot.messages) expect(extracted).toContain(message.createdAt);
        const annots = await page.getAnnotations();
        expect(annots.filter(item => item.subtype === 'Link').map(item => item.url)).toEqual(sources.map(source => source.url));
      } finally {
        await loading.destroy();
      }
    } finally {
      await renderer.close();
    }
  });
});
