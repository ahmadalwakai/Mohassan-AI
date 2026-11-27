import { createHash, randomUUID } from 'node:crypto';
import { AgentBrowser, BrowserFileGrantSchema, BROWSER_FILE_MAX_BYTES, evidenceHash, type AgentFileTarget } from '@mohassan/browser';
import { ChatConversationSchema, PhoneOkReplySchema } from '@mohassan/contracts';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { checkError, checkJson, openClientApiApp } from './support/client-api-app.js';

// Browser files has no shared reply DTO. The browser package owns the request and response projections (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/files.ts#L52-L66
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/browser/src/agent-browser.ts#L1244-L1253
const hexDigest = z.string().regex(/^[a-f0-9]{64}$/);
const direction = z.enum(['upload', 'download']);
const observedTarget = z.strictObject({ ref: z.string(), label: z.string() });
const targetsReply = z.strictObject({
  uploads: z.array(observedTarget),
  downloads: z.array(observedTarget.extend({ url: z.url() })),
});
const transferReply = z.strictObject({
  id: z.uuid(), direction, status: z.string(),
  target: observedTarget.extend({
    direction, url: z.url(), pageHash: hexDigest, cookieHash: hexDigest,
    accountId: z.string().nullable(), formHash: hexDigest.nullable(),
    fieldName: z.string().nullable(), fieldNames: z.array(z.string()),
  }),
  filename: z.string().nullable(), type: z.string().nullable(), hash: hexDigest.nullable(), size: z.number().int().nullable(),
  inspection: z.string().nullable(), responseStatus: z.number().int().nullable(), errorCode: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
const filesReply = z.strictObject({ files: z.array(transferReply), maxBytes: z.literal(BROWSER_FILE_MAX_BYTES), supported: z.array(z.string()) });

it('validates file grants and download replies for a signed-in member on the real Fastify app', async () => {
  const fixture = await openClientApiApp();
  const restorers: Array<() => void> = [];
  try {
    const { send, setupOwner, inviteMember } = fixture;
    const owner = await setupOwner();
    const member = await inviteMember(owner);
    const conversation = checkJson(await send('POST', '/api/chat/conversations', member, {}), 200, ChatConversationSchema);
    const base = `/api/browser/files/${conversation.id}`;
    checkError(await send('GET', base), 401, 'UNAUTHORIZED');
    checkError(await send('GET', base, owner), 404, 'BROWSER_FILE_CONVERSATION_NOT_FOUND');
    expect(checkJson(await send('GET', base, member), 200, filesReply).files).toEqual([]);
    expect(checkJson(await send('GET', `${base}/targets`, member), 200, targetsReply)).toEqual({ uploads: [], downloads: [] });
    const grantRequest = BrowserFileGrantSchema.parse({ direction: 'download', ref: 'e1' });
    checkError(await send('POST', `${base}/grants`, member, grantRequest), 409, 'BROWSER_FILE_PAGE_REQUIRED');

    // Stub only the observed browser target and transport. Grant state, authorization, inspection,
    // hashing, and the attachment response all run through Fastify and the real temporary database.
    const data = Buffer.from('Browser file contract fixture');
    const url = 'http://127.0.0.1/download.txt';
    const target: AgentFileTarget = {
      ...grantRequest, label: 'Download fixture', url, pageHash: evidenceHash(url), cookieHash: evidenceHash('[]'),
      accountId: null, formHash: null, fieldName: null, fieldNames: [],
    };
    const describe = vi.spyOn(AgentBrowser.prototype, 'describeFileTarget').mockResolvedValue(target);
    restorers.push(() => describe.mockRestore());
    const fetchFile = vi.spyOn(AgentBrowser.prototype, 'transferFile').mockImplementation(async (_user, _conversation, _target, options) => {
      await options.assertActive();
      await options.dispatched();
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: data, url };
    });
    restorers.push(() => fetchFile.mockRestore());

    const created = checkJson(await send('POST', `${base}/grants`, member, grantRequest), 200, transferReply);
    expect(created.status).toBe('pending');
    const grant = `${base}/grants/${created.id}`;
    checkError(await send('POST', `${grant}/execute`, owner, {}), 404, 'BROWSER_FILE_CONVERSATION_NOT_FOUND');
    const quarantine = checkJson(await send('POST', `${grant}/execute`, member, {}), 200, transferReply);
    expect(quarantine).toMatchObject({ status: 'quarantined', hash: createHash('sha256').update(data).digest('hex'), size: data.byteLength });
    checkError(await send('GET', `${grant}/content`, member), 403, 'BROWSER_FILE_QUARANTINED');
    checkError(await send('POST', `${grant}/execute`, member, {}), 409, 'BROWSER_FILE_GRANT_USED');
    expect(fetchFile).toHaveBeenCalledTimes(1);
    const released = checkJson(await send('POST', `${grant}/release`, member, {}), 200, transferReply);
    expect(released.status).toBe('released');
    const attachment = await send('GET', `${grant}/content`, member);
    expect(attachment.statusCode).toBe(200);
    expect(attachment.headers['content-type']).toBe('application/octet-stream');
    expect(attachment.headers['content-disposition']).toContain('attachment;');
    expect(attachment.headers['content-disposition']).toContain(released.filename);
    expect(attachment.rawPayload.equals(data)).toBe(true);
    expect(checkJson(await send('GET', base, member), 200, filesReply).files).toEqual([released]);
    expect(checkJson(await send('DELETE', grant, member), 200, PhoneOkReplySchema).ok).toBe(true);
    checkError(await send('GET', `${grant}/content`, member), 403, 'BROWSER_FILE_QUARANTINED');

    // The grant route permits eight requests per minute (browser-files.ts:25, retrieved 2026-11-27).
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/browser-files.ts#L25
    const missingGrantPath = `/api/browser/files/${randomUUID()}/grants`;
    for (let attempt = 0; attempt < 6; attempt++) {
      checkError(await send('POST', missingGrantPath, member, grantRequest), 404, 'BROWSER_FILE_CONVERSATION_NOT_FOUND');
    }
    checkError(await send('POST', missingGrantPath, member, grantRequest), 429);
  } finally {
    for (const restore of restorers.reverse()) restore();
    await fixture.close();
  }
});
