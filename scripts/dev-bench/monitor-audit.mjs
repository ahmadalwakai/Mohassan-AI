import { AsyncLocalStorage } from 'node:async_hooks';
import crypto, { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const context = new AsyncLocalStorage();
const realUUID = crypto.randomUUID;
const fixtureTime = '2026-11-25T12:00:00.000Z';

// Control the two sources of incidental public reply variation identified by PR #95.
crypto.randomUUID = (...args) => {
  const scope = context.getStore();
  if (!scope) return realUUID(...args);
  const bytes = createHash('sha256').update(JSON.stringify([scope.id, scope.ordinal++])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
};
syncBuiltinESMExports();

export const monitorFixtureTime = () => fixtureTime;

export async function observeMonitors(item, observe) {
  const scope = { id: item.id, ordinal: 0, pages: new Map(), turns: [], activeChecks: new Set() };
  for (const page of item.fixture?.pages ?? []) scope.pages.set(new URL(page.url).href, page);
  const observation = await context.run(scope, () => observe(item));
  return { observation, monitorAudit: scope.turns };
}

export function beginMonitorTurn() {
  context.getStore()?.turns.push({ detection: [], management: [], proactive: [], offers: [] });
}

export function observeMonitorCard(card) {
  const turn = context.getStore()?.turns.at(-1);
  if (turn && card?.id && !context.getStore().turns.some(({ offers }) => offers.some(({ id }) => id === card.id))) {
    turn.offers.push({ id: card.id, kind: card.offer ?? null });
  }
}

export function monitorFixtureSearch(provider) {
  const scope = context.getStore();
  if (!scope) return provider;
  scope.searchProvider = provider;
  // The monitor service lives for the fixture database, which is shared by the lane.
  return { name: provider.name, search: (...args) => context.getStore().searchProvider.search(...args) };
}

export function sampleMonitorDecision(kind, decide, classify = true) {
  const scope = context.getStore();
  const turn = scope?.turns.at(-1);
  if (!turn || scope.activeChecks.has(kind)) return decide();
  scope.activeChecks.add(kind);
  const before = performance.now();
  try {
    const result = decide();
    turn[kind].push({ ms: performance.now() - before, matched: classify && Boolean(result),
      ...(classify && result?.kind ? { kind: result.kind } : {}) });
    return result;
  } finally {
    scope.activeChecks.delete(kind);
  }
}

export function monitorFixtureRead(url) {
  const pages = context.getStore()?.pages;
  const parsed = new URL(url);
  if (parsed.pathname === '/robots.txt' && pages && [...pages.keys()].some(page => new URL(page).origin === parsed.origin)) {
    const paths = [...pages.values()].filter(page => page.robotsDenied && new URL(page.url).origin === parsed.origin)
      .map(page => `Disallow: ${new URL(page.url).pathname}`);
    return { status: 200, headers: { 'content-type': 'text/plain' },
      body: Buffer.from(['User-agent: *', ...paths].join('\n')), url };
  }
  const page = pages?.get(url);
  if (!page || page.robotsDenied) return { status: 404, headers: {}, body: Buffer.alloc(0), url };
  return { status: page.status ?? 200,
    headers: { 'content-type': page.html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' },
    body: Buffer.from(page.html ?? page.text ?? ''), url };
}
