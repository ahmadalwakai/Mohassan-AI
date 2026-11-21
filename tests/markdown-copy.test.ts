import { describe, expect, it } from 'vitest';
import { plainText, shortLink } from '../apps/web/components/markdown';

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
