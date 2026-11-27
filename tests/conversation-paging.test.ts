import { randomUUID } from 'node:crypto';
import { ChatConversationListSchema } from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApplication } from '../apps/server/src/app.js';

const route = '/api/chat/conversations';
const origin = 'http://127.0.0.1:3000';
const internalSecret = randomUUID();
const setupToken = randomUUID();
const owner = { name: 'Paging owner', email: 'paging-owner@example.test', password: randomUUID() };
const member = { name: 'Paging member', email: 'paging-member@example.test', password: randomUUID() };
const headers = (cookie = '') => ({ origin, 'x-mohassan-internal': internalSecret, cookie });
const indexedId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const at = (index: number) => `2026-11-27T00:00:00.${String(Math.floor(index / 3)).padStart(6, '0')}Z`;
// Synthetic titles exercise the Arabic folds documented in conversation-paging.ts.
const arabicTitle = 'إِدَارَة خُطَّـة مَسْؤُولِيَّة عَلَى بِئْرٍ وَإِنْشَاء';
const foldedTitle = 'اداره خطه مسووليه علي بير وانشا';
const titles = new Map([[0, arabicTitle], [19, foldedTitle], [23, 'Quarterly Report 10%_complete'], [24, 'Quarterly Report 10XYcomplete']]);
const memberRows = Array.from({ length: 65 }, (_, index) => ({
  id: indexedId(index), title: titles.get(index) ?? `Conversation ${index}`, status: 'idle' as const,
  updated_at: at(index), browser_account: index === 1 ? 'fixture-profile' : null,
}));
const memberIdsDescending = memberRows.map(row => row.id).reverse();

describe('conversation list paging and title search', () => {
  let application: Awaited<ReturnType<typeof createApplication>>;
  let ownerCookie: string;
  let memberCookie: string;
  let ownerOnlyId: string;

  const post = (url: string, payload: object, cookie?: string) =>
    application.app.inject({ method: 'POST', url, payload, headers: headers(cookie) });
  const get = (url: string, cookie: string) => application.app.inject({ url, headers: headers(cookie) });

  async function signIn({ email, password }: typeof member) {
    const response = await post('/api/auth/sign-in/email', { email, password });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
    expect(cookie).not.toBe('');
    return cookie;
  }

  async function list(params?: Record<string, string>, cookie = memberCookie) {
    const response = await get(params ? `${route}?${new URLSearchParams(params)}` : route, cookie);
    expect(response.statusCode).toBe(200);
    return ChatConversationListSchema.parse(response.json());
  }

  beforeAll(async () => {
    application = await createApplication({
      production: false, runWorker: false, authSecret: randomUUID(), internalSecret, setupToken, webOrigin: origin,
    });
    expect((await post('/api/setup', { ...owner, setupToken })).statusCode).toBe(200);
    ownerCookie = await signIn(owner);
    const invitation = await post('/api/members/invites', { name: member.name, email: member.email }, ownerCookie);
    expect(invitation.statusCode).toBe(200);
    const token = new URLSearchParams(new URL(invitation.json().url).hash.slice(1)).get('invite');
    expect((await post('/api/invites/accept', { token, name: member.name, password: member.password })).statusCode).toBe(200);
    memberCookie = await signIn(member);
    const ownerAccess = (await get('/api/access', ownerCookie)).json();
    const memberAccess = (await get('/api/access', memberCookie)).json();
    expect(memberAccess.role).toBe('member');
    ownerOnlyId = randomUUID();
    await application.database.db.insertInto('chat_conversations').values([
      ...memberRows.map(row => ({ ...row, owner_id: memberAccess.user.id })),
      { id: ownerOnlyId, owner_id: ownerAccess.user.id, title: arabicTitle, status: 'idle', updated_at: at(memberRows.length) },
    ]).execute();
    await application.database.db.insertInto('chat_messages').values({
      id: randomUUID(), conversation_id: memberRows[1].id, text: arabicTitle, role: 'user',
    }).execute();
  });

  afterAll(async () => { await application?.app.close(); });

  it('returns 60 then 5 in a stable order across timestamp ties and microseconds', async () => {
    const first = await list({ limit: '60' });
    expect(first.conversations.map(row => row.id)).toEqual(memberIdsDescending.slice(0, 60));
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list({ cursor: first.nextCursor! });
    expect(second.conversations.map(row => row.id)).toEqual(memberIdsDescending.slice(60));
    expect(second.nextCursor).toBeNull();
    expect(await list({ limit: '60' })).toEqual(first);
  });

  it('retains the unparameterized response shape and newest-60 limit', async () => {
    const old = await list();
    const paged = await list({ limit: '60' });
    expect(old).toEqual({
      configured: paged.configured, capabilities: paged.capabilities, requestKeys: true,
      conversations: expect.any(Array),
    });
    expect(old.conversations).toHaveLength(60);
    expect(old.conversations.map(row => row.id)).toEqual(expect.arrayContaining(memberIdsDescending.slice(0, 59)));
    const seededById = new Map(memberRows.map(row => [row.id, row]));
    for (const row of old.conversations) {
      const seeded = seededById.get(row.id)!;
      expect(row).toEqual({ id: seeded.id, title: seeded.title, status: seeded.status,
        updatedAt: new Date(seeded.updated_at).toISOString(), browserAccount: seeded.browser_account });
    }
  });

  it('matches Arabic title variants across pages and keeps member and owner results separate', async () => {
    const first = await list({ q: arabicTitle, limit: '1' });
    expect(first.conversations.map(row => row.id)).toEqual([memberRows[19].id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list({ q: foldedTitle, cursor: first.nextCursor! });
    expect(second.conversations.map(row => row.id)).toEqual([memberRows[0].id]);
    expect(second.nextCursor).toBeNull();
    expect((await list({ q: foldedTitle }, ownerCookie)).conversations.map(row => row.id)).toEqual([ownerOnlyId]);
    expect((await get(`${route}/${ownerOnlyId}`, memberCookie)).statusCode).toBe(404);
    expect((await get(`${route}?q=${encodeURIComponent(foldedTitle)}`, '')).statusCode).toBe(401);
  });

  it('matches case-insensitively and treats search punctuation literally', async () => {
    const match = await list({ q: 'REPORT 10%_' });
    expect(match.conversations.map(row => row.id)).toEqual([memberRows[23].id]);
    expect(match.nextCursor).toBeNull();
    expect(await list({ q: 'No matching title' })).toMatchObject({ conversations: [], nextCursor: null });
    expect(await list({ q: 'ـِ' })).toMatchObject({ conversations: [], nextCursor: null });
  });

  it.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2', 'cursor=invalid', 'q=%00'])(
    'rejects invalid list parameters (%s)', async query => {
      const response = await get(`${route}?${query}`, memberCookie);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    },
  );
});
