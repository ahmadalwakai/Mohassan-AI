import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJudgeShadow, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import type { JudgeEvidence } from '../apps/server/src/assistant/judge.js';
import { publishTruthReply } from '../apps/server/src/assistant/truth-publication.js';

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
    const run = { ownerId: 'member', controller: new AbortController(), request: question,
      page: { url: primary },
      state: { handsFound: { url: primary }, handsResults: [{ url: primary }, { url: second }],
        trail: [{ action: `search ${question}` }] } };
    const config = { judgeShadow: shadow, readPage };
    const evidence: JudgeEvidence[] = [{ kind: 'page', url: primary, text: quote, title: 'Rowan Fair' }];
    const observe = (reply: string, status = 'completed', allowChange = true, applyFix = false, applyWithhold = false) =>
      publishTruthReply(config, run, { conversationId: 'conversation', runId: 'run', question: run.request, reply, status,
        keepText: false, applyFix, applyWithhold, ...(evidence.length ? { evidence } : {}) },
      { allowChange, assertPublicSearch: publicScope, assertBrowserRequestScope: () => {}, scrub: text => text });
    const record = async () => {
      await shadow.flush();
      return JSON.parse((await readFile(shadow.logFile, 'utf8')).trim()) as JudgeShadowLine;
    };
    return { observe, readPage, record, run, evidence };
  }

  it('defaults to shadow and logs both verdicts without member text', async () => {
    const { observe, readPage, record } = await setup(false);
    expect(observe(reply)).toEqual({ text: reply, withheld: false });
    expect(await record()).toMatchObject({ decision: 'send', applied: false, truth: {
      decision: 'fix', applied: false, source: 'single_source', lookup: false,
      supplemental: { decision: 'withhold', source: 'conflict', lookup: true },
    }, reply: '', question: '', textKept: false });
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it('enforces using evidence on hand and logs the later conflict separately', async () => {
    const { observe, record } = await setup(true);
    expect(observe(reply)).toMatchObject({ withheld: false, text: expect.stringContaining('According to one source:') });
    expect(await record()).toMatchObject({ decision: 'send', truth: {
      decision: 'fix', applied: true, appliedDecision: 'fix', supplemental: { decision: 'withhold', source: 'conflict' },
    } });
  });

  it('keeps the legacy decision with enforcement off when no evidence was captured', async () => {
    const { observe, record, evidence } = await setup(false);
    evidence.length = 0;
    expect(observe(reply, 'completed', true, true, true)).toEqual({ text: reply, withheld: false });
    expect(await record()).toMatchObject({ decision: 'send', support: null, truth: { decision: 'withhold', applied: false } });
  });

  it('keeps the existing scope fence for extra reading', async () => {
    const { observe, readPage, record } = await setup(true, () => { throw new Error('Request forbids this read'); });
    expect(observe(reply)).toMatchObject({ withheld: false, text: expect.stringContaining('According to one source') });
    expect(await record()).toMatchObject({ truth: { decision: 'fix', source: 'single_source', applied: true } });
    expect(readPage).not.toHaveBeenCalled();
  });

  it('observes a pause without fetching or applying changes', async () => {
    const { observe, readPage, record } = await setup(true);
    expect(observe('Which fair?', 'waiting_user', false)).toEqual({ text: 'Which fair?', withheld: false });
    expect(readPage).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ kind: 'question', truth: { decision: 'send', measured: false, applied: false } });
  });

  it('marks an instruction skill substitution for a factual request as ungrounded', async () => {
    const { observe, run } = await setup(true);
    run.state.trail.push({ action: 'skill_read' });
    expect(observe('Source: skill “Event Planning”, version 1.')).toMatchObject({
      withheld: true, text: expect.stringContaining('لم يتوفر نص موثوق'),
    });
  });

  it('defers to the legacy judge for an uncited reply without model provenance', async () => {
    const { observe, record, readPage } = await setup(true);
    const uncited = '29 visitors attended the Rowan Fair.';
    expect(observe(uncited)).toEqual({ withheld: false, text: uncited });
    expect(await record()).toMatchObject({ truth: { measured: false, codes: ['outside_scope'], applied: false } });
    expect(readPage).not.toHaveBeenCalled();
  });

  it('keeps a legacy withhold in force', async () => {
    const { observe, record, run } = await setup(true);
    run.request = 'When did the Rowan Fair open?';
    const unrelated = `The celebration started.\n\n**Source:** [Archive](${primary})`;
    expect(observe(unrelated, 'completed', true, false, true)).toMatchObject({ withheld: true });
    expect(await record()).toMatchObject({ decision: 'withhold', applied: true, truth: { applied: false } });
  });

  it('checks factual blockquotes on an explicitly selected page without reading another site', async () => {
    const { observe, readPage, record, run } = await setup(true);
    const quoted = `From **Rowan Fair** (archive.example):\n\n> ${quote}`;
    run.request = `Open ${primary} and tell me how many visitors attended the Rowan Fair on the page`;
    expect(observe(quoted)).toMatchObject({ withheld: false, text: expect.stringContaining('According to one source:') });
    expect(readPage).not.toHaveBeenCalled();
    expect(await record()).toMatchObject({ kind: 'quote', truth: { source: 'single_source', measured: true } });
  });
});
