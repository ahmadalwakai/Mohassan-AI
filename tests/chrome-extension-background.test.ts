import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createContext, Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Executes the actual shipped worker with a local Chrome fixture. No browser,
// credentials, network, Google Ads account, or remote mutation is involved.
const source = await readFile(new URL('../packages/chrome-extension/background.js', import.meta.url), 'utf8');
const relaySource = await readFile(new URL('../packages/chrome-extension/relay.js', import.meta.url), 'utf8');
const binding = { clientId: 'chrome-client-fixture-0001', tabId: 17, customerId: '1234567890', currency: 'GBP', extensionVersion: '0.1.0' };
const app = { tabId: 3, origin: 'https://mohassan.example.test' };
const job = { id: randomUUID(), leaseId: randomUUID(), status: 'running', clientId: binding.clientId, tabId: binding.tabId, customerId: binding.customerId, currency: binding.currency };

function worker(options: { journal?: boolean; checkpoint?: boolean; serverStatus?: string; offline?: boolean; cancelFails?: boolean } = {}) {
  let state: any = { app, binding, journal: options.journal ? { job, progress: { done: ['budget'], snapshots: { dailyBudget: '20' } }, steps: [] } : null,
    checkpoint: options.checkpoint ? { jobId: job.id, leaseId: job.leaseId } : null };
  const calls: string[] = [], scripts: any[] = [];
  let listener: (message: any, sender: any, reply: (value: any) => void) => unknown = () => undefined;
  const chrome = {
    storage: { local: { get: async () => ({ 'mohassan-bridge-v1': structuredClone(state) }), set: async (value: any) => { state = structuredClone(value['mohassan-bridge-v1']); } } },
    runtime: { id: 'fixture-extension', getURL: (path: string) => `chrome-extension://fixture-extension/${path}`, getManifest: () => ({ version: '0.1.0' }), onMessage: { addListener: (callback: typeof listener) => { listener = callback; } } },
    tabs: { get: async (id: number) => ({ id, url: id === app.tabId ? app.origin : 'https://ads.google.com/aw/campaigns/new/search' }), onRemoved: { addListener() {} },
      sendMessage: async (_id: number, message: any) => {
        calls.push(message.path);
        if (options.offline || options.cancelFails && message.path.endsWith('/cancel')) return { ok: false, error: 'Fixture server unavailable' };
        return { ok: true, data: { connected: true, latestJob: { ...job, status: options.serverStatus ?? 'running' } } };
      } },
    scripting: { executeScript: async (request: any) => { scripts.push(request); return [{ result: { ok: true } }]; } },
    alarms: { onAlarm: { addListener() {} }, create: async () => undefined, clear: async () => true },
  };
  const context = createContext({ chrome, URL, crypto: { randomUUID }, setTimeout });
  new Script(source, { filename: 'background.js' }).runInContext(context);
  const invoke = (expression: string) => new Script(expression).runInContext(context);
  const send = (message: object, sender: object = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }) => new Promise<any>(resolve => listener(message, sender, resolve));
  return { calls, scripts, invoke, send, state: () => state };
}

describe('Chrome worker Ads execution boundary', () => {
  it.each(['queued', 'running'])('cancels a legacy %s job without claiming or dispatching the page adapter', async serverStatus => {
    const f = worker({ journal: true, checkpoint: true, serverStatus });
    await f.invoke('tick()');
    expect(f.calls).toEqual(['/api/chrome-extension/heartbeat', `/api/chrome-extension/jobs/${job.id}/cancel`]);
    expect(f.scripts.every(request => request.files?.[0] === 'relay.js')).toBe(true);
    expect(f.state()).toMatchObject({ app, binding, journal: null, checkpoint: null });
    expect(f.state().message).toContain('الرسمي');
  });

  it('does not claim new work when there is no locally cached job', async () => {
    const f = worker({ serverStatus: 'stopped' });
    await f.invoke('tick()');
    expect(f.calls).toEqual(['/api/chrome-extension/heartbeat']);
    expect(f.scripts.some(request => request.files?.includes('ads-adapter.js'))).toBe(false);
  });

  it.each([{ offline: true }, { cancelFails: true }])('discards runnable local recovery state when the server is unavailable: %j', async options => {
    const f = worker({ ...options, journal: true, checkpoint: true });
    await f.invoke('tick()');
    expect(f.state()).toMatchObject({ binding, journal: null, checkpoint: null });
    expect(f.state().message).toContain('Fixture server unavailable');
    expect(f.scripts.some(request => request.files?.includes('ads-adapter.js'))).toBe(false);
  });

  it('denies an old injected adapter check even when its job, lease and selected tab match', async () => {
    const f = worker({ journal: true });
    const response = await f.send({ kind: 'adapter-check', jobId: job.id, leaseId: job.leaseId }, { id: 'fixture-extension', frameId: 0, tab: { id: binding.tabId }, origin: 'https://ads.google.com' });
    expect(response.allowed).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.scripts).toEqual([]);
  });

  it('allows inspection but fails closed before injecting any mutating or generic method', async () => {
    const f = worker();
    await expect(f.invoke("adapter(17, 'step', {})")).rejects.toMatchObject({ message: expect.stringContaining('الرسمي') });
    await expect(f.invoke("adapter(17, 'resetStop', {})")).rejects.toMatchObject({ message: expect.stringContaining('الرسمي') });
    expect(f.scripts).toEqual([]);
    await expect(f.invoke("adapter(17, 'inspect', {})")).resolves.toMatchObject({ ok: true });
    expect(f.scripts[0].files).toEqual(['ads-adapter.js']);
    expect(f.scripts[1].args[0]).toBe('inspect');
  });

  it('refuses local resume without sending any resume, claim, result, or page request', async () => {
    const f = worker({ checkpoint: true });
    await expect(f.invoke("popup({ kind: 'resume' })")).rejects.toMatchObject({ message: expect.stringContaining('الرسمي') });
    expect(f.calls).toEqual([]);
    expect(f.scripts).toEqual([]);
  });

  it('keeps durable local stop when remote disconnect is unavailable', async () => {
    const f = worker({ journal: true, checkpoint: true, offline: true });
    await expect(f.invoke("popup({ kind: 'stop' })")).resolves.toBe(true);
    expect(f.state()).toMatchObject({ binding: null, journal: null, checkpoint: null });
    expect(f.state().message).toContain('محلياً');
    expect(f.calls).toEqual(['/api/chrome-extension/disconnect']);
    expect(f.scripts.some(request => request.args?.[0] === 'step')).toBe(false);
  });
});

it('limits the shipped relay to connection, observation and cancellation routes', async () => {
  let listener: any;
  const paths: string[] = [];
  const context = createContext({ location: { origin: app.origin }, AbortSignal,
    chrome: { runtime: { id: 'fixture-extension', onMessage: { addListener: (callback: any) => { listener = callback; } } } }, setInterval() {},
    fetch: async (path: string) => { paths.push(path); return { ok: true, json: async () => ({ connected: true }) }; },
  });
  new Script(relaySource, { filename: 'relay.js' }).runInContext(context);
  const request = (path: string) => new Promise<any>(resolve => listener({ kind: 'relay-fetch', origin: app.origin, path, method: 'POST', body: {} }, { id: 'fixture-extension' }, resolve));
  for (const path of ['jobs/claim', `jobs/${job.id}/resume`, `jobs/${job.id}/result`]) expect((await request(`/api/chrome-extension/${path}`)).ok).toBe(false);
  expect(paths).toEqual([]);
  expect((await request(`/api/chrome-extension/jobs/${job.id}/cancel`)).ok).toBe(true);
  expect(paths).toEqual([`/api/chrome-extension/jobs/${job.id}/cancel`]);
});
