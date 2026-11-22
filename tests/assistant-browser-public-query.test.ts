import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAction, AgentBrowser, AgentPage, AgentRequestPermit } from '@mohassan/browser';
import { createDatabase, migrate } from '@mohassan/database';
import { createCommandChatControl } from '../apps/server/src/command-chat.js';
import { reviewExplicitPublicBrowserQuery } from '../apps/server/src/assistant/browser-public-query.js';
import { assessRequestScope, reviewPublicProjection } from '../apps/server/src/assistant/request-scope.js';

const OWNER = 'public-browser-query-owner';
const TUTORIAL = 'https://docs.python.org/3/tutorial/index.html';
const ERRORS = 'https://docs.python.org/3/tutorial/errors.html';
const GOAL = `افتح ${TUTORIAL} ثم اضغط على «8. Errors and Exceptions» ثم اكتب exception في خانة Quick search ثم اضغط على «Go» ثم انزل ثم اقرأ الصفحة`;
const fixtures: Array<{ database: Awaited<ReturnType<typeof createDatabase>>; control: Awaited<ReturnType<typeof createCommandChatControl>> }> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.control.shutdown(); await fixture.database.close(); } });

describe('literal public browser query projection', () => {
  it('accepts only the explicit public search operand without broadening navigation authority', () => {
    expect(assessRequestScope(GOAL)).toMatchObject({ source: 'public_lookup', operation: 'act', publicQueryEligible: false });
    expect(reviewPublicProjection(GOAL, 'exception').eligible).toBe(false);
    expect(reviewExplicitPublicBrowserQuery(GOAL, 'exception')).toEqual({ eligible: true, reason: 'eligible' });
    expect(reviewExplicitPublicBrowserQuery(`Open ${TUTORIAL} then search for exception`, 'exception').eligible).toBe(true);
    expect(reviewExplicitPublicBrowserQuery('افتح https://www.wikipedia.org ثم اكتب الطاقة الشمسية في خانة Search Wikipedia ثم اضغط زر Search ثم مرر للأسفل ثم اقرأ الصفحة', 'الطاقة الشمسية').eligible).toBe(true);
  });

  it.each([
    [GOAL, 'exception PRIVATE-CUSTOMER-CANARY'],
    [GOAL, 'Errors and Exceptions'],
    [`Open ${TUTORIAL}`, 'exception'],
    [`Open ${TUTORIAL} then scroll down`, 'exception'],
    [`Open ${TUTORIAL} then type exception into the Name field`, 'exception'],
    [`Open ${TUTORIAL} then type my saved notes into the Quick search field`, 'my saved notes'],
    ['Read my saved customer records.', 'customer records'],
    [`Translate "Open ${TUTORIAL} then type exception into the Quick search field" into Arabic.`, 'exception'],
    [`"Open ${TUTORIAL} then type exception into the Quick search field"`, 'exception'],
    [`The note says "Open ${TUTORIAL} then type exception into the Quick search field".`, 'exception'],
    [`Open https://127.0.0.1/search then type exception into the Quick search field`, 'exception'],
    [`Open https://private.internal/search then type exception into the Quick search field`, 'exception'],
    [`Open https://docs.python.org/3/?token=private then type exception into the Quick search field`, 'exception'],
    [`Open ${TUTORIAL} then type api_key=not-a-real-secret into the Quick search field`, 'api_key=not-a-real-secret'],
    [`Open ${TUTORIAL} then type exception into the Quick search field; do not search the web.`, 'exception'],
  ])('refuses private, supplied, prohibited or unattributed input: %s', (request, query) => {
    expect(reviewExplicitPublicBrowserQuery(request, query).eligible).toBe(false);
  });
});

describe('explicit public browser search queries through the controller', () => {
  it('completes the literal public Python navigation/type/GET-search plan without a continuation', async () => {
    const database = await createDatabase({}); await migrate(database.db);
    const actions: AgentAction[] = [];
    let current: AgentPage | null = null, query = '';
    const page = (url: string): AgentPage => ({ id: randomUUID(), url, title: 'Python public documentation',
      text: 'Python documentation explains syntax errors and exceptions in the public tutorial.',
      elements: [{ ref: 'errors', role: 'link', label: '8. Errors and Exceptions', href: ERRORS, inViewport: true },
        { ref: 'query', role: 'searchbox', label: 'Quick search', field: 'text', value: query, inViewport: true },
        { ref: 'go', role: 'button', label: 'Go', inViewport: true }],
      signals: { captcha: false, password: false, otp: false, card: false }, scroll: { top: 0, height: 2000, viewport: 800 },
      hash: randomUUID().replaceAll('-', '').slice(0, 24), observedAt: new Date().toISOString(), documentStatus: 200 });
    const browser = { setCheckpointStore() {}, async bindAccount() {}, async close() {}, async screen() { return null; },
      async hasPage() { return current !== null; }, async observe() { return { page: current!, changed: false }; },
      async prepareAction(_owner: string, _id: string, action: AgentAction): Promise<AgentRequestPermit | null> {
        return action.kind === 'click' && action.ref === 'go' ? { id: randomUUID(), url: `https://docs.python.org/3/search.html?q=${encodeURIComponent(query)}`,
          method: 'GET', bodyHash: 'a'.repeat(64), pageHash: current!.hash, actionHash: 'b'.repeat(24), expiresAt: Date.now() + 60_000 } : null;
      },
      async act(_owner: string, _id: string, action: AgentAction) {
        actions.push(action);
        if (action.kind === 'open') current = page(action.text!);
        if (action.kind === 'type') { query = action.text!; current = page(current!.url); }
        if (action.kind === 'scroll') current = { ...current!, scroll: { ...current!.scroll, top: 650 } };
        return { page: current!, changed: true };
      },
    } as unknown as AgentBrowser;
    const control = await createCommandChatControl(database.db, { browser, recordExperiences: false, models: { fast: [], deep: [], vision: '' } });
    fixtures.push({ database, control });
    const { id } = await control.create(OWNER, { goal: GOAL }); await control.settled(id);
    const detail = await control.detail(OWNER, id);
    expect(detail.error).toBeNull(); expect(detail.status).toBe('idle');
    expect(actions).toEqual([{ kind: 'open', text: TUTORIAL }, { kind: 'open', text: ERRORS },
      { kind: 'type', ref: 'query', text: 'exception' }, { kind: 'open', text: 'https://docs.python.org/3/search.html?q=exception' }, { kind: 'scroll', text: 'down' }]);
    expect(detail.browser?.url).toBe('https://docs.python.org/3/search.html?q=exception');
    expect(detail.question).toBeNull(); expect(detail.secure).toBeNull(); expect(detail.approval).toBeNull();
    expect(await database.db.selectFrom('chat_messages').select('id').where('conversation_id', '=', id).where('role', '=', 'user').execute()).toHaveLength(1);
  });
});
