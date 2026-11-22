import { describe, expect, it } from 'vitest';
import { DocumentSpecSchema, detectLang, parseDocumentText, renderDocumentHtml, watermarkHtml } from './html.ts';

describe('parseDocumentText', () => {
  it('reads headings, lists with Arabic digits, quotes, tables, pairs, code and breaks exactly as typed', () => {
    const blocks = parseDocumentText([
      '# المقدمة', 'سطر أول', 'سطر ثانٍ في نفس الفقرة', '', '- بند أ', '- بند ب', '', '١. أولًا', '٢. ثانيًا', '', '> اقتباس', '> يتبع',
      '| البند | السعر |', '|---|---|', '| ورق | 10 |', '| حبر | 25 |', '', 'الاسم: أحمد', 'الهاتف: 0501234567', '', '```', 'const x = 1;', '```', '---', '===', 'الخاتمة.',
    ].join('\n'));
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'المقدمة' },
      { kind: 'paragraph', text: 'سطر أول\nسطر ثانٍ في نفس الفقرة' },
      { kind: 'bullets', items: ['بند أ', 'بند ب'] },
      { kind: 'numbered', items: ['أولًا', 'ثانيًا'] },
      { kind: 'quote', text: 'اقتباس\nيتبع' },
      { kind: 'table', header: ['البند', 'السعر'], rows: [['ورق', '10'], ['حبر', '25']] },
      { kind: 'keyvalue', items: [{ key: 'الاسم', value: 'أحمد' }, { key: 'الهاتف', value: '0501234567' }] },
      { kind: 'code', text: 'const x = 1;' },
      { kind: 'divider' },
      { kind: 'pagebreak' },
      { kind: 'paragraph', text: 'الخاتمة.' },
    ]);
  });

  it('keeps a single «key: value» line and English sentences as paragraphs', () => {
    expect(parseDocumentText('Note: delivery is late.\n\nSecond paragraph.')).toEqual([
      { kind: 'paragraph', text: 'Note: delivery is late.' }, { kind: 'paragraph', text: 'Second paragraph.' },
    ]);
    expect(parseDocumentText('   \n\n')).toEqual([]);
  });
});

describe('renderDocumentHtml', () => {
  it('escapes everything the owner typed and applies bold only after escaping', () => {
    const { html, lang } = renderDocumentHtml({ title: 'تقرير <script>alert(1)</script>', blocks: [{ kind: 'paragraph', text: 'نص **مهم** جدًا في هذا المستند التجريبي و <img src=x onerror=alert(1)>' }] });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<strong>مهم</strong>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'');
    expect(lang).toBe('ar');
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  it('chooses direction from the text, the theme from the spec and labels the footer in the document language', () => {
    const arabic = renderDocumentHtml({ title: 'عرض سعر', theme: 'invoice', blocks: [] });
    expect(arabic.theme).toBe('invoice');
    expect(arabic.html).toContain('class="theme-invoice"');
    expect(arabic.print.footerTemplate).toContain('<span class="pageNumber"></span> / <span class="totalPages"></span>');
    expect(arabic.print.footerTemplate).not.toContain('صفحة');
    expect(renderDocumentHtml({ title: 'x', footer: 'شركة النور', blocks: [] }).print.footerTemplate).toContain('<span>شركة النور</span>');
    const english = renderDocumentHtml({ title: 'Quarterly report', theme: 'report', accent: '#aa0000', pageNumbers: false, orientation: 'landscape', pageSize: 'Letter', blocks: [{ kind: 'heading', level: 2, text: 'Summary' }] });
    expect(english.lang).toBe('en');
    expect(english.html).toContain('<html lang="en" dir="ltr">');
    expect(english.html).toContain('--accent: #aa0000');
    expect(english.html).toContain('<h3 dir="auto">Summary</h3>');
    expect(english.print).toMatchObject({ format: 'Letter', landscape: true, displayHeaderFooter: true });
    expect(english.print.footerTemplate).not.toContain('pageNumber');
  });

  it('renders every block kind and pads short table rows', () => {
    const { html } = renderDocumentHtml({ title: 'كل الأنواع', blocks: [
      { kind: 'bullets', items: ['أ'] }, { kind: 'numbered', items: ['١'] }, { kind: 'quote', text: 'ق' }, { kind: 'code', text: '<b>' },
      { kind: 'table', header: ['أ', 'ب', 'ج'], rows: [['1']] }, { kind: 'keyvalue', items: [{ key: 'k', value: 'v' }] }, { kind: 'divider' }, { kind: 'pagebreak' },
    ] });
    for (const tag of ['<ul>', '<ol>', '<blockquote', '<pre>&lt;b&gt;</pre>', '<thead>', 'class="kv"', '<hr>', 'class="page-break"']) expect(html).toContain(tag);
    expect(html).toContain('<tbody><tr><td dir="auto">1</td><td dir="auto"></td><td dir="auto"></td></tr></tbody>');
  });

  it('rejects unknown keys and oversized text through the schema', () => {
    expect(() => DocumentSpecSchema.parse({ title: 'x', blocks: [], extra: 1 })).toThrow();
    expect(() => renderDocumentHtml({ title: 'x', blocks: [{ kind: 'paragraph', text: 'a'.repeat(60_001) }] })).toThrow();
    expect(() => renderDocumentHtml({ title: 'x', accent: 'red', blocks: [] })).toThrow();
  });
});

describe('detectLang and watermarkHtml', () => {
  it('prefers Arabic on a tie and English only when no Arabic letters exist', () => {
    expect(detectLang('تقرير Report')).toBe('ar');
    expect(detectLang('Report 2026')).toBe('en');
    expect(detectLang('Quarterly report for the sales team (مبيعات)')).toBe('en');
    expect(detectLang('123')).toBe('ar');
  });
  it('escapes the watermark text and clamps its style', () => {
    const html = watermarkHtml('<سري>', { opacity: 5, angle: 400, color: 'javascript:alert(1)' });
    expect(html).toContain('&lt;سري&gt;');
    expect(html).toContain('opacity: 1;');
    expect(html).toContain('rotate(90deg)');
    expect(html).toContain('color: #7a8699');
    expect(html).toContain('dir="rtl"');
  });
});
