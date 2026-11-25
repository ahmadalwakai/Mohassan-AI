import { startIsolatedE2E } from './isolation';

export default async function setup() {
  const fixture = await startIsolatedE2E({ localBrain: true, githubMonitor: true });
  return fixture.stop;
}
