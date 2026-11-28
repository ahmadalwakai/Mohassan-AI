import { randomUUID } from 'node:crypto';
import {
  ChromeBindingSchema,
  ChromeClientSchema,
  ChromeExtensionStatusSchema,
  ChromeJobSchema,
  ChromePreferenceSchema,
  ChromeResultSchema,
} from '@mohassan/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PhoneOkReplySchema,
  PhoneWindowsActionReplySchema,
  PhoneWindowsActionRequestSchema,
  PhoneWindowsCompanionPairReplySchema,
  PhoneWindowsCompanionPairRequestSchema,
  PhoneWindowsCompanionPollReplySchema,
  PhoneWindowsCompanionPollRequestSchema,
  PhoneWindowsFrameReplySchema,
  PhoneWindowsGrantRequestSchema,
  PhoneWindowsGrantSchema,
  PhoneWindowsOverviewSchema,
  PhoneWindowsPairingSchema,
} from '../packages/contracts/src/phone-replies.js';
import { checkError, checkJson, openClientApiApp, type ClientApiAccount } from './support/client-api-app.js';

// The claim envelope follows the server handler (retrieved 2026-11-27).
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/apps/server/src/chrome-extension.ts#L131-L144
const claimReply = z.strictObject({ job: ChromeJobSchema.nullable() });

// Existing campaign input from tests/chrome-extension-api.test.ts, retrieved 2026-11-27.
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/tests/chrome-extension-api.test.ts#L11
const campaign = [
  'BUSINESS: Local Tyres', 'SERVICE: Mobile Tyre Fitting', 'GOAL: calls', 'URL: https://localtyres.co.uk/',
  'LOCATION: Wigan', 'COUNTRY: GB', 'LANGUAGE: en', 'BUDGET: 20', 'CURRENCY: £',
  'H: Mobile Tyre Fitting', 'H: Local Tyres Wigan', 'H: Tyres At Your Home',
  'D: Mobile tyre fitting at your home across Wigan.', 'D: Find tyres for your car and arrange a fitting.',
  'K: "mobile tyre fitting"', 'N: jobs',
].join('\n');

let fixture: Awaited<ReturnType<typeof openClientApiApp>>;
let owner: ClientApiAccount;
let member: ClientApiAccount;

beforeAll(async () => {
  fixture = await openClientApiApp({ windowsEnabled: true });
  owner = await fixture.setupOwner();
  member = await fixture.inviteMember(owner);
});

afterAll(async () => {
  await fixture?.close();
});

describe('Chrome extension and workspace contracts', () => {
  it('checks the real status, pairing, claim, result, resume, cancel and disconnect replies', async () => {
    const { application, send } = fixture;
    const base = '/api/chrome-extension';
    const status = `${base}/status`;
    checkError(await send('GET', status), 401, 'UNAUTHORIZED');
    checkError(await send('GET', status, member), 403, 'MEMBER_FORBIDDEN');
    expect(checkJson(await send('GET', status, owner), 200, ChromeExtensionStatusSchema).connected).toBe(false);

    const binding = ChromeBindingSchema.parse({
      clientId: randomUUID(), tabId: 17, customerId: '1234567890', currency: 'GBP', extensionVersion: '0.1.0',
    });
    const client = ChromeClientSchema.parse({ clientId: binding.clientId });
    checkJson(await send('POST', `${base}/preference`, owner, ChromePreferenceSchema.parse({ transport: 'chrome' })), 200, ChromeExtensionStatusSchema);
    checkJson(await send('POST', `${base}/heartbeat`, owner, binding), 200, ChromeExtensionStatusSchema);
    expect(checkJson(await send('POST', `${base}/jobs/claim`, owner, client), 200, claimReply).job).toBeNull();
    checkError(await send('POST', `${base}/jobs/${randomUUID()}/resume`, owner, client), 404, 'CHROME_JOB_NOT_FOUND');

    // Queue directly through the server's controller. The HTTP app owns every response under test.
    const { id } = await application.chromeExtension.queueCampaign(owner.id, campaign, randomUUID());
    const { job } = checkJson(await send('POST', `${base}/jobs/claim`, owner, client), 200, claimReply);
    expect(job?.id).toBe(id);
    const result = ChromeResultSchema.parse({
      ...client, leaseId: job?.leaseId, status: 'needs_attention', message: 'Fixture requires review', steps: [],
    });
    checkJson(await send('POST', `${base}/jobs/${id}/result`, owner, result), 200, ChromeExtensionStatusSchema);
    checkError(await send('POST', `${base}/jobs/${id}/result`, owner, result), 409, 'CHROME_RESULT_STALE');
    checkJson(await send('POST', `${base}/jobs/${id}/resume`, owner, client), 200, ChromeExtensionStatusSchema);
    checkJson(await send('POST', `${base}/jobs/${id}/cancel`, owner, {}), 200, ChromeExtensionStatusSchema);
    checkJson(await send('POST', `${base}/disconnect`, owner, client), 200, ChromeExtensionStatusSchema);
  });
});

describe('Windows companion and workspace contracts', () => {
  it('checks device pairing, poll, workspace overview, frame, grant, action, stop and revoke replies', async () => {
    const { application, send } = fixture;
    const overview = '/api/windows';
    const ownerPair = `${overview}/pairing`;
    const pair = `${overview}/companion/pair`;
    const poll = `${overview}/companion/poll`;
    checkError(await send('GET', overview), 401, 'UNAUTHORIZED');
    checkError(await send('GET', overview, member), 403, 'MEMBER_FORBIDDEN');
    checkError(await send('GET', `${overview}/devices/${randomUUID()}/frame`, owner), 404, 'WINDOWS_DEVICE_NOT_FOUND');

    const pairing = checkJson(await send('POST', ownerPair, owner, {}), 200, PhoneWindowsPairingSchema);
    const pairRequest = PhoneWindowsCompanionPairRequestSchema.parse({ code: pairing.code, name: 'Transport fixture' });
    checkError(await send('POST', pair, 'anonymous', pairRequest), 403, 'WINDOWS_COMPANION_BROWSER_DENIED');
    const { deviceId, deviceKey } = checkJson(await application.app.inject({ method: 'POST', url: pair, payload: pairRequest }),
      200, PhoneWindowsCompanionPairReplySchema);
    checkError(await application.app.inject({ method: 'POST', url: pair, payload: pairRequest }), 401, 'WINDOWS_PAIRING_INVALID');

    const device = `${overview}/devices/${deviceId}`;
    const targetKey = 'a'.repeat(64);
    const approvalNonce = randomUUID();
    const state = {
      approvalNonce, sessionId: 1, safeDesktop: true, localView: true, localControl: true, status: 'Synthetic fixture target',
      target: { key: targetKey, mode: 'window' as const, title: 'Synthetic fixture target', width: 400, height: 200 },
    };
    const authorization = `Bearer ${deviceId}.${deviceKey}`;
    const sendPoll = (patch: Partial<z.input<typeof PhoneWindowsCompanionPollRequestSchema>> = {}, authenticated = true) =>
      application.app.inject({ method: 'POST', url: poll,
        headers: authenticated ? { authorization } : {},
        payload: PhoneWindowsCompanionPollRequestSchema.parse({
          nonce: randomUUID(), sentAt: new Date().toISOString(), state, frame: null, ack: null, ...patch,
        }),
      });
    checkError(await sendPoll({}, false), 401, 'WINDOWS_DEVICE_UNAUTHORIZED');
    checkJson(await sendPoll({ state: { ...state, target: null, localView: false, localControl: false } }), 200, PhoneWindowsCompanionPollReplySchema);
    const summaryResponse = await send('GET', overview, owner);
    expect(summaryResponse.body.includes(deviceKey)).toBe(false);
    const summary = checkJson(summaryResponse, 200, PhoneWindowsOverviewSchema);
    expect(summary.devices.find(item => item.id === deviceId)?.state?.target).toBeNull();
    expect(summary.events.find(event => event.type === 'pairing_created')?.deviceId).toBeNull();

    const grantRequest = PhoneWindowsGrantRequestSchema.parse({ scope: 'control', durationSeconds: 30, targetKey, approvalNonce });
    checkError(await send('POST', `${device}/grants`, owner, grantRequest), 409, 'WINDOWS_LOCAL_CONSENT_REQUIRED');
    const nonce = randomUUID();
    checkJson(await sendPoll({ nonce }), 200, PhoneWindowsCompanionPollReplySchema);
    checkError(await sendPoll({ nonce }), 409, 'WINDOWS_POLL_REPLAY');
    const grant = checkJson(await send('POST', `${device}/grants`, owner, grantRequest), 200, PhoneWindowsGrantSchema);

    // The existing Windows route test produces a synthetic JPEG-shaped frame this way (retrieved 2026-11-27).
    // https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/packages/windows/src/windows.test.ts#L21
    const frame = {
      id: randomUUID(), targetKey, capturedAt: new Date().toISOString(), width: 400, height: 200,
      jpeg: Buffer.concat([Buffer.from([255, 216, 255]), Buffer.alloc(150), Buffer.from([255, 217])]).toString('base64'),
      elements: [{ name: 'Fixture field', type: 'Edit', x: 0, y: 0, width: 1, height: 1, password: false }],
    };
    checkJson(await sendPoll({ frame }), 200, PhoneWindowsCompanionPollReplySchema);
    checkJson(await send('GET', `${device}/frame`, owner), 200, PhoneWindowsFrameReplySchema);
    const actionRequest = PhoneWindowsActionRequestSchema.parse({
      grantId: grant.id, nonce: randomUUID(), frameId: frame.id, action: { type: 'key', key: 'Escape' },
    });
    const action = checkJson(await send('POST', `${device}/actions`, owner, actionRequest), 200, PhoneWindowsActionReplySchema);
    const delivered = checkJson(await sendPoll({ frame }), 200, PhoneWindowsCompanionPollReplySchema);
    expect(delivered.command?.id).toBe(action.id);
    checkJson(await send('POST', `${device}/stop`, owner, {}), 200, PhoneOkReplySchema);
    expect(checkJson(await sendPoll(), 200, PhoneWindowsCompanionPollReplySchema).stop).toBe(true);
    checkJson(await send('POST', `${device}/revoke`, owner, {}), 200, PhoneOkReplySchema);
    checkError(await sendPoll(), 401, 'WINDOWS_DEVICE_UNAUTHORIZED');
  });

  it('validates the 429 envelope from the pairing route', async () => {
    // This route allows three requests per minute (packages/windows/src/index.ts:164).
    const responses = [];
    for (let attempt = 0; attempt < 4; attempt++) responses.push(await fixture.send('POST', '/api/windows/pairing', owner, {}));
    const limited = responses.find(response => response.statusCode === 429);
    expect(limited).toBeDefined();
    checkError(limited!, 429);
  });
});
