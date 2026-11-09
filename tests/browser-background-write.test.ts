import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentBrowser, type AgentAuthority, type AgentPage } from '@mohassan/browser';

let browser: AgentBrowser, source: Server, telemetry: Server;
let sourceOrigin: string, telemetryOrigin: string, root: string, base: string;
let telemetryRequests = 0, approvedWrites = 0;
const dispatched = vi.fn(async (permit: { id: string }) => permit.id);
const authority = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched, completed: async () => {} });
const element = (page: AgentPage, label: string) => {
  const item = page.elements.find(candidate => candidate.label === label);
  if (!item) throw new Error(`Missing fixture element: ${label}`);
  return item.ref;
};
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return `http://127.0.0.1:${address.port}`;
};

beforeAll(async () => {
  base = await realpath(tmpdir()); root = await mkdtemp(join(base, 'mohassan-background-write-'));
  telemetry = createServer((_request, response) => { telemetryRequests++; response.writeHead(204, { 'access-control-allow-origin': '*' }); response.end(); });
  telemetryOrigin = await listen(telemetry);
  source = createServer((request, response) => {
    if (request.url === '/approved-submit' && request.method === 'POST') {
      approvedWrites++; response.writeHead(307, { location: telemetryOrigin + '/redirect-write' }); response.end(); return;
    }
    let content = '<h1>Readable document</h1>';
    if (request.url === '/background') content += `<output id=status>Waiting</output><script>fetch('${telemetryOrigin}/telemetry',{method:'POST',body:'fixture-only'}).then(()=>document.querySelector('output').textContent='Telemetry sent').catch(()=>document.querySelector('output').textContent='Telemetry blocked');</script>`;
    if (request.url === '/navigation') content += `<form action='${telemetryOrigin}/navigation' method=post><input name=value value=fixture></form><script>document.querySelector('form').submit();</script>`;
    if (request.url === '/gesture') content += `<button onclick="fetch('${telemetryOrigin}/gesture',{method:'POST',body:'fixture-only'}).catch(()=>{})">Send request</button>`;
    if (request.url === '/approved') content += '<form action=/approved-submit method=post><input name=value value=fixture><button>Approved request</button></form>';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Background write fixture</title><main>${content}</main>`);
  });
  sourceOrigin = await listen(source);
  browser = new AgentBrowser({ profileDir: root, testOrigins: [sourceOrigin, telemetryOrigin], allowedOrigins: [sourceOrigin], channel: null, headless: true });
});

afterAll(async () => {
  await browser?.close();
  await Promise.all([source, telemetry].filter(Boolean).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  if (root) {
    const target = await realpath(root), within = relative(base, target);
    if (isAbsolute(within) || !/^mohassan-background-write-[^/\\]+$/.test(within)) throw new Error('Unsafe fixture cleanup target');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('document reads and blocked page writes with real Chromium', () => {
  it('accepts the document while aborting an out-of-scope background POST before transport', async () => {
    const id = randomUUID(); dispatched.mockClear();
    try {
      const result = await browser.act('owner', id, { kind: 'open', text: sourceOrigin + '/background' }, authority());
      expect(result.page).toMatchObject({ title: 'Background write fixture', documentStatus: 200 });
      const verified = await browser.verifyPostconditions('owner', id, [{ kind: 'text', contains: 'Readable document' }, { kind: 'text', contains: 'Telemetry blocked' }], authority());
      expect(verified.verification.status).toBe('passed');
    } finally {
      expect(telemetryRequests).toBe(0);
      expect(dispatched).not.toHaveBeenCalled();
      await browser.closeConversation('owner', id);
    }
  });

  it('does not hide POST navigation, agent gesture denial, or an approved POST redirect failure', async () => {
    const nav = randomUUID(), gesture = randomUUID(), approved = randomUUID();
    await expect(browser.act('owner', nav, { kind: 'open', text: sourceOrigin + '/navigation' }, authority())).rejects.toMatchObject({ code: 'BROWSER_SCOPE_DENIED' });
    const gesturePage = await browser.act('owner', gesture, { kind: 'open', text: sourceOrigin + '/gesture' }, authority());
    await expect(browser.act('owner', gesture, { kind: 'click', ref: element(gesturePage.page, 'Send request') }, authority())).rejects.toMatchObject({ code: 'BROWSER_SCOPE_DENIED' });
    const approvedPage = await browser.act('owner', approved, { kind: 'open', text: sourceOrigin + '/approved' }, authority());
    const action = { kind: 'click' as const, ref: element(approvedPage.page, 'Approved request') };
    const permit = await browser.prepareAction('owner', approved, action);
    expect(permit).toMatchObject({ method: 'POST', url: sourceOrigin + '/approved-submit' });
    dispatched.mockClear();
    await expect(browser.act('owner', approved, action, authority(), permit!)).rejects.toMatchObject({ code: 'AGENT_EFFECT_UNKNOWN' });
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(approvedWrites).toBe(1);
    expect(telemetryRequests).toBe(0);
    await Promise.all([nav, gesture, approved].map(id => browser.closeConversation('owner', id)));
  });
});
