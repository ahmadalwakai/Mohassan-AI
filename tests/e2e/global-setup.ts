import { startIsolatedE2E } from './isolation';

export default async function setup() {
  const fixture = await startIsolatedE2E();
  process.env.MOHASSAN_E2E_ROOT=fixture.directory;
  // Playwright awaits this on normal completion/failure. Abrupt OS termination
  // cannot guarantee JS cleanup; never delete a directory with unconfirmed children.
  return async () => { await fixture.stop(); delete process.env.MOHASSAN_E2E_ROOT; };
}
