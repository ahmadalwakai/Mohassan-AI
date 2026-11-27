import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SandboxRunner } from '@mohassan/coding';
import type { createApplication } from '../../apps/server/src/app.ts';

export const unavailableServerSandbox: SandboxRunner = {
  available: async () => ({ available: false, provider: null, message: 'Measurement: server sandbox unavailable' }),
  run: async () => { throw new Error('The server must never run a device project'); },
};

interface DeviceFixtureOptions {
  checkout: string;
  ownerId: string;
  dataDir: string;
  allowedRoots: string[];
  sandbox?: SandboxRunner;
  createPairing: () => PromiseLike<{ statusCode: number; json<T>(): T }>;
}

/** Pair over HTTP and let the actual worker poll the application over loopback. */
export async function pairMeasurementDevice(application: Awaited<ReturnType<typeof createApplication>>,
  { checkout, ownerId, dataDir, allowedRoots, sandbox, createPairing }: DeviceFixtureOptions) {
  const worker: typeof import('../../packages/coding-link/src/worker.ts') = await import(
    pathToFileURL(join(checkout, 'packages/coding-link/src/worker.ts')).href);
  const { CodingPairResponseSchema }: typeof import('../../packages/coding-link/src/protocol.ts') = await import(
    pathToFileURL(join(checkout, 'packages/coding-link/src/protocol.ts')).href);
  const serverUrl = await application.app.listen({ host: '127.0.0.1', port: 0 });
  const pairing = await createPairing();
  if (pairing.statusCode !== 200) throw new Error(`Create measurement pairing: HTTP ${pairing.statusCode}`);
  const { code } = pairing.json<{ code: string }>();
  const paired = await worker.postCodingDeviceJson(serverUrl, '/api/coding/device/pair', JSON.stringify({ code, name: 'Measurement device' }));
  if (paired.status !== 200) throw new Error(`Pair measurement device: HTTP ${paired.status}`);
  const { deviceId, deviceKey } = CodingPairResponseSchema.parse(paired.body);

  return {
    async start() {
      const controller = new AbortController();
      const readiness = new AbortController();
      let markOnline!: () => void;
      const online = new Promise<void>(resolve => { markOnline = resolve; });
      const done = worker.runCodingDevice({
        serverUrl, deviceId, deviceKey, dataDir, allowedRoots, sandbox, pollIntervalMs: 400,
        signal: controller.signal,
        onStatus(status) { if (status === 'online') markOnline(); },
      });
      const ready = async () => {
        await online;
        while (!(await application.coding.workspace(ownerId)).device?.sandbox.available) {
          await delay(250, undefined, { signal: readiness.signal });
        }
      };
      try {
        await Promise.race([
          ready(),
          done.then(() => { throw new Error('Measurement device stopped before its first poll'); }),
          delay(90_000, undefined, { signal: readiness.signal }).then(() => { throw new Error('Measurement device did not complete its first poll'); }),
        ]);
      } catch (error) {
        controller.abort();
        await done.catch(() => {});
        throw error;
      } finally {
        readiness.abort();
      }
      return async () => { controller.abort(); await done; };
    },
  };
}
