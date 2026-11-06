// The standalone fixture uses the same owned-resource lifecycle as Playwright.
// Node 24 strips the erasable TypeScript in this built-in-only helper.
const { startIsolatedE2E } = await import('../tests/e2e/isolation.ts');
const fixture = await startIsolatedE2E();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await fixture.stop(); } catch (error) { console.error(error); process.exitCode = 1; }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
