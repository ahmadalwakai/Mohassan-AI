import { createConnection, createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface LocalNetworkEvidence { host: string; port: number; controlBefore: true; controlAfter: true; isolatedConnections: 0 }

/** A control and target on this machine only. No Internet host or DNS is consulted. */
export async function localNetworkProbe() {
  const addresses = [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && !entry.internal && entry.family === 'IPv4' && !entry.address.startsWith('169.254.'))
    .map((entry) => entry!.address)])];
  const servers: Server[] = [];
  const endpoints: { host: string; port: number }[] = [];
  const checks: { host: string; port: number; connections: number; token: string }[] = [];
  const close = async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); };
  const control = async (target: typeof checks[number]) => new Promise<void>((resolve, reject) => {
    const socket = createConnection(target.port, target.host);
    let reply = '';
    socket.once('connect', () => socket.write(target.token));
    socket.on('data', data => { reply += data.toString(); if (reply === target.token) { socket.destroy(); resolve(); } else if (reply.length >= target.token.length) { socket.destroy(); reject(new Error('Local network control reply changed.')); } });
    socket.once('error', reject);
    socket.once('end', () => { if (reply !== target.token) reject(new Error('Local network control ended without evidence.')); });
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Local network control failed.')); });
  });
  try {
    for (const host of addresses) {
      const check = { host, port: 0, connections: 0, token: randomBytes(24).toString('hex') };
      const server = createServer(socket => {
        check.connections++;
        let received = '';
        socket.on('error', () => {});
        socket.setTimeout(1500, () => socket.destroy());
        socket.on('data', data => { received += data.toString(); if (received === check.token) socket.end(check.token); else if (received.length >= check.token.length) socket.destroy(); });
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => { server.removeListener('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local network fixture unavailable.');
      check.port = address.port;
      await control(check);
      if (check.connections !== 1) throw new Error('Unexpected connection during local network control.');
      checks.push(check);
      endpoints.push({ host, port: address.port });
    }
    const verifyDenial = async (): Promise<LocalNetworkEvidence[]> => {
      const evidence: LocalNetworkEvidence[] = [];
      for (const check of checks) {
        if (check.connections !== 1) throw new Error('The isolated network fixture reached the receiver.');
        await control(check);
        if (Number(check.connections) !== 2) throw new Error('Unexpected connection during final local network control.');
        evidence.push({ host: check.host, port: check.port, controlBefore: true, controlAfter: true, isolatedConnections: 0 });
      }
      return evidence;
    };
    return { endpoints, verifyDenial, close };
  } catch (error) { await close(); throw error; }
}
