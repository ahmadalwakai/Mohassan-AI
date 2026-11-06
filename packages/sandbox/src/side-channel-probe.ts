import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';
import { createConnection, createServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';

/** Unique local receivers. No DNS, Internet destination, existing pipe or global
 * firewall/loopback exemption is read or modified. */
export async function localSideChannelProbe() {
  if (process.platform !== 'win32') throw new Error('The Windows pipe fixture is unavailable on this platform');
  const addresses = [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flat().filter(item => item && !item.internal && item.family === 'IPv4' && !item.address.startsWith('169.254.')).map(item => item!.address)])];
  const sockets: Socket[] = [], servers: Server[] = [], controls: (() => Promise<void>)[] = [], counts: { value: number }[] = [];
  const udp: { host: string; port: number }[] = [], pipe = `\\\\.\\pipe\\mohassan-sandbox-${randomUUID()}`;
  const close = async () => { await Promise.all([...sockets.map(socket => new Promise<void>(resolve => { try { socket.close(() => resolve()); } catch { resolve(); } })), ...servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))]); };
  try {
    for (const host of addresses) {
      const socket = createSocket('udp4'), token = randomBytes(24).toString('hex'), count = { value: 0 }; sockets.push(socket); counts.push(count);
      socket.on('message', (message, remote) => { count.value++; if (message.toString() === token) socket.send(message, remote.port, remote.address); });
      await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, host, () => { socket.removeListener('error', reject); resolve(); }); });
      const port = socket.address().port; udp.push({ host, port });
      controls.push(async () => {
        const client = createSocket('udp4');
        try { await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(new Error('UDP positive control timed out')), 1500); const done = (error?: Error) => { clearTimeout(timeout); error ? reject(error) : resolve(); }; client.once('error', done); client.on('message', message => { if (message.toString() === token) done(); else done(new Error('UDP control mismatch')); }); client.send(token, port, host, error => { if (error) done(error); }); }); }
        finally { client.close(); }
      });
    }
    const pipeCount = { value: 0 }, token = randomBytes(24).toString('hex'); counts.push(pipeCount);
    const server = createServer(socket => { pipeCount.value++; socket.on('error', () => {}); socket.setTimeout(1500, () => socket.destroy()); let text = ''; socket.on('data', data => { text += data.toString(); if (text === token) socket.end(token); else if (text.length >= token.length) socket.destroy(); }); }); servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pipe, () => { server.removeListener('error', reject); resolve(); }); });
    controls.push(async () => new Promise<void>((resolve, reject) => {
      const socket = createConnection(pipe); let reply = '';
      socket.on('connect', () => socket.write(token)); socket.on('error', reject); socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Pipe positive control timed out')); });
      socket.on('data', data => { reply += data.toString(); if (reply === token) { socket.destroy(); resolve(); } else if (reply.length >= token.length) { socket.destroy(); reject(new Error('Pipe control mismatch')); } });
      socket.on('end', () => { if (reply !== token) reject(new Error('Pipe control ended without proof')); });
    }));
    for (const control of controls) await control();
    if (counts.some(count => count.value !== 1)) throw new Error('Unexpected local side-channel traffic before isolation test');
    return { udp, pipe, close, async verifyDenial() {
      if (counts.some(count => count.value !== 1)) throw new Error('An isolated side-channel operation reached a receiver');
      for (const control of controls) await control();
      if (counts.some(count => count.value !== 2)) throw new Error('Unexpected local side-channel traffic after isolation test');
      return { hostControlsBefore: true as const, hostControlsAfter: true as const, isolatedMessages: 0 as const, udpReceivers: udp.length, namedPipeReceivers: 1 };
    } };
  } catch (error) { await close(); throw error; }
}
