import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, plainText, shortLink } from '../apps/web/components/markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('chat reply links with brackets and dividing lines', () => {
  it('keeps a bracket inside a link\'s address, as Wikipedia titles have', () => {
    // Production on 2026-11-23: «للمزيد: القصير (مصر))» linked to …/القصير_(مصر and left a stray «)».
    const reply = '**للمزيد:** [القصير (مصر)](https://ar.wikipedia.org/wiki/القصير_(مصر)) · [عرب](https://ar.wikipedia.org/wiki/عرب)';
    const rendered = html(reply);
    expect(rendered).toContain('href="https://ar.wikipedia.org/wiki/القصير_(مصر)"');
    expect(rendered).toContain('>القصير (مصر)</a> · <a');
    expect(rendered).not.toContain('</a>)');
    expect(plainText(reply)).toBe('للمزيد: القصير (مصر) (https://ar.wikipedia.org/wiki/القصير_(مصر)) · عرب (https://ar.wikipedia.org/wiki/عرب)');
  });

  it('ends a link at its own bracket when the sentence around it is in brackets', () => {
    const rendered = html('(انظر [المصدر](https://example.org/page)) ثم أكمل، أو https://example.org/wiki/Mercury_(planet).');
    expect(rendered).toContain('<a href="https://example.org/page" target="_blank" rel="noopener noreferrer">المصدر</a>) ثم أكمل');
    expect(rendered).toContain('href="https://example.org/wiki/Mercury_(planet)"');
    expect(rendered).toContain('</a>.</p>');
  });

  it('draws «---» as a dividing line, not as text, and drops it from the copied text', () => {
    // The planner, letter and PDF replies end with «---» before their note; production showed it as three dashes.
    const reply = 'مع التحية،\nمدير المكتب\n\n---\nهذه مسودة من قالب.';
    const rendered = html(reply);
    expect(rendered).toContain('<hr/>');
    expect(rendered).not.toContain('---');
    expect(rendered).toContain('<p dir="auto">هذه مسودة من قالب.</p>');
    expect(plainText(reply)).toBe('مع التحية،\nمدير المكتب\n\nهذه مسودة من قالب.');
  });
});

describe('chat reply copy and links', () => {
  it('copies a reply as plain text with readable links', () => {
    const text = 'تجاوز عدد سكان مصر 106,556,174.\n\n**تفاصيل أخرى:**\n- سطر\n\n**المصدر:** [ويكيبيديا — التركيبة السكانية في مصر](https://ar.wikipedia.org/wiki/x)\n\n> مقتبس';
    expect(plainText(text)).toBe('تجاوز عدد سكان مصر 106,556,174.\n\nتفاصيل أخرى:\n- سطر\n\nالمصدر: ويكيبيديا — التركيبة السكانية في مصر (https://ar.wikipedia.org/wiki/x)\n\nمقتبس');
  });
  it('shows an encoded Arabic address as the site and the page name', () => {
    expect(shortLink('https://ar.wikipedia.org/wiki/%D8%A7%D9%84%D8%AA%D8%B1%D9%83%D9%8A%D8%A8%D8%A9_%D8%A7%D9%84%D8%B3%D9%83%D8%A7%D9%86%D9%8A%D8%A9_%D9%81%D9%8A_%D9%85%D8%B5%D8%B1'))
      .toBe('ar.wikipedia.org › التركيبة السكانية في مصر');
  });
});
