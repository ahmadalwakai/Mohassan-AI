import { startIsolatedE2E } from './isolation';

export default async function setup() {
  const fixture = await startIsolatedE2E({ localBrain: true, browserLiveView: true });
  process.env.MOHASSAN_E2E_ROOT = fixture.directory;
  return async () => { await fixture.stop(); delete process.env.MOHASSAN_E2E_ROOT; };
}
