import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentBrowser, type AgentAuthority, type AgentPage } from '@mohassan/browser';

const owner = 'autonomy-regression';
const writes: { body: string; contentType: string }[] = [];
const cookies: string[] = [];
const auth = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => permit.id, completed: async () => {} });
const ref = (page: AgentPage, label: string) => page.elements.find(element => element.label === label)!.ref;
let browser: AgentBrowser, server: Server, origin: string, root: string, temporaryRoot: string;
const open = (id: string, path: string) => browser.act(owner, id, { kind: 'open', text: origin + path }, auth());

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  root = await mkdtemp(join(temporaryRoot, 'mohassan-browser-autonomy-'));
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      let content = '<h1>Ready</h1>';
      if (url.pathname === '/fields') content = '<label>Note<input name=note></label><label>Option<select aria-label="Option"><option>A</option><option>B</option><option>C</option></select></label>';
      if (url.pathname === '/multipart') content = '<form action=/submit method=post enctype=multipart/form-data><input name=note value="alpha"><input type=hidden name=csrf value=original><textarea name=note>line1\nline2</textarea><button>Send</button></form>';
      if (url.pathname === '/file') content = '<form action=/submit method=post enctype=multipart/form-data><input type=file name=file><button>Send file</button></form>';
      if (url.pathname === '/submit') { writes.push({ body, contentType: request.headers['content-type'] ?? '' }); content = '<h1>Received once</h1>'; }
      if (url.pathname === '/popup') content = `<a href="/landing?key=${'x'.repeat(300)}" target=_blank>Open tab</a>`;
      if (url.pathname === '/oversized-link') content = `<a href="/landing?key=${'x'.repeat(5000)}">Oversized link</a>`;
      if (url.pathname === '/landing') content = `<h1>Landing ${url.searchParams.get('key')?.length ?? 0}</h1>`;
      if (url.pathname === '/cookie-set') response.setHeader('set-cookie', 'session=account-one; Path=/; Max-Age=3600');
      if (url.pathname === '/cookie-read') cookies.push(request.headers.cookie ?? '');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>Fixture</title><main>${content}</main>`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = new AgentBrowser({ profileDir: root, testOrigins: [origin], channel: null });
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
  const target = await realpath(root), within = relative(temporaryRoot, target);
  if (isAbsolute(within) || !within.startsWith('mohassan-browser-autonomy-') || within.includes('..')) throw new Error('Unsafe fixture cleanup');
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('browser autonomy with actual Chromium and isolated local pages', () => {
  it('preserves owner input even after a fresh observation and allows editing its own value', async () => {
    const id = randomUUID(), first = await open(id, '/fields');
    const field = ref(first.page, 'Note');
    await browser.act(owner, id, { kind: 'type', ref: field, text: 'agent first' }, auth());
    await browser.act(owner, id, { kind: 'type', ref: field, text: 'agent second' }, auth());
    const handle = (await browser['conversation'](owner, id)).page;
    await handle.locator('input').fill('owner correction');
    await browser.observe(owner, id);
    await expect(browser.act(owner, id, { kind: 'type', ref: field, text: 'wrong replacement' }, auth())).rejects.toMatchObject({ code: 'AGENT_FIELD_VALUE_PROTECTED' });
    expect(await handle.locator('input').inputValue()).toBe('owner correction');
    await browser.closeConversation(owner, id);
  });

  it('preserves an owner selection while permitting the untouched page default', async () => {
    const id = randomUUID(), first = await open(id, '/fields'), select = ref(first.page, 'Option');
    await browser.act(owner, id, { kind: 'select', ref: select, text: 'B' }, auth());
    const handle = (await browser['conversation'](owner, id)).page;
    await handle.locator('select').selectOption('C');
    await expect(browser.act(owner, id, { kind: 'select', ref: select, text: 'A' }, auth())).rejects.toMatchObject({ code: 'AGENT_FIELD_VALUE_PROTECTED' });
    expect(await handle.locator('select').inputValue()).toBe('C');
    await browser.closeConversation(owner, id);
  });

  it('sends exactly one text multipart body bound to ordered duplicate fields', async () => {
    const id = randomUUID(), first = await open(id, '/multipart');
    const action = { kind: 'click' as const, ref: ref(first.page, 'Send') };
    const permit = await browser.prepareAction(owner, id, action);
    const before = writes.length;
    const result = await browser.act(owner, id, action, auth(), permit!);
    expect(result.page.text).toContain('Received once');
    expect(writes).toHaveLength(before + 1);
    expect(writes.at(-1)!.contentType).toContain('multipart/form-data; boundary=');
    expect(writes.at(-1)!.body.match(/name="note"/g)).toHaveLength(2);
    await expect(browser.act(owner, id, action, auth(), permit!)).rejects.toBeDefined();
    expect(writes).toHaveLength(before + 1);
    await browser.closeConversation(owner, id);
  });

  it('refuses changed multipart fields after approval and refuses file bodies', async () => {
    const id = randomUUID(), first = await open(id, '/multipart');
    const action = { kind: 'click' as const, ref: ref(first.page, 'Send') };
    const permit = await browser.prepareAction(owner, id, action), before = writes.length;
    const handle = (await browser['conversation'](owner, id)).page;
    await handle.locator('[name=csrf]').evaluate(node => (node as HTMLInputElement).value = 'changed');
    await expect(browser.act(owner, id, action, auth(), permit!)).rejects.toMatchObject({ code: 'AGENT_APPROVAL_STALE' });
    const file = await open(id, '/file');
    await expect(browser.prepareAction(owner, id, { kind: 'click', ref: ref(file.page, 'Send file') })).rejects.toMatchObject({ code: 'AGENT_FORM_UNSUPPORTED' });
    expect(writes).toHaveLength(before);
    await browser.closeConversation(owner, id);
  });

  it('routes the initial popup request and retains the entire long destination', async () => {
    const id = randomUUID(), first = await open(id, '/popup');
    const result = await browser.act(owner, id, { kind: 'click', ref: ref(first.page, 'Open tab') }, auth());
    expect(result.page.url).toBe(origin + '/landing?key=' + 'x'.repeat(300));
    expect(result.page.text).toContain('Landing 300');
    const entry = await browser['conversation'](owner, id);
    const pages = [...entry.pages];
    expect(pages.length).toBe(2);
    await browser.closeConversation(owner, id);
    expect(pages.every(page => page.isClosed())).toBe(true);
  });

  it('does not evict an in-flight action when more conversations open', async () => {
    const id = randomUUID();
    await open(id, '/fields');
    const waiting = browser.act(owner, id, { kind: 'wait', text: '4000' }, auth());
    const others: string[] = [];
    for (let index = 0; index < 4; index++) { const other = randomUUID(); others.push(other); await open(other, '/fields'); }
    expect((await waiting).page.url).toBe(origin + '/fields');
    await Promise.all([id, ...others].map(other => browser.closeConversation(owner, other)));
  });

  it('bounds oversized link snapshots without turning a truncated URL into an allowed navigation', async () => {
    const id = randomUUID(), first = await open(id, '/oversized-link');
    const link = first.page.elements.find(element => element.label === 'Oversized link')!;
    expect(link.href).toHaveLength(2501);
    await expect(browser.act(owner, id, { kind: 'click', ref: link.ref }, auth())).rejects.toMatchObject({ code: 'BROWSER_URL_DENIED' });
    expect((await browser.observe(owner, id)).page.url).toBe(origin + '/oversized-link');
    await browser.closeConversation(owner, id);
  });

  it('does not recreate about:blank after an explicit close during a wait', async () => {
    const id = randomUUID();
    await open(id, '/fields');
    const pending = browser.act(owner, id, { kind: 'wait', text: '800' }, auth());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'AGENT_PAGE_CLOSED' });
    await new Promise(resolve => setTimeout(resolve, 100));
    await browser.closeConversation(owner, id);
    await rejected;
    expect(await browser.hasPage(owner, id)).toBe(false);
  });

  it('shares a saved sign-in within one owner account and isolates other accounts and owners', async () => {
    const first = randomUUID(), same = randomUUID(), different = randomUUID(), foreign = randomUUID();
    await browser.bindAccount(owner, first, 'account-one');
    await browser.bindAccount(owner, same, 'account-one');
    await browser.bindAccount(owner, different, 'account-two');
    await browser.bindAccount('another-owner', foreign, 'account-one');
    await open(first, '/cookie-set');
    await open(same, '/cookie-read');
    expect(cookies.at(-1)).toContain('session=account-one');
    await expect(browser.bindAccount(owner, same, 'account-two')).rejects.toMatchObject({ code: 'AGENT_ACCOUNT_BUSY' });
    await open(different, '/cookie-read');
    expect(cookies.at(-1)).toBe('');
    await browser.act('another-owner', foreign, { kind: 'open', text: origin + '/cookie-read' }, auth());
    expect(cookies.at(-1)).toBe('');
    await Promise.all([first, same, different].map(id => browser.closeConversation(owner, id)));
    await browser.closeConversation('another-owner', foreign);
  });
});
