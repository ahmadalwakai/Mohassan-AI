import { afterEach, expect, it, vi } from 'vitest';
import { feedbackHandsReader, selectFeedbackEvidence } from '../apps/server/src/feedback-selection.js';
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
