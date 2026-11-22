import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

/**
 * What the user actually sees for the local paths (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md E5.2):
 * the time from pressing Enter until the answer text is in the conversation log, measured in a real browser
 * against the isolated fixture server. 0-baseline §2 only estimated this (about 0.93 s) from the 900 ms poll;
 * the server itself answers these requests in 15–45 ms. Results go to artifacts/perceived-latency-<date>/.
 * Not a pass/fail gate: the proposed E5.2 bar (p95 ≤ 0.3 s) is recorded next to the numbers for the owner.
 */
const ROUNDS = Number(process.env.LATENCY_ROUNDS ?? 8);
const CASES: { kind: 'compute' | 'chat'; text: string; expect: string }[] = [
  { kind: 'compute', text: 'كم 15 ضرب 23؟', expect: '345' },
  { kind: 'chat', text: 'مرحبا', expect: 'مرحبًا! كيف أساعدك؟' },
  { kind: 'compute', text: 'كم 7 ضرب 8؟', expect: '56' },
  { kind: 'compute', text: 'احسب 15% من 240', expect: '36' },
];
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0; return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), min: Math.round(sorted[0] ?? 0), max: Math.round(sorted.at(-1) ?? 0) }; };

async function sendAndTime(page: Page, text: string, expected: string): Promise<{ perceivedMs: number; serverMs: number | null }> {
  const box = page.getByRole('textbox', { name: 'رسالتك' });
  await box.fill(text);
  // Before the first message there is no conversation log yet; count earlier occurrences only when it exists.
  const before = await page.evaluate(() => document.querySelector('[role="log"]')?.textContent ?? '');
  const count = before.split(expected).length - 1;
  const posted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith('/api/chat/conversations'));
  const started = Date.now();
  await box.press('Enter');
  const response = await posted;
  const accepted = Date.now() - started;
  // Poll the DOM every 20 ms so the measurement, not Playwright's expect schedule, sets the granularity.
  await page.waitForFunction(([needle, previous]) => ((document.querySelector('[role="log"]')?.textContent ?? '').split(needle).length - 1) > previous, [expected, count] as const, { polling: 20, timeout: 30000 });
  const perceivedMs = Date.now() - started;
  return { perceivedMs, serverMs: response.ok() ? accepted : null };
}

test('local paths: time to the answer on screen, in a real browser', async ({ page }) => {
  test.setTimeout(300000);
  await signInAsFixtureOwner(page, 'assistant');
  await expect(page.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
  const samples: { round: number; kind: string; text: string; perceivedMs: number; acceptMs: number | null }[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const item of CASES) {
      const { perceivedMs, serverMs } = await sendAndTime(page, item.text, item.expect);
      samples.push({ round, kind: item.kind, text: item.text, perceivedMs, acceptMs: serverMs });
    }
  }
  const byKind = Object.fromEntries(['compute', 'chat'].map(kind => [kind, stats(samples.filter(sample => sample.kind === kind).map(sample => sample.perceivedMs))]));
  const all = stats(samples.map(sample => sample.perceivedMs));
  const accept = stats(samples.flatMap(sample => sample.acceptMs === null ? [] : [sample.acceptMs]));
  const results = { at: new Date().toISOString(), rounds: ROUNDS, cases: CASES.map(item => item.text), perceivedMs: { all, ...byKind }, postRoundTripMs: accept,
    proposedBar: 'E5.2: p95 of what the user sees for local paths ≤ 300 ms (proposed, not fixed by the owner)', samples };
  const out = path.resolve('artifacts', `perceived-latency-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const table = ['| path | n | p50 ms | p95 ms | min | max |', '|---|---|---|---|---|---|',
    `| all | ${all.n} | ${all.p50} | ${all.p95} | ${all.min} | ${all.max} |`,
    ...Object.entries(byKind).map(([kind, value]) => `| ${kind} | ${value.n} | ${value.p50} | ${value.p95} | ${value.min} | ${value.max} |`),
    `| POST round trip | ${accept.n} | ${accept.p50} | ${accept.p95} | ${accept.min} | ${accept.max} |`].join('\n');
  writeFileSync(path.join(out, 'README.md'), `# Perceived latency of local paths (real browser)\n\nMeasured ${results.at}, ${ROUNDS} rounds × ${CASES.length} requests against the isolated e2e fixture.\n\n${table}\n\n${results.proposedBar}\n`);
  console.log(table);
  expect(samples.length).toBe(ROUNDS * CASES.length);
});
