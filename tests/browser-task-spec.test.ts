import { describe, expect, it } from 'vitest';
import { parseBrowserTask } from '../apps/server/src/assistant/browser-task-spec.js';
import { parseHands } from '../apps/server/src/assistant/hands.js';

// Test-only inputs reuse the repository's Hands examples or are assembled from
// grammar tokens and deterministic sentinels. Never use them for training.
const currentPage = { hasPage: true };
const testHost = new URL('https://example.org/');

describe('browser task understanding', () => {
  it('preserves the HTTP-first and page question paths', () => {
    expect(parseBrowserTask('ابحث عن مطاعم في لندن', currentPage)).toBeNull();
    expect(parseBrowserTask('ما رأيك في الطقس اليوم؟', currentPage)).toBeNull();
    const question = 'open example.org and report the page heading';
    expect(parseBrowserTask(question, { legacy: parseHands(question) })).toBeNull();
  });

  it('leaves ordinary writing, local opening and site-specific search on their existing paths', () => {
    const siteSearch = 'افتح youtube وابحث عن تعليم الطبخ';
    expect(parseBrowserTask(siteSearch, { legacy: parseHands(siteSearch) })).toBeNull();
    expect(parseBrowserTask(['write', 'a report', 'in English'].join(' '), currentPage)).toBeNull();
    expect(parseBrowserTask(['open', 'my notes'].join(' '), currentPage)).toBeNull();
  });

  it('plans an Arabic task with the source, required value and independent readback', () => {
    const opening = `روح على ${testHost.href}`;
    const writing = 'اكتب لندن في خانة المدينة';
    const spec = parseBrowserTask([opening, writing, 'اقرأ الصفحة'].join(' وبعدين '));
    expect(spec).toMatchObject({
      target: { kind: 'site', url: testHost.href }, lang: 'ar', risk: 'reversible-write',
      steps: [{ kind: 'open' }, { kind: 'fill', target: 'المدينة', value: 'لندن' }, { kind: 'read', section: 'main' }],
      requiredData: [{ kind: 'value', step: 1, supplied: true }],
      success: [{ kind: 'page-open' }, { kind: 'value-read-back' }, { kind: 'content-read' }],
    });
  });

  it('preserves quoted text and labels even when they contain grammatical words', () => {
    const value = ['before', 'and then', 'after'].join(' ');
    const label = ['First', 'Name'].join(' ');
    const spec = parseBrowserTask(`type "${value}" into ${label} field`, currentPage);
    expect(spec?.steps).toEqual([{ kind: 'fill', target: label, value, risk: 'reversible-write', match: { role: 'textbox' } }]);
  });

  it('captures the target role, context, ordinal and irreversible intent', () => {
    const role = 'button';
    const name = ['Delete', 'account'].join(' ');
    const surrounding = 'Settings';
    const spec = parseBrowserTask(`click second ${role} "${name}" near ${surrounding}`, currentPage);
    expect(spec).toMatchObject({
      risk: 'irreversible',
      steps: [{ kind: 'click', target: name, match: { role, position: 2, nearby: surrounding }, risk: 'irreversible' }],
      success: [{ kind: 'effect-observed' }],
    });
  });

  it('plans structured reads, file targets and missing input without an imagined site or file', () => {
    const spec = parseBrowserTask(`open ${testHost.href} then read tables across all pages then upload to field attachment`);
    expect(spec?.steps).toMatchObject([
      { kind: 'open' }, { kind: 'read', section: 'tables', more: true }, { kind: 'upload' },
    ]);
    expect(spec?.requiredData).toMatchObject([{ kind: 'file', supplied: false }]);
    expect(parseBrowserTask('open a website')?.target).toEqual({ kind: 'missing' });
  });

  it.each([
    ['password', 'login'], ['one-time code', 'code'], ['card number', 'payment'], ['ID number', 'identifier'],
  ])('keeps %s out of the step values', (label, human) => {
    const value = '•'.repeat(12);
    const spec = parseBrowserTask(`fill the ${label} with "${value}"`, currentPage);
    expect(spec).toMatchObject({
      steps: [{ kind: 'fill', target: label, human }],
      requiredData: [{ kind: 'manual', supplied: false }],
      success: [{ kind: 'human-completed' }],
    });
    expect(JSON.stringify(spec)).not.toContain(value);
  });

  it('distinguishes search, native choice controls and order within a role', () => {
    const query = ['winter', 'tyres'].join(' ');
    expect(parseBrowserTask(`search for ${query} in the browser`)).toMatchObject({
      target: { kind: 'search', query }, steps: [{ kind: 'find', scope: 'web', target: query }],
    });
    expect(parseBrowserTask(['select', 'radio', 'Express'].join(' '), currentPage)?.steps).toMatchObject([
      { kind: 'fill', target: 'Express', value: 'true', match: { role: 'radio' } },
    ]);
    expect(parseBrowserTask(['click', 'second', 'button'].join(' '), currentPage)?.steps).toMatchObject([
      { kind: 'click', match: { role: 'button', position: 2 } },
    ]);
  });

  it('marks explicit payment and bot-check interactions as manual', () => {
    const payment = parseBrowserTask('اضغط على Buy now', currentPage);
    expect(payment).toMatchObject({ risk: 'irreversible', steps: [{ kind: 'click', human: 'payment' }] });
    const challenge = parseBrowserTask(['click', 'CAPTCHA'].join(' '), currentPage);
    expect(challenge?.steps).toMatchObject([{ kind: 'click', human: 'challenge' }]);
  });

  it('rejects a coordinated write when the assignment boundaries are ambiguous', () => {
    const fields = ['Name', 'Email'];
    const placeholders = ['A', 'B'];
    const joined = fields.map((field, index) => `${field} with ${placeholders[index]}`).join(' and ');
    expect(parseBrowserTask(`fill ${joined}`, currentPage)?.steps).toEqual([]);
  });

  it('requires instructions for an unrecognised step before dispatching any actions', () => {
    const spec = parseBrowserTask(`open ${testHost.href} then ${'x'.repeat(5)}`);
    expect(spec?.requiredData).toEqual([{ kind: 'instruction', name: 'step', step: 1, supplied: false }]);
  });
});
