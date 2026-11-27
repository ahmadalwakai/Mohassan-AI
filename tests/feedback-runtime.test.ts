import { afterEach, expect, it, vi } from 'vitest';
import type { Mind, MindDeps, MindReply } from '../apps/server/src/assistant/mind/contract.js';
import { buildFrame } from '../apps/server/src/assistant/mind/frame.js';
import { feedbackHandsReader, feedbackSelectionScope, selectFeedbackEvidence, withFeedbackMind } from '../apps/server/src/feedback-selection.js';
import { replayNote, replayReviewedFeedback, replaySources } from '../scripts/quality/replay-feedback.js';

afterEach(() => vi.unstubAllEnvs());

it('selects only already found evidence, preserving its identity and text', () => {
  const [first, second] = replaySources;
  const missing = 'https://missing.feedback-replay.invalid/testland';
  const policy = { pinned: new Set([second!.url, missing]), blocked: new Set([first!.url]) };
  const selected = selectFeedbackEvidence(policy, replaySources);
  expect(selected).toHaveLength(1);
  expect(selected[0]).toBe(second);
  const ordered = selectFeedbackEvidence({ ...policy, blocked: new Set() }, replaySources);
  expect(ordered[0]).toBe(second);
  expect(ordered[1]).toBe(first);
  expect(replaySources).toEqual([first, second]);
  expect(selectFeedbackEvidence(undefined, replaySources)).toBe(replaySources);
});

it('excludes a reviewed URL even when the pipeline reaches it by redirect', async () => {
  const [first, second] = replaySources;
  const fetch = vi.fn(async () => ({ kind: 'page' as const, page: { url: first!.url } }));
  const read = feedbackHandsReader(fetch as unknown as NonNullable<Parameters<typeof feedbackHandsReader>[0]>,
    { pinned: new Set(), blocked: new Set([first!.url]) });
  await expect(read?.(second!.url)).resolves.toEqual({ kind: 'disallowed' });
  await expect(read?.(first!.url)).resolves.toEqual({ kind: 'disallowed' });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(second!.url);
});

it('wraps Mind evidence selection only inside the feedback scope', async () => {
  const blocked = replaySources[0]!;
  const supported = replaySources[1]!;
  const request = 'What is the capital of Testland?';
  const signal = new AbortController().signal;
  const resume = { frame: buildFrame(request), answer: 'Use the available sources.' };
  const reply: MindReply = {
    status: 'completed', text: supported.text, frame: resume.frame, timings: {},
    claims: [{ text: supported.text, support: ['selected'], status: 'single_source' }],
    evidence: [
      { id: 'selected', source: 'web', url: supported.url, quote: supported.text },
      { id: 'uncited', source: 'web', url: new URL('uncited', supported.url).href, quote: 'Unused evidence.' },
    ],
  };
  const hits = [blocked, supported].map(({ title, url, text }) => ({ title, url, snippet: text }));
  const search = vi.fn<MindDeps['search']>().mockResolvedValue(hits);
  const read = vi.fn<MindDeps['read']>(async url => ({ ...supported, url, html: '', headers: {} }));
  const deps: MindDeps = { search, read, now: () => new Date(0), step: async () => {} };
  const handle = vi.fn<Mind['handle']>()
    .mockResolvedValueOnce(reply)
    .mockImplementationOnce(async (question, restrictedDeps, turnSignal) => {
      await expect(restrictedDeps.search(question, hits.length, turnSignal)).resolves.toEqual([hits[1]]);
      await expect(restrictedDeps.read(blocked.url, turnSignal)).rejects.toThrow();
      await expect(restrictedDeps.read(supported.url, turnSignal)).resolves.toMatchObject({ url: supported.url });
      return reply;
    });
  const mind = withFeedbackMind({ handle });

  await expect(mind.handle(request, deps, signal, resume)).resolves.toBe(reply);
  expect(handle.mock.calls[0]?.[1]).toBe(deps);
  expect(handle).toHaveBeenNthCalledWith(1, request, deps, signal, resume);

  const policy = { pinned: new Set<string>(), blocked: new Set([blocked.url]) };
  const observe = vi.fn();
  await expect(feedbackSelectionScope.run({ load: async () => policy, current: () => policy, observe },
    () => mind.handle(request, deps, signal, resume))).resolves.toBe(reply);
  expect(handle).toHaveBeenNthCalledWith(2, request, expect.any(Object), signal, resume);
  expect(search).toHaveBeenCalledExactlyOnceWith(request, hits.length, signal);
  expect(read).toHaveBeenCalledExactlyOnceWith(supported.url, signal);
  expect(observe).toHaveBeenCalledExactlyOnceWith([supported.url], reply.text);
});

it('replays one reviewed exclusion through normal chat and never uses note text', async () => {
  vi.stubEnv('FEEDBACK_LOOP_ENABLED', '1');
  const [first, second] = replaySources;
  const { baseline, pending, reviewed, memberAnswer, cleared } = await replayReviewedFeedback();
  expect(baseline.text).toContain(first!.text);
  expect(pending.text).toBe(baseline.text);
  expect(reviewed.text).toContain(second!.text);
  expect(reviewed.text).not.toContain(first!.text);
  expect(reviewed.text).not.toContain(replayNote);
  expect(reviewed.reads).not.toContain(first!.url);
  expect(memberAnswer.text).toBe(baseline.text);
  expect(cleared.text).toBe(baseline.text);
});
