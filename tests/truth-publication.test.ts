import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { judge, type JudgeEvidence } from '../apps/server/src/assistant/judge.js';
import { createJudgeShadow, type JudgeShadowInput, type JudgeShadowLine } from '../apps/server/src/assistant/judge-shadow.js';
import { evaluateJudgeReply } from '../apps/server/src/assistant/truth-publication.js';

// These fixture-only facts derive from the page below. The draft changes the event while keeping the date.
const page = {
  kind: 'page', url: 'https://press.test/Archive?event=opened', title: 'Fixture Press',
  text: 'The Fixture Press opened in 2120.',
} satisfies JudgeEvidence;
const input: JudgeShadowInput = {
  conversationId: 'conversation', runId: 'run', status: 'completed',
  question: 'When did the Fixture Press open?', reply: page.text.replace('opened', 'closed'),
  evidence: [page], applyFix: true, applyWithhold: true,
};

afterEach(() => vi.unstubAllEnvs());

describe('truth checks at the existing judge hook', () => {
  it.each([
    [undefined, 'send', undefined],
    ['shadow', 'send', { decision: 'withhold', applied: false }],
    ['on', 'withhold', { decision: 'withhold', applied: true }],
  ] as const)('keeps the same publication contract in mode %s', async (mode, decision, truth) => {
    vi.stubEnv('MOHASSAN_TRUTH_CHECK', mode);
    const directory = await mkdtemp(join(tmpdir(), 'mohassan-truth-publication-'));
    try {
      const shadow = createJudgeShadow({ logFile: join(directory, 'judge.jsonl') });
      const result = shadow.observe(input);
      await shadow.flush();
      const line: JudgeShadowLine = JSON.parse(await readFile(shadow.logFile, 'utf8'));
      if (truth) expect(line.truth).toMatchObject(truth);
      else expect(line).not.toHaveProperty('truth');
      expect(result?.decision).toBe(decision);
      expect(line.applied).toBe(decision === 'withhold');
      expect(line.reply).toBe(input.reply);
      if (decision === 'withhold') {
        expect(result?.withholdText).toContain('I could not confirm');
        expect(result?.withholdText).toContain(page.url);
        expect(result?.withholdText).not.toContain(input.reply);
      } else {
        expect(result).toMatchObject({ ...judge(input), ms: expect.any(Number) });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('checks the existing fix when the host would publish it', () => {
    const fixed = { ...judge(input), decision: 'fix' as const, fixedReply: page.text };
    const original = { ...input, priorVerdict: fixed };
    const withFix = evaluateJudgeReply(original, 'on');
    expect(withFix.verdict).toBe(fixed);
    expect(withFix.truth).toEqual({ decision: 'send', codes: [], applied: false });
    const withoutFix = evaluateJudgeReply({ ...original, applyFix: false }, 'on');
    expect(withoutFix.truth).toMatchObject({ decision: 'withhold', applied: true });
  });

  it('uses the host permission for withholds and does not override an applied legacy withhold', () => {
    const member = evaluateJudgeReply({ ...input, applyWithhold: false }, 'on');
    expect(member).toMatchObject({ verdict: { decision: 'send' }, truth: { decision: 'withhold', applied: false } });

    const original = { ...judge(input), decision: 'withhold' as const, withholdText: 'Existing judge reason.' };
    const alreadyWithheld = evaluateJudgeReply({ ...input, priorVerdict: original }, 'on');
    expect(alreadyWithheld.verdict).toBe(original);
    expect(alreadyWithheld.truth?.applied).toBe(false);
  });

  it.each([
    page.url.replace('/Archive', '/archive'),
    page.url.replace('event=opened', 'event=closed'),
  ])('requires the exact cited read page for %s', citation => {
    const result = evaluateJudgeReply({ ...input, reply: `${page.text}\n\n**Source:** [Archive](${citation})` }, 'on');
    expect(result.truth).toEqual({ decision: 'withhold', codes: ['unread_citation'], applied: true });
    expect(result.verdict.withholdText).toContain(page.url);
    expect(result.verdict.withholdText).not.toContain(citation);
  });

  it('omits credential-bearing and scrubbed page URLs from the replacement', () => {
    const privatePage = { ...page, url: 'https://press.test/archive?access_token=local-fixture' };
    const scrubbedPage = { ...page, url: 'https://press.test/archive?ref=private-fixture' };
    const result = evaluateJudgeReply({
      ...input, evidence: [page, privatePage, scrubbedPage],
      scrubTruthText: value => value.replace('private-fixture', '[محجوب]'),
    }, 'on');
    expect(result.verdict.withholdText).toContain(page.url);
    expect(result.verdict.withholdText).not.toContain(privatePage.url);
    expect(result.verdict.withholdText).not.toContain(scrubbedPage.url);
  });

  it('reuses the council verdict and never treats a search snippet as a read page', () => {
    const reply = page.text;
    const result = evaluateJudgeReply({
      ...input, reply, truthOnly: true, priorVerdict: judge({ ...input, reply }),
      evidence: [{ ...page, searchSnippet: true }],
    }, 'on');
    expect(result.truth).toEqual({ decision: 'withhold', codes: ['evidence_unavailable'], applied: true });
    expect(result.verdict.withholdText).not.toContain(page.url);
  });
});
