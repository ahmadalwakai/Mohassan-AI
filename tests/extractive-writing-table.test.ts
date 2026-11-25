import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderExtractiveWriting } from '../apps/server/src/assistant/writing/render.js';
import { parseExtractiveWriting } from '../apps/server/src/assistant/writing/request.js';
import { Markdown } from '../apps/web/components/markdown.js';
import publicPages from './fixtures/extractive-writing/public-pages.json';
import userTexts from './fixtures/extractive-writing/user-texts.json';

const markup = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('extractive writing comparison tables in chat', () => {
  it('renders bilingual citations and uses row and column headers', () => {
    const earth = publicPages.find(page => page.id === 'page-en-earth')!;
    const eclipse = publicPages.find(page => page.id === 'page-en-solar-eclipse')!;
    const request = parseExtractiveWriting(`What is the difference between ${earth.title} and ${eclipse.title}?`)!;
    const reply = renderExtractiveWriting(request, [earth, eclipse]);
    const html = markup(reply.text);
    expect(html).toContain('<table');
    expect(html).toContain('<th scope="col"><bdi>Earth</bdi></th>');
    expect(html).toContain('<th scope="row"><bdi>Definition</bdi></th>');
    expect(html).toContain(`href="${earth.url}"`);
    expect(html).toContain(`href="${eclipse.url}"`);
    expect(html).toContain('لم أجد');
    expect(html).toContain('tabindex="0"');
  });

  it('shows escaped pipes and punctuation with exactly the original spelling', () => {
    const agenda = userTexts.find(entry => entry.id === 'user-ar-meeting-agenda')!;
    const greeting = agenda.text.split('\n')[0]!;
    const contents = `${greeting.replace('!', '\\!')} \\| ${agenda.title}`;
    const md = [`| ${agenda.title} | ${agenda.author} |`, '| --- | --- |', `| ${agenda.author} | ${contents} |`].join('\n');
    const html = markup(md);
    expect(html).toContain(`<td><bdi>${greeting} | ${agenda.title}</bdi></td>`);
    expect(markup(greeting.replace('!', '\\!'))).toContain(`<p dir="auto">${greeting}</p>`);
  });

  it('keeps pipes in prose and fenced code as text', () => {
    const agenda = userTexts.find(entry => entry.id === 'user-ar-meeting-agenda')!;
    const row = `| ${agenda.title} | ${agenda.author} |`;
    expect(markup(row)).not.toContain('<table');
    const fenced = ['```', row, '| --- | --- |', row, '```'].join('\n');
    expect(markup(fenced)).toContain('<pre dir="ltr"><code>');
    expect(markup(fenced)).not.toContain('<table');
  });
});
