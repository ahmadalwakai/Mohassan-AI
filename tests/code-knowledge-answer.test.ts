import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodeKnowledge, classifyQuestion, createCodeKnowledgeShadow, formatAnswer, readBundledCorpus, readCorpus, validateCorpus, writeCorpus,
  type CodeKnowledgeShadowEvent, type Corpus, type Passage, type SourceCard,
} from '../packages/code-knowledge/src/index.js';

const mdn: SourceCard = {
  id: 'mdn',
  title: 'MDN Web Docs',
  kind: 'documentation',
  url: 'https://developer.mozilla.org/',
  version: 'test snapshot',
  fingerprint: 'sha256:' + '0'.repeat(64),
  license: 'CC BY-SA 2.5',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.5/',
};
const cc0 = {
  license: 'CC0 1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
};
const errorUrl = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Not_a_function';
const array: Passage = {
  id: 'mdn-map',
  sourceId: 'mdn',
  title: 'Array.prototype.map()',
  url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
  text: 'The map() method of Array instances creates a new array populated with the results of calling a provided function on every element in the calling array.',
  code: [{
    text: 'const numbers = [1, 4, 9];\nconst roots = numbers.map((num) => Math.sqrt(num));\n\n// roots is now     [1, 2, 3]\n// numbers is still [1, 4, 9]\n',
    language: 'js',
    ...cc0,
  }],
  tags: ['javascript'],
  symbols: ['Array.prototype.map', 'map'],
  attribution: [{ name: 'MDN contributors', url: 'https://github.com/mdn/content' }],
};
const diagnostics: Passage = {
  id: 'mdn-not-a-function',
  sourceId: 'mdn',
  title: 'TypeError: "x" is not a function',
  url: errorUrl + '#a_typo_in_the_function_name',
  text: 'In this case, which happens way too often, there is a typo in the method name:\n\nThe correct function name is getElementById:',
  code: [
    {
      text: 'const x = document.getElementByID("foo");\n// TypeError: document.getElementByID is not a function\n',
      language: 'js',
      role: 'failure',
      ...cc0,
    },
    { text: 'const x = document.getElementById("foo");\n', language: 'js', role: 'fix', ...cc0 },
  ],
  tags: ['javascript'],
  symbols: ['getElementById'],
  attribution: array.attribution,
};
const corpus: Corpus = { sources: [mdn], passages: [array, diagnostics] };

describe('offline programming answers', () => {
  it('retrieves a pinned primary definition from the bundled corpus', async () => {
    // https://github.com/mdn/content/blob/72813e874d34cf328f39ab025448d9e06d921254/files/en-us/web/javascript/reference/global_objects/promise/allsettled/index.md
    // Retrieved 2026-11-27.
    const bundled = await readBundledCorpus();
    expect(bundled.sources.every(source => source.kind === 'documentation' && Boolean(source.retrievedOn))).toBe(true);
    expect(bundled.passages.filter(passage => passage.sourceId === 'mdn').every(passage => !passage.code.length)).toBe(true);
    const answer = new CodeKnowledge(bundled).answer('What does Promise.allSettled() return?');
    expect(answer.status).toBe('answered');
    if (answer.status !== 'answered') return;
    expect(answer.excerpts[0].citation).toMatchObject({
      url: expect.stringContaining('https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled'),
      version: 'MDN content 72813e874d34cf328f39ab025448d9e06d921254',
      license: 'CC-BY-SA-2.5',
    });
    expect(formatAnswer(answer)).toContain('an array of objects');
  });

  it('prefers exact reference definitions over examples or category introductions', async () => {
    // https://docs.python.org/release/3.13.9/library/functions.html#all
    // https://github.com/mdn/content/blob/72813e874d34cf328f39ab025448d9e06d921254/files/en-us/web/javascript/reference/global_objects/array/map/index.md
    // Retrieved 2026-11-27.
    const answerer = new CodeKnowledge(await readBundledCorpus());
    const python = answerer.answer('What does the Python built-in all() function do?', { snippets: 'omit' });
    expect(python).toMatchObject({
      status: 'answered',
      excerpts: [{ citation: { url: 'https://docs.python.org/release/3.13.9/library/functions.html#all' }, code: [] }],
    });
    expect(formatAnswer(python)).toContain('Return True if all elements of the iterable are true');
    const question = 'What does Array.prototype.map() do in JavaScript?';
    expect(answerer.answer(question, { snippets: 'omit' })).toMatchObject({
      status: 'answered',
      excerpts: [{
        citation: { url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map' },
        code: [],
      }],
    });
    expect(answerer.answer(question, { snippets: 'require' }).status).toBe('abstained');
  });

  it.each([
    ['How do I flatten an array?', 'how-to'],
    ['Why do I get TypeError: x is not a function?', 'error'],
    ['How do I use Array.prototype.map()?', 'api-usage'],
    ['What is a closure?', 'concept'],
    ['What is the difference between map and forEach?', 'comparison'],
    ['ما الفرق بين map و forEach؟', 'comparison'],
    ['كيف أستخدم map؟', 'api-usage'],
  ])('classifies %s', (question, type) => {
    expect(classifyQuestion(question)).toBe(type);
  });

  it('quotes exact source text and code with contributor, version, and license links', () => {
    const result = new CodeKnowledge(corpus).answer('How do I use Array.prototype.map()?');
    expect(result).toMatchObject({
      status: 'answered',
      intent: 'api-usage',
      excerpts: [{
        sentences: [array.text],
        code: array.code,
        citation: {
          url: array.url, version: mdn.version, license: mdn.license, licenseUrl: mdn.licenseUrl,
          fingerprint: mdn.fingerprint, attribution: array.attribution,
        },
      }],
    });
    const rendered = formatAnswer(result);
    expect(rendered).toContain(array.code[0].text);
    expect(rendered).toContain(array.url);
    expect(rendered).toContain(mdn.url);
    expect(rendered).toContain(mdn.licenseUrl);
    expect(rendered).toContain('Selected passages rendered as plain text');
    expect(rendered).toContain(cc0.licenseUrl);
    expect(rendered).toContain('MDN contributors');
    expect(rendered).toContain('Version test snapshot');
  });

  it('matches a pasted diagnostic and excerpts its listed fix without echoing a local trace', () => {
    const result = new CodeKnowledge(corpus).answer(
      'TypeError: document.getElementByID is not a function\n    at test (/home/local/private.js:11:2)',
    );
    expect(result).toMatchObject({
      status: 'answered', intent: 'error', excerpts: [{
        sentences: expect.arrayContaining(['The correct function name is getElementById:']),
        code: [diagnostics.code[1]],
        citation: { url: diagnostics.url },
      }],
    });
    expect(formatAnswer(result)).not.toContain('/home/local/private.js');
    expect(formatAnswer(result)).not.toContain(diagnostics.code[0].text);
    const reproduced = { ...diagnostics, code: [{ ...diagnostics.code[0], role: undefined }] };
    const failureOnly = new CodeKnowledge({ sources: [mdn], passages: [reproduced] });
    expect(failureOnly.answer('TypeError: document.getElementByID is not a function').status).toBe('abstained');
  });

  it('abstains on unknown diagnostics, unsupported edits, and one-sided comparisons', () => {
    const answerer = new CodeKnowledge(corpus);
    expect(answerer.answer('TypeError: unsupported input for zoople')).toMatchObject({ status: 'abstained', intent: 'error' });
    expect(answerer.answer('Edit my repo to use Array.prototype.map')).toMatchObject({
      status: 'abstained', reason: 'unsupported-request',
    });
    expect(answerer.answer('Compare Array.prototype.map versus the ZXQ operator.')).toMatchObject({
      status: 'abstained', intent: 'comparison',
    });
    expect(answerer.answer('How do I use Array.prototype.map in Python?').status).toBe('abstained');
    expect(answerer.answer('How do I add a new map of Chicago?').status).toBe('abstained');
    expect(answerer.answer('')).toMatchObject({ status: 'abstained' });
  });

  it('preserves separate Q&A post attribution and blocks incomplete attribution during load', () => {
    const qa: SourceCard = { ...mdn, id: 'qa', title: 'Stack Exchange', kind: 'qa' };
    const passage: Passage = {
      ...array,
      id: 'qa-answer',
      sourceId: qa.id,
      url: 'https://stackoverflow.com/a/123',
      questionUrl: 'https://stackoverflow.com/questions/100',
      attribution: [{ name: 'Answerer', url: 'https://stackoverflow.com/users/10/answerer' }],
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    };
    const valid = validateCorpus({ sources: [qa], passages: [passage] });
    const result = new CodeKnowledge(valid).answer('Array.prototype.map()');
    expect(result).toMatchObject({
      status: 'answered',
      excerpts: [{ citation: { attribution: passage.attribution, license: passage.license, licenseUrl: passage.licenseUrl } }],
    });
    expect(() => validateCorpus({ sources: [qa], passages: [{ ...passage, attribution: [] }] })).toThrow(/attribution/u);
    expect(formatAnswer(result)).toContain(passage.questionUrl);
    expect(() => validateCorpus({ sources: [qa], passages: [{ ...passage, url: 'javascript:alert(1)' }] })).toThrow(/invalid/iu);
  });

  it('loads local data and leaves a prior valid corpus intact after a rejected write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'code-knowledge-'));
    try {
      const path = join(dir, 'corpus.json');
      await writeCorpus(path, corpus);
      await expect(writeCorpus(path, { sources: [], passages: corpus.passages })).rejects.toThrow(/source card/u);
      await expect(readCorpus(path)).resolves.toEqual(corpus);
      await writeFile(path, '{');
      await expect(readCorpus(path)).rejects.toThrow(/JSON/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('logs an extractive shadow result on explicit invocation and omits raw question text', () => {
    const events: CodeKnowledgeShadowEvent[] = [];
    const log = (event: CodeKnowledgeShadowEvent) => events.push(event);
    expect(createCodeKnowledgeShadow(undefined, log).observe('private arbitrary input')).toBeUndefined();
    expect(events).toEqual([]);
    const shadow = createCodeKnowledgeShadow(new CodeKnowledge(corpus), log);
    const result = shadow.observe('How do I use Array.prototype.map()? private-request-label', { caseId: 'case-1' });
    expect(events).toEqual([{ caseId: 'case-1', answer: result }]);
    expect(JSON.stringify(events)).not.toContain('private-request-label');
    expect(result?.status).toBe('answered');
  });
});
