import { describe, expect, it } from 'vitest';
import type { AgentPage } from '@mohassan/browser';
import { newGoalState, observeFailure, observeOutcome, requestedSites, reviewOpen, reviewStop, stagnationWarning } from '../apps/server/src/assistant/goal-integrity.js';

const SITE = 'http://127.0.0.1:5000';
let hashes = 0;
function page(path: string, links: [string, string][] = [], status?: number, hash?: string): AgentPage {
  return {
    id: 'p', url: `${SITE}${path}`, title: path, text: '', hash: hash ?? `h${++hashes}`, observedAt: '', ...(status ? { documentStatus: status } : {}),
    signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 1, viewport: 1 },
    elements: links.map(([label, href], index) => ({ ref: `e${index}`, role: 'link', label, href: href.startsWith('http') ? href : `${SITE}${href}`, inViewport: true })),
  };
}

describe('goal contract', () => {
  it('reads the addresses a request names', () => {
    expect(requestedSites('افتح http://127.0.0.1:5000/ واقرأ السعر، ثم https://example.com/a?b=1.')).toEqual([SITE, 'https://example.com']);
    expect(requestedSites('ما عاصمة فرنسا؟')).toEqual([]);
  });
  it('withholds one answer or question given before the named site was opened', () => {
    const goal = newGoalState(`افتح ${SITE}/ وأخبرني بالسعر`);
    expect(reviewStop(goal, { tool: 'ask_user' }, null)).toContain(SITE);
    expect(reviewStop(goal, { tool: 'ask_user' }, null)).toBeUndefined();
  });
  it('lets an answer through once the site was reached, even on a temporary error', () => {
    const goal = newGoalState(`افتح ${SITE}/`);
    observeOutcome(goal, 'open', page('/', [], 503), true);
    expect(reviewStop(goal, { tool: 'answer', outcome: 'done' }, null)).toBeUndefined();
  });
  it('never checks a request without an address or a finished answer', () => {
    const goal = newGoalState('ما عاصمة فرنسا؟');
    expect(reviewStop(goal, { tool: 'answer', outcome: 'done' }, null)).toBeUndefined();
  });
});

describe('premature give-up', () => {
  it('asks to retry a temporary server error before giving up', () => {
    const goal = newGoalState(`افتح ${SITE}/`);
    observeOutcome(goal, 'open', page('/', [['التقرير', '/report']]), true);
    const failed = page('/report', [], 503);
    observeOutcome(goal, 'click', failed, true);
    expect(reviewStop(goal, { tool: 'answer', outcome: 'blocked' }, failed)).toContain(`${SITE}/report`);
  });
  it('clears the retry once the page loads', () => {
    const goal = newGoalState(`افتح ${SITE}/`);
    observeOutcome(goal, 'open', page('/report', [], 503), true);
    observeOutcome(goal, 'open', page('/report'), true);
    expect(goal.transient).toEqual([]);
  });
  it('names unopened links on the site, current page first, and spends at most two nudges', () => {
    const goal = newGoalState(`افتح ${SITE}/`);
    observeOutcome(goal, 'open', page('/', [['أ', '/a'], ['خارجي', 'https://other.example/x']]), true);
    const old = page('/old', [['الصفحة الجديدة', '/new']]);
    observeOutcome(goal, 'click', old, true);
    const first = reviewStop(goal, { tool: 'answer', outcome: 'partial' }, old)!;
    expect(first.indexOf('الصفحة الجديدة')).toBeLessThan(first.indexOf('«أ»'));
    expect(first).not.toContain('خارجي');
    expect(reviewStop(goal, { tool: 'ask_user' }, old)).toBeDefined();
    expect(reviewStop(goal, { tool: 'ask_user' }, old)).toBeUndefined();
  });
  it('does not hold an answer when every link was opened', () => {
    const goal = newGoalState(`افتح ${SITE}/`);
    observeOutcome(goal, 'open', page('/', [['أ', '/a']]), true);
    observeOutcome(goal, 'click', page('/a'), true);
    expect(reviewStop(goal, { tool: 'answer', outcome: 'blocked' }, page('/a'))).toBeUndefined();
  });
});

describe('stagnation', () => {
  it('warns once per page after two looks that show nothing new', () => {
    const goal = newGoalState(`افتح ${SITE}/`);
    const list = page('/list', [['التالي', '/list?page=2']], undefined, 'same');
    observeOutcome(goal, 'open', list, true);
    expect(stagnationWarning(goal, list)).toBeUndefined();
    observeOutcome(goal, 'scroll', list, true);
    observeOutcome(goal, 'read_more', undefined, true);
    expect(stagnationWarning(goal, list)).toContain('«التالي»');
    observeOutcome(goal, 'scroll', list, true);
    expect(stagnationWarning(goal, list)).toBeUndefined();
  });
  it('escalates once to an answer after six steps without progress', () => {
    const goal = newGoalState('');
    for (let step = 0; step < 6; step++) observeFailure(goal);
    expect(stagnationWarning(goal, null)).toContain('Answer now');
    observeFailure(goal);
    expect(stagnationWarning(goal, null)).toBeUndefined();
  });
  it('counts a new page, new content after an action, or a new search result as progress', () => {
    const goal = newGoalState('');
    observeFailure(goal);
    observeFailure(goal);
    observeOutcome(goal, 'search', undefined, true);
    expect(goal.stagnant).toBe(0);
    observeOutcome(goal, 'open', page('/x', [], undefined, 'one'), true);
    observeOutcome(goal, 'click', page('/x', [], undefined, 'two'), true);
    expect(goal.stagnant).toBe(0);
    observeOutcome(goal, 'scroll', page('/x', [], undefined, 'three'), true);
    expect(goal.stagnant).toBe(1);
  });
});

describe('scope', () => {
  it('withholds the first guessed address and lets a repeat through', () => {
    const goal = newGoalState('كم يوماً يستمر مهرجان الواحة؟');
    expect(reviewOpen(goal, 'https://www.guess.example/', 'كم يوماً يستمر مهرجان الواحة؟', [])).toContain('https://www.guess.example');
    expect(reviewOpen(goal, 'https://www.guess.example/', 'كم يوماً يستمر مهرجان الواحة؟', [])).toBeUndefined();
  });
  it('accepts addresses from the request, search results or seen links', () => {
    const goal = newGoalState(`افتح ${SITE}/`);
    expect(reviewOpen(goal, `${SITE}/deep`, '', [])).toBeUndefined();
    expect(reviewOpen(goal, 'https://found.example/a', '', ['https://found.example/x'])).toBeUndefined();
    expect(reviewOpen(goal, 'https://bbc.com/news', 'افتح bbc.com', [])).toBeUndefined();
    observeOutcome(goal, 'open', page('/', [['خارجي', 'https://linked.example/p']]), true);
    // A link to another site is not offered as a next step, but opening it is no guess.
    expect(goal.links.map(link => link.url)).not.toContain('https://linked.example/p');
    expect(reviewOpen(goal, 'https://linked.example/p', '', [])).toBeUndefined();
  });
});
