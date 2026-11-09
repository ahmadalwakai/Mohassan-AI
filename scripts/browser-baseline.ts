/**
 * BR0 baseline. Drives the real AgentBrowser against a loopback fixture with a
 * throwaway profile; it uses no model, no database and no external site.
 * Run: npx tsx scripts/browser-baseline.ts
 * A DEFECT line records today's behaviour, so this script does not fail on one.
 */
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { AgentBrowser, AgentEffectHeld, type AgentAuthority, type AgentRequestPermit } from '@mohassan/browser';

const hits: { path: string; method: string; ua?: string; referer?: string; cookie?: string; body?: string }[] = [];
const page = (body: string, title = 'fixture') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`;
const longQuery = 'x'.repeat(260);
const routes: Record<string, string> = {
  '/plain': page('<h1>plain</h1><a href="/next">next</a><p>' + 'lorem '.repeat(120) + '</p>'),
  '/next': page('<h1>next page</h1>'),
  '/spa': page('<div id=out>loading</div><script>fetch("/api/data").then(r=>r.json()).then(d=>{out.textContent="data:"+d.value});</script>'),
  '/poll': page('<h1>poll</h1><script>setTimeout(()=>fetch("/api/data"),1200);</script>'),
  '/stale': page('<div id=list><button onclick="done.textContent=\'clicked-safe\'">Safe action</button><button onclick="done.textContent=\'clicked-other\'">Other action</button></div><p id=done>none</p><script>window.addEventListener("mutate",()=>{const b=document.createElement("button");b.textContent="Delete account";b.onclick=()=>{done.textContent="clicked-DELETE"};list.prepend(b);});</script>'),
  '/prefilled': page('<label>Note <input id=n name=n></label><p id=v></p>'),
  '/multipart': page('<form method=post action="/submit" enctype="multipart/form-data"><input name=a value=1><button type=submit>Send multipart</button></form>'),
  '/jsform': page('<input id=q aria-label="Name"><button id=b onclick="fetch(\'/api/save\',{method:\'POST\',body:JSON.stringify({q:q.value})}).then(()=>done.textContent=\'saved\')">Save</button><p id=done>idle</p>'),
  '/getsearch': page('<form method=get action="/next"><input name=q aria-label="Search"><button type=submit>Search</button></form>'),
  '/popup': page('<a href="/next" target="_blank">open in tab</a>'),
  '/longlink': page(`<a href="/next?q=${longQuery}">long link</a>`),
  '/big': page('<h1>big</h1><script src="/big.js"></script>'),
  '/setcookie': page('<h1>cookie set</h1>'),
  '/readcookie': page('<h1>cookie read</h1>'),
  '/login': page('<form method=post action="/submit"><label>User <input name=u></label><button type=submit>Go</button></form>'),
  '/wait': page('<h1>wait</h1>'),
};
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    hits.push({ path: url.pathname, method: req.method!, ua: req.headers['user-agent'], referer: req.headers.referer, cookie: req.headers.cookie, body });
    if (url.pathname === '/api/data') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"value":42}'); return; }
    if (url.pathname === '/api/save') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    if (url.pathname === '/big.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('//' + 'a'.repeat(3_000_000)); return; }
    if (url.pathname === '/submit') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('<h1>submitted ' + body + '</h1>')); return; }
    if (url.pathname === '/setcookie') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=conversation-a; Path=/' }); res.end(routes['/setcookie']); return; }
    const html = routes[url.pathname];
    if (!html) { res.writeHead(404); res.end('missing'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html);
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('no port');
const origin = `http://127.0.0.1:${address.port}`;

const profile = await mkdtemp(join(tmpdir(), 'mohassan-br0-'));
const browser = new AgentBrowser({ profileDir: profile, testOrigins: [origin], channel: null, headless: true });
const owner = 'br0-owner';
const dispatched: AgentRequestPermit[] = [];
const authority = (): AgentAuthority => ({ signal: new AbortController().signal, assertActive: async () => {}, dispatched: async permit => { dispatched.push(permit); return permit.id; }, completed: async () => {} });
const bounded = async <T>(work: Promise<T>, milliseconds = 30000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture deadline exceeded')), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
};

interface Finding { id: string; expected: string; actual: string; verdict: 'DEFECT' | 'OK' | 'INFO' }
const findings: Finding[] = [];
let counter = 0;
async function probe(id: string, expected: string, run: (conversation: string) => Promise<{ actual: string; defect: boolean; info?: boolean }>) {
  const conversation = `c${++counter}`;
  let actual: string, verdict: Finding['verdict'];
  try {
    const result = await bounded(run(conversation));
    actual = result.actual; verdict = result.info ? 'INFO' : result.defect ? 'DEFECT' : 'OK';
  } catch (error: any) { actual = `THREW ${error?.code ?? error?.name}: ${String(error?.message).slice(0, 110)}`; verdict = 'DEFECT'; }
  await browser.closeConversation(owner, conversation).catch(() => {});
  findings.push({ id, expected, actual, verdict });
  console.log(`[${verdict}] ${id}\n   expected: ${expected}\n   actual:   ${actual}`);
}
const open = (c: string, path: string) => browser.act(owner, c, { kind: 'open', text: origin + path }, authority());
const textOf = (r: { page: { text: string } }) => r.page.text.slice(0, 80);

try {
await probe('spa-fetch-on-load', 'A page that calls fetch() while loading opens and shows its data', async c => {
  const r = await open(c, '/spa'); return { actual: textOf(r), defect: !r.page.text.includes('data:42') };
});
await probe('background-request-poisons-next-read', 'A background request between actions does not fail the next observe()', async c => {
  await open(c, '/poll'); await new Promise(r => setTimeout(r, 1800));
  const r = await browser.observe(owner, c); return { actual: `observe ok: ${textOf(r)}`, defect: false };
});
await probe('stale-ref-wrong-target', 'A ref from an old snapshot is refused or still hits the same element', async c => {
  const first = await open(c, '/stale');
  const safe = first.page.elements.find(e => e.label === 'Safe action')!;
  const pageHandle = (await (browser as any).conversation(owner, c)).page;
  await pageHandle.evaluate(() => window.dispatchEvent(new Event('mutate')));
  const r = await browser.act(owner, c, { kind: 'click', ref: safe.ref }, authority());
  const label = r.page.text.match(/clicked-\w+/)?.[0] ?? 'none';
  return { actual: `old ref ${safe.ref} labelled "Safe action" produced ${label}`, defect: label !== 'clicked-safe' };
});
await probe('user-value-overwritten', 'A field the person already filled is not replaced without authorization', async c => {
  const first = await open(c, '/prefilled');
  const field = first.page.elements.find(e => e.role === 'textbox')!;
  const handle = (await (browser as any).conversation(owner, c)).page;
  await handle.locator('#n').fill('owner typed this');
  const denial = await browser.act(owner, c, { kind: 'type', ref: field.ref, text: 'agent value' }, authority()).then(() => '', (error: { code?: string }) => error.code ?? 'unknown');
  const r = await browser.observe(owner, c);
  const after = r.page.elements.find(e => e.role === 'textbox')?.value;
  return { actual: `field now "${after}"; denial=${denial}`, defect: after !== 'owner typed this' || denial !== 'AGENT_FIELD_VALUE_PROTECTED' };
});
await probe('get-search-needs-approval', 'A read-only GET search does not produce a send approval', async c => {
  const first = await open(c, '/getsearch');
  const input = first.page.elements.find(e => e.role === 'textbox')!;
  const r = await browser.act(owner, c, { kind: 'type', ref: input.ref, text: 'hello', submit: true }, authority());
  return { actual: `without a permit the search reached ${new URL(r.page.url).pathname}`, defect: !r.page.text.includes('next page') };
});
await probe('js-submit-has-approval-path', 'A fetch()-based Save button can be reviewed and approved', async c => {
  const first = await open(c, '/jsform');
  const save = first.page.elements.find(e => e.label === 'Save')!;
  const held = await browser.act(owner, c, { kind: 'click', ref: save.ref }, authority()).then(() => null, error => error instanceof AgentEffectHeld ? error.held : null);
  const before = hits.some(h => h.path === '/api/save');
  if (held) await browser.releaseHeld(owner, c, held.id, authority());
  const sent = hits.filter(h => h.path === '/api/save').length;
  return { actual: `held=${Boolean(held)}; sent before approval=${before}; sent after approval=${sent}`, defect: !held || before || sent !== 1 };
});
await probe('multipart-form', 'A native multipart form can be approved', async c => {
  const first = await open(c, '/multipart');
  const send = first.page.elements.find(e => e.label === 'Send multipart')!;
  const permit = await browser.prepareAction(owner, c, { kind: 'click', ref: send.ref });
  return { actual: permit ? 'permit issued' : 'null', defect: !permit };
});
await probe('native-post-still-one-shot', 'A native POST with a permit is sent exactly once', async c => {
  const first = await open(c, '/login');
  const go = first.page.elements.find(e => e.label === 'Go')!;
  const action = { kind: 'click' as const, ref: go.ref };
  const permit = await browser.prepareAction(owner, c, action);
  const before = hits.filter(h => h.path === '/submit').length;
  const r = await browser.act(owner, c, action, authority(), permit!);
  const sent = hits.filter(h => h.path === '/submit').length - before;
  return { actual: `sent ${sent} time(s); page: ${textOf(r)}`, defect: sent !== 1 };
});
await probe('popup-tab', 'A link with target=_blank opens a usable tab', async c => {
  const first = await open(c, '/popup');
  const link = first.page.elements.find(e => e.label === 'open in tab')!;
  const r = await browser.act(owner, c, { kind: 'click', ref: link.ref }, authority());
  return { actual: `url=${new URL(r.page.url).pathname} text=${textOf(r)}`, defect: !r.page.text.includes('next page') };
});
await probe('long-link', 'A link longer than 200 characters can be followed', async c => {
  const first = await open(c, '/longlink');
  const link = first.page.elements.find(e => e.label === 'long link')!;
  const r = await browser.act(owner, c, { kind: 'click', ref: link.ref }, authority());
  return { actual: `url path=${new URL(r.page.url).pathname}`, defect: !r.page.text.includes('next page') };
});
await probe('resource-over-2mb', 'One 3 MB script does not fail the whole page', async c => {
  const r = await open(c, '/big'); return { actual: textOf(r), defect: false };
});
await probe('hands-on-pointer-navigation', 'A person using the takeover pointer can follow a link', async c => {
  await open(c, '/plain');
  const handle = (await (browser as any).conversation(owner, c)).page;
  const box = await handle.locator('a').boundingBox();
  await browser.pointer(owner, c, (box.x + box.width / 2) / 1280, (box.y + box.height / 2) / 800);
  await new Promise(r => setTimeout(r, 1200));
  const r = await browser.observe(owner, c);
  return { actual: `url path=${new URL(r.page.url).pathname}`, defect: !r.page.text.includes('next page') };
});
await probe('hands-on-keyboard-submit', 'A person typing Enter in the takeover can submit a login form', async c => {
  await open(c, '/login');
  const handle = (await (browser as any).conversation(owner, c)).page;
  await handle.locator('input[name=u]').focus();
  await browser.keyboard(owner, c, { text: 'me', key: 'Enter' });
  await new Promise(r => setTimeout(r, 1200));
  const r = await browser.observe(owner, c);
  return { actual: `url path=${new URL(r.page.url).pathname}`, defect: !r.page.text.includes('submitted') };
});
await probe('account-cookie-isolation', 'Saved login persists within one owner account and stays out of another account', async c => {
  await browser.bindAccount(owner, c, 'first-account');
  await open(c, '/setcookie');
  const same = `${c}-same`, other = `${c}-b`;
  await browser.bindAccount(owner, same, 'first-account');
  await open(same, '/readcookie');
  const shared = hits.filter(h => h.path === '/readcookie').at(-1)?.cookie ?? '';
  await browser.closeConversation(owner, same);
  await browser.bindAccount(owner, other, 'second-account');
  await open(other, '/readcookie');
  await browser.closeConversation(owner, other);
  const seen = hits.filter(h => h.path === '/readcookie').at(-1)?.cookie ?? '';
  return { actual: `same account cookie: "${shared}"; different account cookie: "${seen}"`, defect: !shared.includes('sid=') || seen.includes('sid=') };
});
await probe('eviction-during-action', 'A fifth conversation does not close a page with a running action', async c => {
  await open(c, '/wait');
  const waiting = browser.act(owner, c, { kind: 'wait', text: '6000' }, authority()).then(r => r.page.url, (e: any) => `failed:${e.code ?? e.message}`);
  const opened: string[] = [];
  for (let i = 0; i < 4; i++) { const id = `${c}-x${i}`; opened.push(id); await open(id, '/plain'); }
  const outcome = await waiting;
  for (const id of opened) await browser.closeConversation(owner, id).catch(() => {});
  return { actual: `running action resolved on ${outcome}`, defect: !outcome.endsWith('/wait') };
});
{
  const nav = hits.find(h => h.path === '/plain');
  findings.push({ id: 'identity-headers', expected: 'Informational: what a site sees', actual: `UA="${nav?.ua}" referer=${nav?.referer ?? 'none'}`, verdict: 'INFO' });
  console.log(`[INFO] identity-headers ${nav?.ua} referer=${nav?.referer ?? 'none'}`);
}

// Latency, measured only on pages that work today.
const stats = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return { n: s.length, p50: Math.round(s[Math.floor(s.length * 0.5)]), p95: Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]), max: Math.round(s.at(-1)!) }; };
const timed = async (rounds: number, work: () => Promise<unknown>) => { const out: number[] = []; for (let i = 0; i < (process.argv.includes('--quick') ? 2 : rounds); i++) { const start = performance.now(); await bounded(work()); out.push(performance.now() - start); } return stats(out); };
const c = 'latency';
await open(c, '/plain');
const latency = {
  open: await timed(15, () => open(c, '/plain')),
  observe: await timed(15, () => browser.observe(owner, c)),
  scroll: await timed(10, () => browser.act(owner, c, { kind: 'scroll', text: 'down' }, authority())),
};
await open(c, '/stale');
const stale = await browser.observe(owner, c);
const button = stale.page.elements.find(e => e.label === 'Other action')!;
const click = await timed(15, () => browser.act(owner, c, { kind: 'click', ref: button.ref }, authority()));
await open(c, '/prefilled');
const typed = await browser.observe(owner, c);
const box = typed.page.elements.find(e => e.role === 'textbox')!;
const type = await timed(15, () => browser.act(owner, c, { kind: 'type', ref: box.ref, text: 'value' }, authority()));
const summary = { latency: { ...latency, click, type }, findings, origin, at: new Date().toISOString() };
console.log(JSON.stringify(summary.latency));
await mkdir('artifacts', { recursive: true });
// Keep the original BR0/BR1 evidence intact for comparison.
await writeFile('artifacts/browser-baseline-current.json', JSON.stringify(summary, null, 2));
process.exitCode = findings.some(finding => finding.verdict === 'DEFECT') ? 1 : 0;
} finally {
await browser.close();
await new Promise(resolve => server.close(resolve));
const tempRoot = await realpath(tmpdir()), target = await realpath(profile), within = relative(tempRoot, target);
if (isAbsolute(within) || !/^mohassan-br0-[^/\\]+$/.test(within)) throw new Error('Unsafe fixture cleanup');
await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
