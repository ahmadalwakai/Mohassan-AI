import { performance } from 'node:perf_hooks';
import type { WorkspaceRole } from '../../apps/server/src/members.js';
import { createRequestMetricsHooks } from '../../apps/server/src/ops/metrics/request.js';
import { MetricsStore } from '../../apps/server/src/ops/metrics/store.js';

const REQUESTS_PER_ROUND = 100_000;
const WARMUP_REQUESTS = REQUESTS_PER_ROUND;
const ROUNDS = 9;
const store = new MetricsStore();
// Include the in-memory contributions to hourly snapshots in the request cost.
store.enableSnapshots();

const routes = [
  { method: 'GET', url: '/api/fixture/:id', status: 200, role: 'owner' },
  { method: 'POST', url: '/api/fixture/:id/messages', status: 404, role: 'member' },
  { method: 'GET', url: '/api/fixture', status: 503, role: 'owner' },
] as const;
const requests = Array.from({ length: REQUESTS_PER_ROUND }, (_, index) => {
  const { method, url, status, role } = routes[index % routes.length]!;
  return { request: { method, routeOptions: { url } }, status, role };
});
type FixtureRequest = typeof requests[number]['request'];
const roles = new WeakMap<FixtureRequest, Promise<WorkspaceRole>>();
const owner = Promise.resolve<WorkspaceRole>('owner');
const member = Promise.resolve<WorkspaceRole>('member');
const hooks = createRequestMetricsHooks((request: FixtureRequest) => roles.get(request),
  (role, route, status, durationMs) => store.recordRequest(role, route, status, durationMs));

// Run the production callbacks directly to exclude Fastify routing, I/O and response serialization.
async function measure(collect: boolean, count: number) {
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const { request, status, role } = requests[index]!;
    if (collect) hooks.start(request);
    roles.set(request, role === 'owner' ? owner : member);
    await (collect ? hooks.finish(request, status) : undefined);
  }
  return (performance.now() - started) * 1_000 / count;
}

await measure(false, WARMUP_REQUESTS);
await measure(true, WARMUP_REQUESTS);
const rounds = [];
for (let round = 0; round < ROUNDS; round++) {
  const collectFirst = round % 2 !== 0;
  const first = await measure(collectFirst, REQUESTS_PER_ROUND);
  const second = await measure(!collectFirst, REQUESTS_PER_ROUND);
  const [baselineUs, instrumentedUs] = collectFirst ? [second, first] : [first, second];
  rounds.push({ baselineUs, instrumentedUs, overheadUs: instrumentedUs - baselineUs });
}
const { roles: recordedRoles } = store.view().windows.hour;
const recorded = [...recordedRoles.owner.routes, ...recordedRoles.member.routes];
const measuredCount = recorded.reduce((sum, route) => sum + route.latency.samples, 0);
if (measuredCount !== WARMUP_REQUESTS + REQUESTS_PER_ROUND * ROUNDS
  || recorded.length !== routes.length || recorded.some(route => route.count !== route.latency.samples)) {
  throw new Error('The benchmark did not collect each instrumented response');
}
const sortedOverhead = rounds.map(round => round.overheadUs).sort((a, b) => a - b);
console.log(JSON.stringify({
  node: process.version, platform: `${process.platform} ${process.arch}`, requestsPerRound: REQUESTS_PER_ROUND,
  recorded: measuredCount, medianOverheadUs: sortedOverhead[Math.floor(rounds.length / 2)], rounds,
}, null, 2));
