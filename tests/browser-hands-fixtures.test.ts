import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser, BrowserError, evidenceHash, type AgentAction, type AgentAuthority, type AgentPage } from '@mohassan/browser';
import { newBrowserTaskProgress, runBrowserTask, type BrowserTaskLog, type BrowserTaskProgress } from '../apps/server/src/assistant/browser-task-runner.js';
import type { BrowserTaskSpec, BrowserTaskStep, BrowserTaskSuccess } from '../apps/server/src/assistant/browser-task-spec.js';
import {
  findBrowserHandsElement,
  type BrowserHandsTarget,
} from '../packages/browser/src/browser-hands-dom.js';
import { waitForBrowserHumanProgress } from '../packages/browser/src/browser-hands-human.js';
import {
  locales, ownerButton, startBrowserHandsFixture, words, type FixtureConsent,
  type FixtureControl, type FixtureJourney, type FixtureLocale, type FixtureTarget, type FixtureWall,
} from './fixtures/browser-hands-site.js';

const owner = 'browser-hands-fixtures';
type Category = 'reading' | 'targeting' | 'writing' | 'privacy' | 'human-only' | 'navigation';
const scores = new Map<Category, {
  attempted: number; completed: number; wrongActions: number; correctHandovers: number;
  falseHandovers: number; resumed: number; readbacks: number;
}>();
let server: Awaited<ReturnType<typeof startBrowserHandsFixture>>;
let profile: string;
let browser: AgentBrowser;

beforeAll(async () => {
  server = await startBrowserHandsFixture();
  profile = await mkdtemp(join(tmpdir(), 'mohassan-browser-hands-'));
  browser = new AgentBrowser({ profileDir: profile, testOrigins: [server.origin], channel: null, browserHands: true, settleQuietMs: 50 });
});

afterAll(async () => {
  const report = Object.fromEntries(scores);
  console.info('Browser fixture results (local, deterministic, never used for training)', JSON.stringify(report));
  await browser?.close();
  await server?.close();
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const successByKind: Record<BrowserTaskStep['kind'], BrowserTaskSuccess['kind']> = {
  open: 'page-open', find: 'element-found', read: 'content-read', fill: 'value-read-back', select: 'value-read-back',
  click: 'effect-observed', download: 'file-downloaded', upload: 'file-selected',
};
type FixtureOutcome = Awaited<ReturnType<typeof runBrowserTask>>;

function register(category: Category, name: string, path: string, perform: (task: FixtureTask) => Promise<void>) {
  it(`${category}: ${name}`, async () => {
    const score = scores.get(category) ?? { attempted: 0, completed: 0, wrongActions: 0, correctHandovers: 0, falseHandovers: 0, resumed: 0, readbacks: 0 };
    scores.set(category, score);
    score.attempted++;
    const id = randomUUID();
    const authority: AgentAuthority = {
      signal: new AbortController().signal, assertActive: async () => {},
      dispatched: async () => { throw new Error('Fixture task dispatched an unexpected approval permit'); }, completed: async () => {},
    };
    const act = (action: AgentAction) => browser.act(owner, id, action, authority);
    try {
      const observed = (await act({ kind: 'open', text: server.origin + path })).page;
      const logs: BrowserTaskLog[] = [];
      const task: FixtureTask = {
        id, observed, authority, act, logs,
        live: async () => (await browser['conversation'](owner, id)).page,
        async run(steps, state = newBrowserTaskProgress(), page = observed) {
          const spec: BrowserTaskSpec = {
            target: { kind: 'current' }, steps, requiredData: [],
            success: steps.map((step, index) => ({ step: index, kind: successByKind[step.kind] })),
            risk: steps.some(step => step.risk === 'reversible-write') ? 'reversible-write' : 'read-only',
            lang: path.split('/')[2] as FixtureLocale,
          };
          const outcome = await runBrowserTask(spec, state, {
            signal: authority.signal,
            observe: async () => (await browser.observe(owner, id)).page,
            act,
            prepare: action => browser.prepareAction(owner, id, action),
            search: async () => { throw new Error('Fixture should not search the web'); },
            begin: async () => {},
            record: async (_index, log) => { logs.push(log); },
            text: value => value,
            rethrow: error => { if (!(error instanceof BrowserError)) throw error; },
          }, page);
          if (category !== 'human-only' && outcome.status === 'human') score.falseHandovers++;
          return outcome;
        },
        scoreHandover(outcome, expected) {
          if (outcome.status === 'human' && outcome.wait.step.reason === expected) score.correctHandovers++;
          else if (outcome.status === 'human') score.falseHandovers++;
        },
        action(actual, expected) {
          if (actual !== expected) score.wrongActions++;
          expect(actual).toBe(expected);
        },
        resumed: () => { score.resumed++; },
        readback: () => { score.readbacks++; },
      };
      await perform(task);
      score.completed++;
    } finally {
      await browser.closeConversation(owner, id);
    }
  });
}

interface FixtureTask {
  id: string;
  observed: AgentPage;
  authority: AgentAuthority;
  act(action: AgentAction): ReturnType<AgentBrowser['act']>;
  logs: BrowserTaskLog[];
  run(steps: BrowserTaskStep[], state?: BrowserTaskProgress, page?: AgentPage): Promise<FixtureOutcome>;
  live(): Promise<Awaited<ReturnType<AgentBrowser['conversation']>>['page']>;
  scoreHandover(outcome: FixtureOutcome, expected: string): void;
  action(actual: unknown, expected: unknown): void;
  resumed(): void;
  readback(): void;
}

function completion(outcome: FixtureOutcome) {
  expect(outcome, outcome.status === 'partial' || outcome.status === 'blocked' ? outcome.text : undefined).toMatchObject({ status: 'completed' });
  if (outcome.status !== 'completed') throw new Error('Fixture did not complete');
  return outcome.text;
}

function readback(task: FixtureTask) {
  expect(task.logs).toContainEqual(expect.objectContaining({ kind: 'readback', verified: true, text: expect.stringContaining('••••') }));
  task.readback();
}

function bound(page: AgentPage, kind: 'click' | 'type' | 'select', ref: string, text?: string): AgentAction {
  return { kind, ref, ...(text === undefined ? {} : { text }), browserHands: { url: page.url } };
}

describe('browser hands with actual Chromium and static local sites', () => {
  for (const locale of locales) {
    const t = words[locale];
    const readingSections = ['main', 'tables', 'lists', 'forms'] as const;
    for (const section of readingSections) {
      register('reading', `${locale} ${section}`, `/read/${locale}/data`, async task => {
        const text = completion(await task.run([{ kind: 'read', section, risk: 'read-only' }]));
        const content = task.observed.content?.[0];
        expect(content?.direction).toBe(locale === 'ar' ? 'rtl' : 'ltr');
        switch (section) {
          case 'main':
            expect(text).toContain('fixture-main-27');
            expect(content?.main).toContain(t.heading);
            expect(content?.main).not.toContain('Site header');
            expect(content?.main).not.toContain('Site footer');
            break;
          case 'tables':
            expect(content?.tables[0]?.rows).toEqual([[t.region, t.count], [t.first, '17'], [t.second, '29']]);
            expect(text).toContain(`${t.region} | ${t.count}`);
            break;
          case 'lists':
            expect(content?.lists).toContainEqual({ ordered: true, items: [...t.list] });
            expect(text).toContain(`1. ${t.list[0]}`);
            break;
          case 'forms':
            expect(content?.forms).toContainEqual({
              label: t.heading, fields: [{ label: t.label, role: 'textbox', value: t.draft }],
            });
            expect(text).toContain(t.draft);
            break;
        }
      });
    }

    const targetKinds: FixtureTarget[] = ['role', 'label', 'placeholder', 'context', 'position', 'frame', 'shadow'];
    for (const variant of targetKinds) {
      register('targeting', `${locale} ${variant}`, `/target/${locale}/${variant}`, async task => {
        const target: BrowserHandsTarget = {
          name: variant === 'placeholder' ? t.search : t.action,
          ...(variant === 'label' || variant === 'placeholder' ? {} : { role: locale === 'ar' ? 'زر' : 'button' }),
          ...(variant === 'context' ? { nearby: t.context } : {}),
          ...(variant === 'position' ? { position: 2 } : {}),
        };
        const input = variant === 'label' || variant === 'placeholder';
        const { observed } = task;
        if (variant === 'position') {
          const { position: _position, ...unqualified } = target;
          expect(findBrowserHandsElement(observed.elements, unqualified, { kind: 'click' }).status).toBe('ambiguous');
        }
        const { name, ...match } = target;
        completion(await task.run(input
          ? [{ kind: 'fill', target: name, match, value: '37', risk: 'reversible-write' }]
          : [{ kind: 'click', target: name, match, risk: 'reversible-write' }]));
        if (input) {
          const live = await task.live();
          task.action(await live.locator('#target').inputValue(), '37');
          task.action(await live.locator('input').nth(1).inputValue(), '');
          readback(task);
        } else {
          const live = await task.live();
          const title = variant === 'frame' ? await live.frames()[1]?.title() : await live.title();
          task.action(title, 'right');
        }
      });
    }

    const values: Record<FixtureControl, { command: string; expected: string | boolean }> = {
      input: { command: '37', expected: '37' }, textarea: { command: '37\n61', expected: '37\n61' },
      rich: { command: '37', expected: '37' }, select: { command: t.option, expected: 'two' },
      date: { command: '2026-11-25', expected: '2026-11-25' }, checkbox: { command: 'true', expected: true },
      radio: { command: 'true', expected: true },
    };
    for (const [variant, value] of Object.entries(values) as Array<[FixtureControl, typeof values[FixtureControl]]>) {
      register('writing', `${locale} ${variant}`, `/control/${locale}/${variant}`, async task => {
        const selection = ['select', 'checkbox', 'radio'].includes(variant);
        completion(await task.run([{
          kind: selection ? 'select' : 'fill', target: t.label, value: value.command, risk: 'reversible-write',
        }]));
        const live = await task.live();
        const field = live.locator('#field');
        const actual = variant === 'rich' ? await field.innerText()
          : variant === 'checkbox' || variant === 'radio' ? await field.isChecked()
          : await field.inputValue();
        task.action(actual, value.expected);
        task.action(variant === 'radio' ? await live.locator('#untouched').isChecked() : await live.locator('#untouched').inputValue(),
          variant === 'radio' ? false : 'unchanged');
        readback(task);
      });
    }

    const consentCases: FixtureConsent[] = ['reject', 'necessary', 'both', 'accept-only', 'absent'];
    for (const variant of consentCases) {
      register('privacy', `${locale} ${variant}`, `/cookie/${locale}/${variant}`, async task => {
        const steps: BrowserTaskStep[] = variant === 'reject'
          ? [{ kind: 'open', url: task.observed.url, name: 'Cookie fixture', risk: 'read-only' }]
          : [{ kind: 'read', section: 'main', risk: 'read-only' }];
        const text = completion(await task.run(steps));
        const expected = { absent: 'Browser fixture', 'accept-only': 'Browser fixture', necessary: 'necessary', both: 'reject', reject: 'reject' };
        task.action(await (await task.live()).title(), expected[variant]);
        expect(text).toContain(variant === 'reject' ? 'reject' : 'fixture-main-27');
      });
    }

    const walls: Record<FixtureWall, 'login' | 'code' | 'bot_check' | 'payment' | 'identity'> = {
      login: 'login', code: 'code', bot: 'bot_check', payment: 'payment', identity: 'identity', 401: 'login', 403: 'login',
    };
    for (const [variant, expected] of Object.entries(walls) as Array<[FixtureWall, typeof walls[FixtureWall]]>) {
      register('human-only', `${locale} ${variant}`, `/wall/${locale}/${variant}`, async task => {
        const { observed } = task;
        const steps: BrowserTaskStep[] = [{ kind: 'read', section: 'main', risk: 'read-only' }];
        if (variant === 'identity') steps.unshift({ kind: 'fill', target: 'National ID number', risk: 'reversible-write' });
        const state = newBrowserTaskProgress();
        const outcome = await task.run(steps, state);
        task.scoreHandover(outcome, expected);
        expect(outcome).toMatchObject({ status: 'human', wait: { step: { reason: expected } } });
        if (outcome.status !== 'human') throw new Error('Fixture wall did not trigger handover');
        const handover = outcome.wait.step;
        expect(handover.prompt).toMatch(/\p{Script=Arabic}/u);
        expect(handover.prompt).toContain('127.0.0.1');
        if (variant === 'login' || variant === 'code' || variant === 'payment' || variant === 'identity') {
          const field = observed.elements.find(element => element.match?.humanOnly);
          expect(field).toBeDefined();
          await expect(task.act(bound(observed, 'type', field!.ref, '000000'))).rejects.toMatchObject({ code: 'AGENT_HUMAN_STEP' });
          const live = await task.live();
          task.action(await live.locator('#guard').inputValue(), '');
          task.action(await live.locator('body').getAttribute('data-input-events'), '0');
        }
        await browser.pointer(owner, task.id, ownerButton.x, ownerButton.y);
        const progress = await waitForBrowserHumanProgress({
          step: handover, originalUrl: observed.url, observe: () => browser.observeHands(owner, task.id),
          intervalMs: 40, timeoutMs: 3000,
        });
        expect(progress.status).toBe('clear');
        if (progress.status !== 'clear') throw new Error('Fixture handover did not clear');
        const resumed = await browser.finishHandsHandover(owner, task.id, progress.page, task.authority);
        expect(resumed?.text).toContain('fixture-main-27');
        if (!resumed) throw new Error('Fixture handover could not release the browser');
        state.waiting = outcome.wait;
        state.humanResult = { status: 'clear', page: { urlHash: evidenceHash(resumed.url), hash: resumed.hash } };
        expect(completion(await task.run(steps, state, resumed))).toContain('fixture-main-27');
        task.resumed();
      });
    }

    const journeys: FixtureJourney[] = ['wizard', 'popup', 'next', 'more', 'late'];
    for (const variant of journeys) {
      register('navigation', `${locale} ${variant}`, `/journey/${locale}/${variant}`, async task => {
        if (variant === 'next' || variant === 'more') {
          const text = completion(await task.run([{ kind: 'read', section: 'lists', more: true, risk: 'read-only' }]));
          for (const index of [1, 2, 3]) task.action(text.includes(`fixture-row-${index}`), true);
          return;
        }
        if (variant === 'late') {
          completion(await task.run([{ kind: 'click', target: t.action, risk: 'reversible-write' }]));
          task.action(await (await task.live()).title(), 'right');
          return;
        }
        const sequence = variant === 'popup' ? [t.popup] : [t.next, t.review, t.finish];
        completion(await task.run(sequence.map(target => ({ kind: 'click', target, risk: 'reversible-write' }))));
        task.action((await (await task.live()).locator('main').innerText()).includes(t.ready), true);
      });
    }
  }
});

register('targeting', 'a loose match for a destructive action still needs approval', '/approval/en/record', async task => {
  const before = server.approvedActions();
  const steps: BrowserTaskStep[] = [{ kind: 'click', target: 'record', risk: 'reversible-write' }];
  const state = newBrowserTaskProgress();
  const outcome = await task.run(steps, state);
  expect(outcome).toMatchObject({ status: 'approval', approval: { permit: { method: 'POST' } } });
  task.action(server.approvedActions(), before);
  if (outcome.status !== 'approval' || !('permit' in outcome.approval)) throw new Error('Fixture expected an action-bound approval');
  const { permit, action } = outcome.approval;
  const approved = { ...task.authority, dispatched: async () => permit.id };
  const result = await browser.act(owner, task.id, action, approved, permit);
  task.action(server.approvedActions(), before + 1);
  state.approval!.released = true;
  completion(await task.run(steps, state, result.page));
});
