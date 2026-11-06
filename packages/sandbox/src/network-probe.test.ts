import { createConnection } from 'node:net';
import { expect, it } from 'vitest';
import { localNetworkProbe } from './network-probe.ts';

it('requires a reachable local receiver before and after an isolated attempt', async () => {
  const probe = await localNetworkProbe();
  try {
    expect(probe.endpoints[0].host).toBe('127.0.0.1');
    const evidence = await probe.verifyDenial();
    expect(evidence).toHaveLength(probe.endpoints.length);
    expect(evidence.every(entry => entry.controlBefore && entry.controlAfter && entry.isolatedConnections === 0)).toBe(true);
  } finally { await probe.close(); }
});

it('rejects absence-of-output claims when the receiver observed an extra connection', async () => {
  const probe = await localNetworkProbe();
  try {
    const target = probe.endpoints[0];
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(target.port, target.host);
      socket.once('connect', () => { socket.end(); resolve(); }); socket.once('error', reject);
    });
    await expect(probe.verifyDenial()).rejects.toThrow('reached the receiver');
  } finally { await probe.close(); }
});
