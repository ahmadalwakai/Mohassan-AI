/** Disposable local browser/API story check with no chat provider or live credentials. */
import { startIsolatedE2E } from '../tests/e2e/isolation.js';

const fixture = await startIsolatedE2E({ localBrain: true });
console.log(JSON.stringify({ localBrainLab: 'ready', web: 'http://127.0.0.1:3100', api: 'http://127.0.0.1:4100', directory: fixture.directory }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await fixture.stop();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop(); });
await new Promise<void>(() => {});
