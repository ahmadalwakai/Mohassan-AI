import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';
import { signInAsFixtureOwner } from './helpers';

/**
 * What the user actually sees for the local paths (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md E5.2):
 * the time from pressing Enter until the answer text is in the conversation log, measured in a real browser
 * against the isolated fixture server, and where that time goes:
 *   post      Enter to the end of the POST that sends the message
 *   wait      end of the POST to the start of the poll (GET) that brought the answer
 *   poll      that GET's own round trip
 *   render    end of that GET to the answer on screen
 * The poll interval comes from POLL_MS in apps/web/components/assistant-app.tsx. Results go to
 * artifacts/perceived-latency-<date>/. Not a pass/fail gate: the proposed E5.2 bar (p95 ≤ 0.3 s) is recorded next to
 * the numbers for the owner.
 */
const ROUNDS = Number(process.env.LATENCY_ROUNDS ?? 8);
type Case = { kind: 'compute' | 'chat'; text: string; expect: string };
/** Different numbers every round: the chat treats a repeated identical message as a replay and adds nothing. */
function casesFor(round: number): Case[] {
  const a = 11 + round, b = 13 + round, percent = 10 + 5 * round;
  return [
    { kind: 'compute', text: `كم ${a} ضرب ${b}؟`, expect: String(a * b) },
    ...(round === 0 ? [{ kind: 'chat' as const, text: 'مرحبا', expect: 'مرحبًا! كيف أساعدك؟' }] : []),
    { kind: 'compute', text: `كم ${b} ضرب ${a + 1}؟`, expect: String(b * (a + 1)) },
    { kind: 'compute', text: `احسب ${percent}% من 200`, expect: String(percent * 2) },
  ];
}
const CASES = casesFor(0);
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0; return { n: sorted.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), min: Math.round(sorted[0] ?? 0), max: Math.round(sorted.at(-1) ?? 0) }; };
type Sample = { round: number; kind: string; text: string; perceivedMs: number; postMs: number | null; waitMs: number | null; pollMs: number | null; renderMs: number | null; polls: number };
/** A conversation detail read: GET /api/chat/conversations/<id>, not the list or a sub-resource. */
const isDetailRead = (response: Response) => response.request().method() === 'GET' && /^\/api\/chat\/conversations\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname);

async function sendAndTime(page: Page, text: string, expected: string): Promise<Omit<Sample, 'round' | 'kind' | 'text'>> {
  // The composer must be idle: no stop button from the previous run; the send button enables only once there is text.
  await expect(page.getByRole('button', { name: 'إيقاف' })).toHaveCount(0);
  const box = page.getByRole('textbox', { name: 'رسالتك' });
  await expect(box).toBeEnabled();
  await box.fill(text);
  await expect(page.getByRole('button', { name: 'إرسال' })).toBeEnabled();
  // Before the first message there is no conversation log yet; count earlier occurrences only when it exists.
  const before = await page.evaluate(() => document.querySelector('[role="log"]')?.textContent ?? '');
  const count = before.split(expected).length - 1;
  const reads: { start: number; end: number }[] = [];
  let postEnd: number | null = null;
  const onResponse = async (response: Response) => {
    const request = response.request();
    const pathname = new URL(response.url()).pathname;
    if (request.method() === 'POST' && pathname.startsWith('/api/chat/conversations')) { await response.finished().catch(() => null); postEnd = Date.now(); return; }
    if (!isDetailRead(response)) return;
    const start = request.timing().startTime;
    await response.finished().catch(() => null);
    reads.push({ start, end: Date.now() });
  };
  page.on('response', onResponse);
  const started = Date.now();
  try {
    await box.press('Enter');
    // Poll the DOM every 20 ms so the measurement, not Playwright's expect schedule, sets the granularity.
    await page.waitForFunction(([needle, previous]) => ((document.querySelector('[role="log"]')?.textContent ?? '').split(needle).length - 1) > previous, [expected, count] as const, { polling: 20, timeout: 30000 });
  } finally { page.off('response', onResponse); }
  const shown = Date.now();
  const perceivedMs = shown - started;
  // The read that brought the answer is the last one that finished before the answer appeared.
  const after = reads.filter(read => postEnd !== null && read.start >= postEnd && read.end <= shown);
  const answer = after.at(-1);
  return {
    perceivedMs,
    postMs: postEnd === null ? null : postEnd - started,
    waitMs: answer && postEnd !== null ? Math.max(0, answer.start - postEnd) : null,
    pollMs: answer ? answer.end - answer.start : null,
    renderMs: answer ? Math.max(0, shown - answer.end) : null,
    polls: after.length,
  };
}

test('local paths: time to the answer on screen, in a real browser', async ({ page }) => {
  test.setTimeout(300000);
  await signInAsFixtureOwner(page, 'assistant');
  await expect(page.getByRole('heading', { name: /كيف أساعدك اليوم/ })).toBeVisible();
  const samples: Sample[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const item of casesFor(round)) {
      const measured = await sendAndTime(page, item.text, item.expect);
      samples.push({ round, kind: item.kind, text: item.text, ...measured });
    }
  }
  const pick = (key: 'perceivedMs' | 'postMs' | 'waitMs' | 'pollMs' | 'renderMs' | 'polls', rows = samples) => stats(rows.flatMap(sample => sample[key] === null ? [] : [sample[key] as number]));
  const byKind = Object.fromEntries(['compute', 'chat'].map(kind => [kind, pick('perceivedMs', samples.filter(sample => sample.kind === kind))]));
  const all = pick('perceivedMs');
  const parts = { postMs: pick('postMs'), waitMs: pick('waitMs'), pollMs: pick('pollMs'), renderMs: pick('renderMs'), polls: pick('polls') };
  const results = { at: new Date().toISOString(), rounds: ROUNDS, cases: CASES.map(item => item.text), requests: samples.length, perceivedMs: { all, ...byKind }, parts,
    proposedBar: 'E5.2: p95 of what the user sees for local paths ≤ 300 ms (proposed, not fixed by the owner)', samples };
  const out = path.resolve('artifacts', `perceived-latency-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const row = (label: string, value: ReturnType<typeof stats>) => `| ${label} | ${value.n} | ${value.p50} | ${value.p95} | ${value.min} | ${value.max} |`;
  const table = ['| measure | n | p50 | p95 | min | max |', '|---|---|---|---|---|---|',
    row('on screen, all (ms)', all), ...Object.entries(byKind).map(([kind, value]) => row(`on screen, ${kind} (ms)`, value)),
    row('post: Enter to POST end (ms)', parts.postMs), row('wait: POST end to answer poll (ms)', parts.waitMs),
    row('poll: answer GET round trip (ms)', parts.pollMs), row('render: GET end to screen (ms)', parts.renderMs), row('polls after the POST (count)', parts.polls)].join('\n');
  writeFileSync(path.join(out, 'README.md'), `# Perceived latency of local paths (real browser)\n\nMeasured ${results.at}, ${ROUNDS} rounds, ${samples.length} requests against the isolated e2e fixture.\n\n${table}\n\n${results.proposedBar}\n`);
  console.log(table);
  expect(samples.length).toBeGreaterThanOrEqual(ROUNDS * 3);
});
