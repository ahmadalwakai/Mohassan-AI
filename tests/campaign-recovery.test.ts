import { describe, expect, it } from 'vitest';
import { correctAdText, validateAdText, type TextInput } from '@mohassan/google-ads';
import { mergeCampaignEvents, reduceCampaignEvents, type CampaignEvent } from '@mohassan/contracts';
import { backoffDelay, classifyFailure, withRecovery } from '../apps/server/src/assistant/recovery.ts';

// Local unit tests: no Google, no model provider. Nothing here proves a live Google Ads result.
const evidence = 'MA Removals. House removals in Glasgow.';
const base: TextInput = { headlines: ['Glasgow House Removals', 'Local Movers Glasgow', 'Book Your Move'], descriptions: ['Careful house removals across Glasgow.', 'Book your move online in minutes.'], paths: ['removals'], keywords: ['"house removals glasgow"'], negativeKeywords: ['jobs'] };
const validate = (input: TextInput) => validateAdText(input, evidence, 'en');
const rewriteWith = (...replies: string[]) => { const calls: unknown[] = []; return { calls, fn: async (request: unknown) => { calls.push(request); const reply = replies.shift(); if (reply === undefined) throw new Error('no reply'); return reply; } }; };

describe('adaptive correction', () => {
  it('leaves valid text alone', async () => {
    const result = await correctAdText(base, { validate, evidence });
    expect(result.status).toBe('clean');
    expect(result.changes).toEqual([]);
  });

  it('fixes a forbidden exclamation mark by code and keeps every other line', async () => {
    const result = await correctAdText({ ...base, headlines: ['Glasgow House Removals!', ...base.headlines.slice(1)] }, { validate, evidence });
    expect(result.status).toBe('corrected');
    expect(result.input.headlines).toEqual(['Glasgow House Removals', 'Local Movers Glasgow', 'Book Your Move']);
    expect(result.changes[0]).toMatchObject({ strategy: 'deterministic', verified: true, basis: 'observed' });
    expect(result.input.descriptions).toEqual(base.descriptions);
  });

  it('never invents an offer: a rewrite that adds a claim is refused and the line is removed', async () => {
    const input = { ...base, headlines: [...base.headlines, 'Free Same Day Removals'] };
    const model = rewriteWith(JSON.stringify({ replacements: [{ id: 'headline 4', text: 'Free Quotes 24/7' }] }), JSON.stringify({ replacements: [{ id: 'headline 4', text: 'Save 20% Today' }] }));
    const result = await correctAdText(input, { validate, evidence, rewrite: model.fn });
    expect(result.status).toBe('corrected');
    expect(result.input.headlines).toEqual(base.headlines);
    expect(result.changes.find(change => change.field === 'headline 4')).toMatchObject({ after: null, strategy: 'remove_item' });
  });

  it('accepts a model rewrite only after the validator accepts it', async () => {
    const input = { ...base, headlines: [...base.headlines, 'Glasgow House Removals And Man Vans Today'] };
    const model = rewriteWith(JSON.stringify({ replacements: [{ id: 'headline 4', text: 'Glasgow Man And Van' }] }));
    const result = await correctAdText(input, { validate, evidence: `${evidence} man and van`, rewrite: model.fn });
    expect(result.input.headlines.at(-1)).toBe('Glasgow Man And Van');
    expect(result.changes.at(-1)).toMatchObject({ strategy: 'model_rewrite', basis: 'model', verified: true });
  });

  it.each([['empty', ''], ['malformed', '{"replacements": [}'], ['truncated', '{"replacements":[{"id":"headline 4"']])('survives a %s model response without looping', async (_name, reply) => {
    const input = { ...base, headlines: [...base.headlines, 'Glasgow House Removals And Man Vans Today'] };
    const model = rewriteWith(reply, reply);
    const result = await correctAdText(input, { validate, evidence, rewrite: model.fn });
    expect(model.calls.length).toBeLessThanOrEqual(2);
    expect(result.input.headlines).toEqual(base.headlines);
    expect(result.passes.some(pass => pass.failure !== null)).toBe(true);
  });

  it('stops after a repeated identical model answer', async () => {
    const input = { ...base, headlines: [...base.headlines, 'Glasgow House Removals And Man Vans Today'] };
    const same = JSON.stringify({ replacements: [{ id: 'headline 4', text: 'Glasgow House Removals And Man Vans Today' }] });
    const model = rewriteWith(same, same);
    await correctAdText(input, { validate, evidence, rewrite: model.fn });
    expect(model.calls.length).toBeLessThanOrEqual(2);
  });

  it('is unresolved, not corrected, when a required line cannot be dropped', async () => {
    const result = await correctAdText({ ...base, headlines: ['Glasgow House Removals And Man Vans Today', 'Local Movers Glasgow', 'Book Your Move'] }, { validate, evidence });
    expect(result.status).toBe('unresolved');
    expect(result.remaining.length).toBeGreaterThan(0);
  });
});

describe('failure classification and bounded recovery', () => {
  const abort = new AbortController().signal;
  const rate = Object.assign(new Error('x'), { code: 'GOOGLE_ADS_RATE_LIMITED', options: { retryAfterSeconds: 2 } });
  it('never retries sign-in, permission or daily-quota failures', () => {
    for (const code of ['GOOGLE_ADS_UNAUTHORIZED', 'GOOGLE_ADS_PERMISSION_DENIED', 'GOOGLE_ADS_DAILY_QUOTA', 'GOOGLE_ADS_REJECTED']) expect(classifyFailure(Object.assign(new Error('x'), { code })).retryable).toBe(false);
  });
  it('honors Retry-After in full and caps attempts', async () => {
    const waits: number[] = []; let calls = 0;
    await expect(withRecovery(async () => { calls += 1; throw rate; }, { signal: abort, maxAttempts: 3, random: () => 0, sleep: async ms => { waits.push(ms); } })).rejects.toBe(rate);
    expect(calls).toBe(3);
    expect(waits.every(ms => ms >= 2000)).toBe(true);
  });
  it('refuses an automatic wait longer than the budget', async () => {
    const long = Object.assign(new Error('x'), { code: 'GOOGLE_ADS_RATE_LIMITED', options: { retryAfterSeconds: 3600 } });
    let calls = 0;
    await expect(withRecovery(async () => { calls += 1; throw long; }, { signal: abort, sleep: async () => undefined })).rejects.toBe(long);
    expect(calls).toBe(1);
  });
  it('stops waiting when cancelled', async () => {
    const controller = new AbortController(); let calls = 0;
    const run = withRecovery(async () => { calls += 1; throw Object.assign(new Error('x'), { code: 'GOOGLE_ADS_UNAVAILABLE' }); }, { signal: controller.signal, sleep: async () => { controller.abort(new Error('cancelled')); controller.signal.throwIfAborted(); } });
    await expect(run).rejects.toThrow('cancelled');
    expect(calls).toBe(1);
  });
  it('jitters within bounds', () => expect(backoffDelay(3, { retryAfterMs: null }, { random: () => 1, baseMs: 100 })).toBe(400));
});

describe('event reducer', () => {
  const at = '2026-11-10T10:00:00.000Z';
  const event = (seq: number, type: string, status: string, data: object, stepId: string | null = null) => ({ id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`, taskId: 'campaign-run-1', seq, type, stepId, status, at, data }) as unknown as CampaignEvent;
  const started = event(1, 'task_started', 'passed', { kind: 'google_ads_search_campaign', createInAccount: true }, 'intent');
  const write = event(2, 'external_operation_started', 'running', { operation: 'create_paused', mutates: true, attempt: 1 }, 'paused_creation');
  it('ignores duplicates and arrival order', () => {
    const merged = mergeCampaignEvents([write], [started, write, started]);
    expect(merged.map(item => item.seq)).toEqual([1, 2]);
    expect(reduceCampaignEvents([write, started, started])).toEqual(reduceCampaignEvents([started, write]));
  });
  it('keeps an unconfirmed write as reconciliation-required when the task is cancelled', () => {
    const cancelled = event(3, 'task_cancelled', 'unknown', { reason: 'owner_cancelled', reconciliationRequired: true }, 'outcome');
    const progress = reduceCampaignEvents([started, write, cancelled])!;
    expect(progress.status).toBe('reconciliation_required');
    expect(progress.steps.find(step => step.id === 'paused_creation')?.status).toBe('unknown');
  });
  it('does not reopen a finished task', () => {
    const failed = event(3, 'task_failed', 'failed', { category: 'quota', code: 'X', message: 'm', action: 'a', retryable: false, retryAfterSeconds: null, reconciliationRequired: false, strategy: 'stop_and_report' }, 'outcome');
    expect(reduceCampaignEvents([started, failed, event(4, 'step_started', 'running', {}, 'draft')])!.status).toBe('failed');
  });
});
