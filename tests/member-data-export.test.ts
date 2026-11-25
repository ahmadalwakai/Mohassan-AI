import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { sql } from 'kysely';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GoogleAdsBriefSchema } from '@mohassan/contracts';
import { buildOperations, operationsHash, summarizeOperations } from '@mohassan/google-ads';
import { listZip } from '@mohassan/sites';
import { createApplication } from '../apps/server/src/app.ts';
import { createMemberDataExport } from '../apps/server/src/member-data-export.ts';
import { addPlatformMemberData } from './fixtures/platform-member-data.ts';

const exportUrl = '/api/member-data/export';
const origin = 'http://127.0.0.1:3000';
const internalSecret = 'member-export-internal-fixture-only';
const setupToken = 'member-export-setup-fixture-only';
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const headers = (cookie?: string) => ({ origin, 'x-mohassan-internal': internalSecret, ...(cookie ? { cookie } : {}) });

// The PKWARE APPNOTE sections 4.3.7, 4.3.12 and 4.3.16 specify the header locations.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT (retrieved 2026-11-25).
function readArchive(archive: Buffer) {
  const directory = listZip(archive);
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  let header = archive.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (const entry of directory) {
    const local = archive.readUInt32LE(header + 42);
    const nameLength = archive.readUInt16LE(local + 26);
    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    expect(archive.toString('utf8', local + 30, local + 30 + nameLength)).toBe(entry.path);
    expect(entry.method).toBe(0);
    expect(archive.readUInt32LE(local + 14)).toBe(entry.crc);
    expect(archive.readUInt32LE(local + 18)).toBe(entry.size);
    expect(archive.readUInt32LE(local + 22)).toBe(entry.size);
    const dataStart = local + 30 + nameLength + archive.readUInt16LE(local + 28);
    const data = archive.subarray(dataStart, dataStart + entry.size);
    expect(data.byteLength).toBe(entry.size);
    expect(crc32(data)).toBe(entry.crc);
    expect(files.has(entry.path)).toBe(false);
    files.set(entry.path, data);
    header += 46 + archive.readUInt16LE(header + 28) + archive.readUInt16LE(header + 30) + archive.readUInt16LE(header + 32);
  }
  expect(header).toBe(end);
  return files;
}

function readTable(files: Map<string, Buffer>, table: string): Record<string, unknown>[] {
  const file = files.get(`data/${table}.json`);
  expect(file).toBeDefined();
  return JSON.parse(file!.toString('utf8'));
}

const contains = (files: Map<string, Buffer>, value: string | Buffer) =>
  [...files].some(([name, bytes]) => (typeof value === 'string' && name.includes(value)) || bytes.includes(value));

// Fixtures follow the live migrations, including indirect ownership through chat conversations.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/auth.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/command-chat.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/apps/server/src/sites.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/packages/browser/src/files.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/packages/google-ads/src/store.ts
// https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff7/packages/google-ads/src/verifier.ts (retrieved 2026-11-25).
describe('signed-in account exports', () => {
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let directory: string | undefined;
  let documentsDir: string;
  const app = () => application!.app;
  const db = () => application!.database.db;

  async function signIn(email: string, password: string, remoteAddress?: string) {
    const response = await app().inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: headers(), payload: { email, password }, remoteAddress });
    expect(response.statusCode).toBe(200);
    const cookie = [response.headers['set-cookie']].flat().filter(Boolean).map(value => String(value).split(';')[0]).join('; ');
    expect(Boolean(cookie)).toBe(true);
    return cookie;
  }

  async function makeAccount(label: string, ownerCookie?: string) {
    const name = `${label} export fixture`;
    const email = `${label}@member-export.example.test`;
    const password = `fixture-${label}-password`;
    if (ownerCookie) {
      const invite = await app().inject({ method: 'POST', url: '/api/members/invites', headers: headers(ownerCookie), payload: { name, email } });
      expect(invite.statusCode).toBe(200);
      const token = new URL(invite.json().url).hash.slice('#invite='.length);
      const accept = await app().inject({ method: 'POST', url: '/api/invites/accept', headers: headers(), payload: { token, name, password } });
      expect(accept.statusCode).toBe(200);
    } else {
      const setup = await app().inject({ method: 'POST', url: '/api/setup', headers: headers(), payload: { name, email, password, setupToken } });
      expect(setup.statusCode).toBe(200);
    }
    const cookie = await signIn(email, password);
    const access = await app().inject({ url: '/api/access', headers: headers(cookie) });
    expect(access.statusCode).toBe(200);
    expect(access.json().role).toBe(ownerCookie ? 'member' : 'owner');
    const id = access.json().user.id as string;
    return { id, name, email, label, cookie, password };
  }

  async function addData(account: Awaited<ReturnType<typeof makeAccount>>, pixel: number) {
    const conversationId = randomUUID();
    const imageId = randomUUID();
    const siteId = randomUUID();
    const siteImageId = randomUUID();
    const message = `Message belonging to ${account.name}`;
    const image = new PNG({ width: 16, height: 16 });
    image.data.fill(pixel);
    const png = PNG.sync.write(image);
    await db().insertInto('chat_conversations').values({ id: conversationId, owner_id: account.id, title: account.name }).execute();
    const platform = await addPlatformMemberData(db(), account.id, conversationId);
    await db().insertInto('chat_messages').values({ id: randomUUID(), conversation_id: conversationId, text: message, role: 'user' }).execute();
    await db().insertInto('chat_images').values({
      id: imageId, owner_id: account.id, conversation_id: conversationId, width: image.width, height: image.height,
      bytes: png.byteLength, mime_type: 'image/png', content_hash: hash(png), data_base64: png.toString('base64'),
    }).execute();
    await db().insertInto('sites').values({
      id: siteId, owner_id: account.id, conversation_id: conversationId, slug: account.label,
      brief: '{}', files: '[]', files_hash: hash(Buffer.from('[]')), checks: '{}', generator_version: 'fixture', status: 'draft',
    }).execute();
    await db().insertInto('site_images').values({
      id: siteImageId, site_id: siteId, owner_id: account.id, mime_type: 'image/png', width: image.width, height: image.height,
      data_base64: png.toString('base64'), small_base64: png.toString('base64'), alt: account.name, role: 'gallery',
    }).execute();

    const pdf = await PDFDocument.create();
    pdf.setTitle(account.name);
    pdf.addPage();
    const document = Buffer.from(await pdf.save());
    const documentName = `${account.label} مستند.pdf`;
    const uploaded = await app().inject({
      method: 'POST', url: '/api/documents/upload', headers: headers(account.cookie),
      payload: { name: documentName, base64: document.toString('base64') },
    });
    expect(uploaded.statusCode).toBe(200);
    const documentId = uploaded.json().id as string;

    const files = await Promise.all([
      { direction: 'upload', status: 'pending' },
      { direction: 'download', status: 'released' },
      { direction: 'download', status: 'quarantined' },
    ].map(async ({ direction, status }) => {
      const id = randomUUID();
      const filename = `transfer-${status}-${account.label}.txt`;
      const bytes = Buffer.from(`File ${status} belonging to ${account.name}`);
      await db().insertInto('browser_file_grants').values({
        id, owner_id: account.id, conversation_id: conversationId, direction, status, filename, target: JSON.stringify({}),
        media_type: 'text/plain', bytes_base64: bytes.toString('base64'), content_hash: hash(bytes), byte_count: bytes.byteLength,
        expires_at: sql<Date>`now() + interval '10 minutes'`,
      }).execute();
      return { id, status, filename, bytes };
    }));

    const oauthSecrets = {
      accessToken: `fixture-access-field-${account.id}`,
      refreshToken: `fixture-refresh-field-${account.id}`,
      idToken: `fixture-id-field-${account.id}`,
    };
    const credential = await db().updateTable('account').set(oauthSecrets).where('userId', '=', account.id)
      .returning('password').executeTakeFirstOrThrow();
    expect(Boolean(credential.password)).toBe(true);
    const adsName = `Ads fixture ${account.name}`;
    const adsSecrets = {
      sealed_refresh_token: `fixture-sealed-field-${account.id}`,
      customer_id: String(pixel).padEnd(10, '6'),
      login_customer_id: String(pixel).padEnd(10, '7'),
    };
    await db().insertInto('google_ads_connections').values({ owner_id: account.id, status: 'connected', account_name: adsName, ...adsSecrets }).execute();
    const brief = GoogleAdsBriefSchema.parse({
      businessName: account.name, service: 'Book repairs', goal: 'bookings', landingPageUrl: 'https://example.test/book',
      locations: ['London'], countryCode: 'GB', adLanguage: 'en', dailyBudget: '2.00', ownerFacts: [],
      headlines: ['Book repairs today'], descriptions: ['Reserve your repair appointment'], paths: [], keywords: ['repairs'], negativeKeywords: [],
    });
    const draftId = randomUUID();
    const bidding = 'MANUAL_CPC';
    const operations = buildOperations(brief, draftId, adsSecrets.customer_id, [], bidding);
    const summary = summarizeOperations(adsSecrets.customer_id, operations, new Map());
    expect(summary).not.toBeNull();
    await db().insertInto('google_ads_drafts').values({
      id: draftId, owner_id: account.id, customer_id: adsSecrets.customer_id, idempotency_key: randomUUID(), state: 'preview', bidding,
      brief: JSON.stringify(brief), operations: JSON.stringify(operations), draft_hash: operationsHash(adsSecrets.customer_id, operations),
      summary: JSON.stringify(summary), error: `Fixture resource customers/${adsSecrets.customer_id}/campaigns/1`,
    }).execute();
    const apiKey = `fixture-api-field-${account.id}`;
    await db().insertInto('chat_events').values({
      id: randomUUID(), conversation_id: conversationId, kind: 'progress', message: 'Export fixture event',
      data: JSON.stringify({ detail: { apiKey, field: 'Safe fixture value', text: `Connected as ${adsSecrets.login_customer_id}` } }),
    }).execute();

    return { message, png, imageId, siteImageId, document, documentId, documentName, files, adsName, campaign: summary!.campaignName, platform,
      secrets: [...Object.values(oauthSecrets), ...Object.values(adsSecrets), ...platform.secrets, apiKey, credential.password as string],
    };
  }

  let owner: Awaited<ReturnType<typeof makeAccount>>;
  let member: Awaited<ReturnType<typeof makeAccount>>;
  let other: Awaited<ReturnType<typeof makeAccount>>;
  let ownData: Awaited<ReturnType<typeof addData>>;
  let ownerData: Awaited<ReturnType<typeof addData>>;
  let otherData: Awaited<ReturnType<typeof addData>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'mohassan-member-export-'));
    documentsDir = join(directory, 'documents');
    application = await createApplication({
      authSecret: 'mohassan-member-export-auth-fixture', internalSecret, setupToken, webOrigin: origin,
      production: false, runWorker: false, documentsDir, browserProfileDir: join(directory, 'browser'),
    });
    owner = await makeAccount('owner');
    member = await makeAccount('member', owner.cookie);
    other = await makeAccount('other', owner.cookie);
    ownerData = await addData(owner, 51);
    ownData = await addData(member, 102);
    otherData = await addData(other, 153);
  }, 60_000);

  beforeEach(async () => {
    await db().deleteFrom('member_data_exports').execute();
  });

  afterAll(async () => {
    await application?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('downloads only the requester’s JSON and files without exporting credentials', async () => {
    const response = await app().inject({ url: exportUrl, headers: headers(member.cookie) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toMatch(/^attachment;/);
    expect(response.headers['cache-control']).toBe('no-store');
    const archive = readArchive(response.rawPayload);

    // Check every archive entry, and keep fixture values out of failure messages.
    const sessions = await db().selectFrom('session').select('token').execute();
    const invites = await db().selectFrom('workspace_invites').select('token_hash').execute();
    const secrets = [member.password, owner.password, other.password, ...ownData.secrets, ...ownerData.secrets, ...otherData.secrets,
      ...sessions.map(row => row.token as string), ...invites.map(row => row.token_hash as string),
    ];
    for (const value of [...secrets, owner.email, other.email]) expect(contains(archive, value)).toBe(false);

    expect(archive.get('README.txt')?.toString('utf8')).toMatch(/\p{Script=Arabic}+/u);
    expect(readTable(archive, 'user')).toMatchObject([{ id: member.id, email: member.email }]);
    expect(readTable(archive, 'chat_messages')).toMatchObject([{ text: ownData.message }]);
    expect(readTable(archive, 'chat_events')).toMatchObject([{ data: { detail: { field: 'Safe fixture value' } } }]);
    expect(readTable(archive, 'google_ads_connections')).toEqual([{ account_name: ownData.adsName }]);
    expect(readTable(archive, 'google_ads_drafts')).toMatchObject([{ summary: { campaignName: ownData.campaign } }]);
    for (const [table, row] of Object.entries(ownData.platform.exportedRows)) {
      expect(readTable(archive, table)).toMatchObject([row]);
    }
    expect(archive.get(`files/chat-images/${ownData.imageId}.png`)?.equals(ownData.png)).toBe(true);
    expect(archive.get(`files/site-images/${ownData.siteImageId}.png`)?.equals(ownData.png)).toBe(true);
    expect(archive.get(`files/site-images/${ownData.siteImageId}-small.png`)?.equals(ownData.png)).toBe(true);
    expect(archive.get(`files/documents/${ownData.documentId}/${ownData.documentName}`)?.equals(ownData.document)).toBe(true);
    for (const file of ownData.files) {
      if (file.status === 'quarantined') {
        expect(contains(archive, file.bytes)).toBe(false);
      } else {
        expect(archive.get(`files/transfers/${file.id}/${file.filename}`)?.equals(file.bytes)).toBe(true);
      }
    }
    for (const foreign of [ownerData, otherData]) {
      for (const value of [foreign.message, foreign.adsName, foreign.imageId, foreign.siteImageId, foreign.documentId, foreign.document, foreign.png]) {
        expect(contains(archive, value)).toBe(false);
      }
      for (const file of foreign.files) expect(contains(archive, file.bytes)).toBe(false);
    }

    const ownerResponse = await app().inject({ url: exportUrl, headers: headers(owner.cookie) });
    expect(ownerResponse.statusCode).toBe(200);
    const ownerArchive = readArchive(ownerResponse.rawPayload);
    for (const value of [...secrets, member.email, other.email]) expect(contains(ownerArchive, value)).toBe(false);
    expect(readTable(ownerArchive, 'user')).toMatchObject([{ id: owner.id, email: owner.email }]);
    expect(readTable(ownerArchive, 'chat_messages')).toMatchObject([{ text: ownerData.message }]);
  });

  it('allows one download per hour per account across sessions and concurrent requests', async () => {
    const secondSession = await signIn(member.email, member.password, '127.0.0.2');
    expect((await app().inject({ method: 'HEAD', url: exportUrl, headers: headers(member.cookie) })).statusCode).toBe(404);
    const [first, second] = await Promise.all([
      app().inject({ url: exportUrl, headers: headers(member.cookie) }),
      app().inject({ url: exportUrl, headers: headers(secondSession) }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 429]);
    const limited = [first, second].find(response => response.statusCode === 429)!;
    expect(limited.json().error.code).toBe('MEMBER_EXPORT_RATE_LIMIT');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect((await app().inject({ url: exportUrl, headers: headers(other.cookie) })).statusCode).toBe(200);

    await db().updateTable('member_data_exports').set({ requested_at: sql<Date>`now() - interval '59 minutes'` }).where('user_id', '=', member.id).execute();
    expect((await app().inject({ url: exportUrl, headers: headers(member.cookie) })).statusCode).toBe(429);
    await db().updateTable('member_data_exports').set({ requested_at: sql<Date>`now() - interval '1 hour'` }).where('user_id', '=', member.id).execute();
    expect((await app().inject({ url: exportUrl, headers: headers(member.cookie) })).statusCode).toBe(200);
  });

  it('omits a Google Ads name that is actually the customer ID fallback', async () => {
    const connection = await db().selectFrom('google_ads_connections').select('customer_id').where('owner_id', '=', other.id).executeTakeFirstOrThrow();
    const customerId = connection.customer_id as string;
    await db().updateTable('google_ads_connections').set({ account_name: customerId }).where('owner_id', '=', other.id).execute();
    try {
      const response = await app().inject({ url: exportUrl, headers: headers(other.cookie) });
      expect(response.statusCode).toBe(200);
      const archive = readArchive(response.rawPayload);
      expect(contains(archive, customerId)).toBe(false);
      expect(readTable(archive, 'google_ads_connections')).toEqual([{ account_name: null }]);
    } finally {
      await db().updateTable('google_ads_connections').set({ account_name: otherData.adsName }).where('owner_id', '=', other.id).execute();
    }
  });

  it('rejects before returning an archive stream when the byte cap is crossed', async () => {
    const fullExport = await app().inject({ url: exportUrl, headers: headers(member.cookie) });
    expect(fullExport.statusCode).toBe(200);
    await db().deleteFrom('member_data_exports').where('user_id', '=', member.id).execute();
    const exporter = createMemberDataExport(db(), { documentsDir, maxBytes: fullExport.rawPayload.byteLength - 1 });
    await expect(exporter.prepare(member.id)).rejects.toMatchObject({ statusCode: 413, code: 'MEMBER_EXPORT_TOO_LARGE' });
  });
});
