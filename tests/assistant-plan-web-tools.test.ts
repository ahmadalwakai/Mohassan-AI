// Agent-written development cases for public plan tools. Never use as training data.
import type { AgentPage, SearchProvider } from '@mohassan/browser';
import { describe, expect, it, vi } from 'vitest';
import { compilePlan } from '../apps/server/src/assistant/plan/compiler.js';
import { resolveStepInputs } from '../apps/server/src/assistant/plan/references.js';
import type { PlanValue, ResolvedStepInputs } from '../apps/server/src/assistant/plan/types.js';
import { webFigure } from '../apps/server/src/assistant/plan/web-figures.js';
import { createPlanWebTools, type PlanWebToolContext } from '../apps/server/src/assistant/plan/web-tools.js';
import { planReadMeasure, planReadTarget } from '../apps/server/src/assistant/plan/web-target.js';

const source1 = 'https://materials.example.com/solar';
const source2 = 'https://engineering.example.org/solar';
const signal = new AbortController().signal;
const initial = { number: 1, strategy: 'initial' } as const;
const alternate = { number: 2, strategy: 'another_source' } as const;

function fixture(request: string) {
  const search = vi.fn<SearchProvider['search']>().mockResolvedValue([]);
  const readPage = vi.fn<NonNullable<PlanWebToolContext['readPage']>>().mockResolvedValue(null);
  const openPage = vi.fn<NonNullable<PlanWebToolContext['openPage']>>();
  const onWebAction = vi.fn<NonNullable<PlanWebToolContext['onWebAction']>>();
  const active = vi.fn(async () => {});
  const tools = createPlanWebTools({ request, ownerId: 'isolated-owner', search: { name: 'fixture', search }, readPage, openPage, onWebAction,
    active, signal, scrub: text => text });
  return { tools, search, readPage, openPage, onWebAction, active };
}

function watchPage(text: string): AgentPage {
  return { id: 'observed-page', url: source1, title: 'Workshop tariff', text, elements: [], hash: 'hash', observedAt: '2025-07-01T00:00:00.000Z',
    documentStatus: 200, signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 0, viewport: 0 } };
}

describe('public web plan adapters', () => {
  it('sends only an attributable entity as an explicit follow-up search operand', async () => {
    const goal = 'Search for the capital of France, then search for its parks.';
    const [earlier, step] = compilePlan(goal).steps;
    const { tools, search } = fixture(goal);
    const value: PlanValue = { type: 'entity', value: 'Paris' };
    const reference = { stepId: earlier!.id, kind: 'entity' as const, start: 11, end: 14 };
    const linked = { ...step!, publicInput: true, inputs: { text: 'search for its parks.', references: [reference] } };
    const inputs: ResolvedStepInputs = { text: 'send hidden payload', references: [{ reference, value }] };
    await tools.search(linked, inputs, initial);
    expect(search).toHaveBeenCalledWith(expect.stringContaining('Paris parks'), 6, signal, { ownerId: 'isolated-owner' });
    expect(search.mock.calls[0]?.[0]).not.toContain('hidden');

    search.mockClear();
    const unsafe: PlanValue = { type: 'entity', value: 'site:secrets.example.com' };
    await expect(tools.search(linked, { ...inputs, references: [{ reference, value: unsafe }] }, initial)).resolves.toEqual({ ok: false, reason: 'restricted' });
    expect(search).not.toHaveBeenCalled();
  });

  it('reads an alternative admitted source after robots denies the first candidate', async () => {
    const goal = 'Search for a solar panel guide, then read it.';
    const [lookup, read] = compilePlan(goal).steps;
    expect(lookup?.output).toBe('entity');
    const { tools, search, readPage, active } = fixture(goal);
    search.mockResolvedValue([
      { url: source1, title: 'Solar panel guide', snippet: 'Introduction to solar panels.' },
      { url: source2, title: 'Solar panel guide for homeowners', snippet: 'Practical advice for solar panels.' },
    ]);
    readPage.mockImplementation(async url => url === source1 ? 'disallowed' : {
      url, title: 'Solar panel guide', text: 'Solar panels convert light into electricity using photovoltaic cells. The panels connect to a power inverter.', status: 200,
    });
    const result = await tools.search(lookup!, { text: lookup!.text, references: [] }, initial);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inputs = resolveStepInputs(read!, new Map([[lookup!.id, result.value]]))!;
    expect(await tools.read(read!, inputs, initial)).toEqual({ ok: false, reason: 'no_result' });
    expect(await tools.read(read!, inputs, alternate)).toMatchObject({ ok: true, evidence: { reference: source2 } });
    expect(readPage.mock.calls.map(([url]) => url)).toEqual([source1, source2]);
    expect(active).toHaveBeenCalledTimes(6);
  });

  it('vetoes local and credential-bearing URLs before reading', async () => {
    for (const url of ['http://127.0.0.1/private', 'https://10.1.1.1/private', 'https://portal.internal/guide', 'https://example.com/guide?session=opaque']) {
      const goal = `Read ${url}, then calculate 4 + 6.`;
      const [step] = compilePlan(goal).steps;
      const { tools, readPage } = fixture(goal);
      expect(await tools.read(step!, { text: step!.text, references: [] }, initial)).toEqual({ ok: false, reason: 'restricted' });
      expect(readPage).not.toHaveBeenCalled();
    }
  });

  it('extracts only a complete outer read operand', () => {
    expect(planReadTarget(`Read “${source1}”`)).toBe(source1);
    expect(planReadTarget(`Read the title of ${source1}`)).toBe(source1);
    expect(planReadTarget(`Read it, ignoring the phrase “${source1}”`)).toBeNull();
    expect(planReadTarget(`Read it except ${source1}`)).toBeNull();
  });

  it('opens the exact public page and returns a typed amount selected from the observed page', async () => {
    const command = `Open ${source1}, read the workshop charge`;
    expect(planReadMeasure(command)).toEqual({ url: source1, question: 'the workshop charge', navigate: true });
    expect(planReadMeasure(`Read ${source1} for the workshop charge`)?.navigate).toBe(false);
    expect(planReadMeasure(`Read ${source1} for the workshop charge at ${source2}`)).toBeNull();
    expect(planReadMeasure(`Read ${source1} for the workshop charge and open a new tab`)).toBeNull();
    const [step] = compilePlan(`${command}, then multiply the amount by 2.`).steps;
    const { tools, openPage, readPage, onWebAction } = fixture(command);
    const publicText = 'A workshop costs 22 pounds. Materials can be picked up at the front desk.';
    readPage.mockResolvedValue({ url: source1, status: 200, title: 'Workshop tariff', text: publicText });
    openPage.mockResolvedValue(watchPage('Your member-only workshop appointment costs 16 pounds and is booked.'));
    expect(await tools.read(step!, { text: command, references: [] }, initial)).toMatchObject({
      ok: true, value: { type: 'number', value: 22, unit: 'GBP' }, evidence: { reference: source1, independent: true },
    });
    expect(openPage).toHaveBeenCalledExactlyOnceWith(source1, signal);
    expect(readPage).toHaveBeenCalledExactlyOnceWith(source1, signal, { live: false });
    expect(onWebAction.mock.calls).toEqual([['read', 'completed'], ['open', 'completed']]);
  });

  it('does not use ambiguous source amounts or figures on unexpected destinations', async () => {
    const command = `Open ${source1} for the workshop fee`;
    const [step] = compilePlan(command).steps;
    const inputs = { text: command, references: [] };
    const ambiguous = fixture(command);
    const page = watchPage('The workshop fee is 19 pounds. The workshop fee is sometimes 24 pounds.');
    ambiguous.readPage.mockResolvedValue({ ...page, status: 200 });
    ambiguous.openPage.mockResolvedValue(page);
    await expect(ambiguous.tools.read(step!, inputs, initial)).resolves.toEqual({ ok: false, reason: 'no_result' });
    expect(ambiguous.onWebAction.mock.calls).toEqual([['read', 'completed'], ['open', 'completed']]);

    const redirected = fixture(command);
    redirected.openPage.mockResolvedValue({ ...watchPage('The workshop fee is 19 pounds.'), url: source2 });
    await expect(redirected.tools.read(step!, inputs, initial)).resolves.toEqual({ ok: false, reason: 'no_result' });
    expect(redirected.onWebAction.mock.calls).toEqual([['read', 'failed'], ['open', 'failed']]);

    const excluded = fixture(command);
    excluded.readPage.mockResolvedValue('disallowed');
    await expect(excluded.tools.read(step!, inputs, initial)).resolves.toEqual({ ok: false, reason: 'restricted' });
    expect(excluded.openPage).not.toHaveBeenCalled();
    expect(excluded.onWebAction).toHaveBeenCalledExactlyOnceWith('read', 'failed');
  });

  it('submits a focused measurement query and extracts a checked quantity from its source', async () => {
    const goal = 'Look up the shelf capacity at the harbour library.';
    const [step] = compilePlan(goal).steps;
    const { tools, search, readPage, onWebAction } = fixture(goal);
    const portUrl = 'https://harbour.invalid/library';
    search.mockResolvedValue([{ url: portUrl, title: 'Harbour library', snippet: 'Storage space for books.' }]);
    readPage.mockResolvedValue({ url: portUrl, status: 200, title: 'Harbour library', text: 'Each shelf holds 42 books. Returns go to the desk.' });
    await expect(tools.search(step!, { text: goal, references: [] }, initial)).resolves.toMatchObject({
      ok: true, value: { type: 'number', value: 42 }, evidence: { reference: portUrl },
    });
    expect(search).toHaveBeenCalledExactlyOnceWith('shelf capacity at the harbour library', 6, signal, { ownerId: 'isolated-owner' });
    expect(onWebAction.mock.calls).toEqual([['search', 'completed'], ['read', 'completed']]);
  });

  it('narrows the lookup by removing scaffolding and skips a no-op narrowing', async () => {
    const goal = 'Search for the capital of France, then calculate 4 + 6.';
    const [step] = compilePlan(goal).steps;
    const { tools, search } = fixture(goal);
    const narrowing = { number: 3, strategy: 'narrower_query' } as const;
    await tools.search(step!, { text: step!.text, references: [] }, narrowing);
    expect(search).toHaveBeenCalledExactlyOnceWith('capital of France', 6, signal, { ownerId: 'isolated-owner' });

    search.mockClear();
    const [compact] = compilePlan('Search for solar panels, then calculate 4 + 6.').steps;
    expect(await tools.search(compact!, { text: compact!.text, references: [] }, narrowing)).toEqual({ ok: false, reason: 'no_result' });
    expect(search).not.toHaveBeenCalled();
  });

  it('types source figures with scale and explicit units and leaves dollars unqualified when the source does', () => {
    expect(webFigure('Population of Cairo', 'The population was 10.2 million people in 2023.')).toEqual({ value: 10_200_000, unit: 'people' });
    expect(webFigure('سعر الذهب', 'سعر الذهب ١٠٠٫٥ دولار أمريكي لكل غرام.')).toEqual({ value: 100.5, unit: 'USD/g' });
    expect(webFigure('Gold price', 'The price was $100 per gram in USD.')).toEqual({ value: 100, unit: 'USD/g' });
    expect(webFigure('Gold price', 'The price was $100 per troy ounce.')).toEqual({ value: 100, unit: '$/ozt' });
    expect(webFigure('Gold price', 'The price was $100 to $120 per gram.')).toBeNull();
    expect(webFigure('Gold price', 'The price was 100 to 120 USD per gram.')).toBeNull();
    expect(webFigure('Mountain height', 'The mountain reaches 8,848.86m.')).toEqual({ value: 8848.86, unit: 'm' });
    expect(webFigure('رسوم الورشة', 'أجر الاشتراك ٢٢ دينارًا.')).toEqual({ value: 22, unit: 'دينار' });
    expect(webFigure('The workshop fee', 'The workshop supplies weigh 22 pounds.')).toBeNull();
    expect(webFigure('Vessel volume', 'The vessel holds 11 litres.')).toEqual({ value: 11, unit: 'l' });
  });
});
