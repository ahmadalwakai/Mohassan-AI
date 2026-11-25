import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { createTruthReplyJudge } from '../apps/server/src/assistant/truth-publication.js';

const primary = 'https://archive.example/admissions';
const second = 'https://bulletin.example/admissions';
const quote = '20 visitors attended the Rowan Fair.';
const reply = `${quote}\n\n**Source:** [Archive](${primary})`;
const question = 'How many visitors attended the Rowan Fair?';

describe('pre-send truth and form shadow', () => {
  // All cases authored in this test are agent-written development cases.
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  async function setup(truthEnabled?: boolean, publicScope = () => {}) {
    const dir = await mkdtemp(join(tmpdir(), 'truth-publication-'));
    dirs.push(dir);
    const shadow = createJudgeShadow({ logFile: join(dir, 'judge.jsonl'), truthEnabled });
    const readPage = vi.fn(async (url: string) => ({ url, status: 200, title: 'Rowan Fair',
      text: '26 visitors attended the Rowan Fair. The published fair bulletin records the audited admission count on opening day.' }));
    const run = { full: false, ownerId: 'member', controller: new AbortController(), request: question, truthModelAnswer: false,
      page: { url: primary },
      state: { handsFound: { url: primary }, handsResults: [{ url: primary }, { url: second }],
        requestResolution: { scope: 'public' }, trail: [{ action: `search ${question}` }] } };
    const observe = createTruthReplyJudge({ judgeShadow: shadow, judgeLogText: 'owner', readPage }, () => run,
      () => [{ kind: 'page', url: primary, text: quote, title: 'Rowan Fair' }], publicScope);
    const record = async () => {
      await shadow.flush();
      return JSON.parse((await readFile(shadow.logFile, 'utf8')).trim()) as JudgeShadowLine;
    };
    return { observe, readPage, record, run };
  }

  it('defaults to shadow and logs both verdicts without member text', async () => {
    const { observe, readPage, record } = await setup();
    expect(await observe('conversation', 'run', reply, 'completed', true)).toEqual({ text: reply, withheld: false });
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(await record()).toMatchObject({ decision: 'send', applied: false, truth: {
      decision: 'withhold', applied: false, source: 'conflict',
    }, reply: '', question: '', textKept: false });
  });

  it('enforces behind the flag before the host receives the reply to store', async () => {
    const { observe, record } = await setup(true);
    const outcome = await observe('conversation', 'run', reply, 'completed', true);
    expect(outcome).toMatchObject({ withheld: true, text: expect.stringContaining('وجدت قيمًا مختلفة') });
    expect(await record()).toMatchObject({ decision: 'send', truth: { decision: 'withhold', applied: true } });
  });

  it('keeps the existing scope fence for extra reading', async () => {
    const { observe, readPage, record } = await setup(true, () => { throw new Error('Request forbids this read'); });
    expect(await observe('conversation', 'run', reply, 'completed', true)).toMatchObject({
      withheld: false, text: expect.stringContaining('According to one source'),
    });
    expect(readPage).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ truth: { decision: 'fix', source: 'single_source', applied: true } });
  });

  it('observes a pause without fetching or applying changes', async () => {
    const { observe, readPage, record } = await setup(true);
    expect(await observe('conversation', 'run', 'Which fair?', 'waiting_user')).toEqual({ text: 'Which fair?', withheld: false });
    expect(readPage).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ kind: 'question', truth: { decision: 'send', measured: false, applied: false } });
  });

  it('marks an instruction skill substitution for a factual request as ungrounded', async () => {
    const { observe, run } = await setup(true);
    run.state.trail.push({ action: 'skill_read' });
    expect(await observe('conversation', 'run', 'Source: skill “Event Planning”, version 1.', 'completed', true)).toMatchObject({
      withheld: true, text: expect.stringContaining('لم يتوفر نص موثوق'),
    });
  });

  it('checks a public factual candidate even when its author omitted the citation', async () => {
    const { observe, readPage, run } = await setup(true);
    run.truthModelAnswer = true;
    expect(await observe('conversation', 'run', '29 visitors attended the Rowan Fair.', 'completed', true)).toMatchObject({ withheld: true });
    expect(readPage).not.toHaveBeenCalled();
  });

  it('also checks a formatted list presented as a public factual answer', async () => {
    const { observe, run } = await setup(true);
    run.truthModelAnswer = true;
    const alternatives = '1. [29 visitors](https://first.example)\n2. [47 visitors](https://second.example)';
    expect(await observe('conversation', 'run', alternatives, 'completed', true)).toMatchObject({ withheld: true });
  });

  it('checks factual blockquotes on an explicitly selected page without reading another site', async () => {
    const { observe, readPage, record } = await setup(true);
    const quoted = `From **Rowan Fair** (archive.example):\n\n> ${quote}`;
    const request = 'Open the page and tell me how many visitors attended the Rowan Fair';
    expect(await observe('conversation', 'run', quoted, 'completed', true, { question: request, previous: null, pageQuestion: question }))
      .toMatchObject({ withheld: false, text: expect.stringContaining('According to one source:') });
    expect(readPage).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ kind: 'quote', truth: { source: 'single_source', measured: true } });
  });
});
