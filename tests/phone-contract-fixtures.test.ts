/**
 * Ports https://github.com/ahmadalwakai/Mohassan-AI/pull/5 (retrieved 2026-11-27).
 * Re-record from the repository root with dependencies and Playwright Chromium installed:
 *   npx tsx scripts/cloud-phone-fixtures.ts tests/fixtures/cloud-phone
 * The recorder replaces the JSON files and index using a local server and fixture site.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ChatApproveSchema,
  ChatConversationSchema,
  ChatCreateSchema,
  ChatFeedbackSchema,
  ChatRespondSchema,
  ChatSecureSubmitSchema,
  ChatSendSchema,
  PhoneAuthErrorReplySchema,
  PhoneChatImageAvailabilityReplySchema,
  PhoneChatListReplySchema,
  PhoneOkReplySchema,
  PhoneServerErrorReplySchema,
  PhoneSessionReplySchema,
  PhoneSignInReplySchema,
  PhoneSignInRequestSchema,
  PhoneSignOutReplySchema,
  PhoneWindowsActionReplySchema,
  PhoneWindowsActionRequestSchema,
  PhoneWindowsFrameReplySchema,
  PhoneWindowsGrantRequestSchema,
  PhoneWindowsGrantSchema,
  PhoneWindowsOverviewSchema,
  PhoneWindowsPairingSchema,
} from '../packages/contracts/src';

const directory = new URL('./fixtures/cloud-phone/', import.meta.url);
const index = z.object({
  fixtures: z.array(z.object({
    file: z.string().regex(/^[a-z0-9-]+$/),
    status: z.number().int(),
    conversationStatus: z.string().optional(),
  })).min(1),
}).parse(JSON.parse(readFileSync(new URL('index.json', directory), 'utf8')));

const FixtureSchema = z.object({
  request: z.object({
    method: z.enum(['GET', 'POST', 'DELETE']),
    url: z.string().startsWith('/api/'),
    body: z.json().optional(),
  }),
  response: z.object({ status: z.number().int(), headers: z.record(z.string(), z.array(z.string())).optional(), body: z.json() }),
});
type Fixture = z.infer<typeof FixtureSchema>;

function readFixture(file: string): Fixture {
  return FixtureSchema.parse(JSON.parse(readFileSync(new URL(`${file}.json`, directory), 'utf8')));
}

const noBody = z.undefined();
const emptyBody = z.strictObject({});
type RouteContract = { request: z.ZodType; reply: z.ZodType; error?: z.ZodType };
const routes: Record<string, RouteContract> = {
  'POST /api/auth/sign-in/email': {
    request: PhoneSignInRequestSchema, reply: PhoneSignInReplySchema, error: PhoneAuthErrorReplySchema,
  },
  'GET /api/auth/get-session': { request: noBody, reply: PhoneSessionReplySchema },
  'POST /api/auth/sign-out': { request: emptyBody, reply: PhoneSignOutReplySchema },
  'GET /api/chat/conversations': { request: noBody, reply: PhoneChatListReplySchema },
  'GET /api/chat/images': { request: noBody, reply: PhoneChatImageAvailabilityReplySchema },
  'POST /api/chat/conversations': { request: ChatCreateSchema, reply: ChatConversationSchema },
  'GET /api/chat/conversations/:id': { request: noBody, reply: ChatConversationSchema },
  'DELETE /api/chat/conversations/:id': { request: noBody, reply: PhoneOkReplySchema },
  'POST /api/chat/conversations/:id/messages': { request: ChatSendSchema, reply: ChatConversationSchema },
  'POST /api/chat/conversations/:id/respond': { request: ChatRespondSchema, reply: ChatConversationSchema },
  'POST /api/chat/conversations/:id/approve': { request: ChatApproveSchema, reply: ChatConversationSchema },
  'POST /api/chat/conversations/:id/feedback': { request: ChatFeedbackSchema, reply: ChatConversationSchema },
  'POST /api/chat/conversations/:id/secure': { request: ChatSecureSubmitSchema, reply: ChatConversationSchema },
  'POST /api/chat/conversations/:id/cancel': { request: emptyBody, reply: ChatConversationSchema },
  'GET /api/windows': { request: noBody, reply: PhoneWindowsOverviewSchema },
  'POST /api/windows/pairing': { request: emptyBody, reply: PhoneWindowsPairingSchema },
  'POST /api/windows/devices/:id/grants': { request: PhoneWindowsGrantRequestSchema, reply: PhoneWindowsGrantSchema },
  'GET /api/windows/devices/:id/frame': { request: noBody, reply: PhoneWindowsFrameReplySchema },
  'POST /api/windows/devices/:id/actions': { request: PhoneWindowsActionRequestSchema, reply: PhoneWindowsActionReplySchema },
  'POST /api/windows/devices/:id/stop': { request: emptyBody, reply: PhoneOkReplySchema },
};

function assertContract(schema: z.ZodType, body: unknown, label: string) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(`${label}: ${result.error.message}`, { cause: result.error });
  }
}

function validateFixture(file: string, fixture: Fixture, expectedStatus: number) {
  const { request, response } = fixture;
  const pathname = new URL(request.url, 'https://fixture.test').pathname;
  // Keep invalid IDs in the same route as valid IDs and ignore long-poll query parameters.
  const route = `${request.method} ${pathname.replace(/^(\/api\/(?:chat\/conversations|windows\/devices)\/)[^/]+/, '$1:id')}`;
  const contract = routes[route];
  if (!contract) throw new Error(`${file}: no contract for ${route}`);

  expect(response.status, `${file}: HTTP status`).toBe(expectedStatus);
  if (file === 'error-invalid-body') {
    expect(contract.request.safeParse(request.body).success, `${file}: request must be rejected`).toBe(false);
  } else {
    assertContract(contract.request, request.body, `${file}: ${route} request`);
  }
  const replySchema = response.status >= 400 ? contract.error ?? PhoneServerErrorReplySchema : contract.reply;
  assertContract(replySchema, response.body, `${file}: ${route} reply`);
}

describe('recorded phone contracts', () => {
  it('indexes every JSON exchange exactly once', () => {
    const files = readdirSync(directory).filter(file => file.endsWith('.json') && file !== 'index.json');
    expect(index.fixtures.map(({ file }) => `${file}.json`).sort()).toEqual(files.sort());
  });

  it.each(index.fixtures)('validates $file', ({ file, status, conversationStatus }) => {
    const fixture = readFixture(file);
    validateFixture(file, fixture, status);
    if (conversationStatus !== undefined) {
      expect(fixture.response.body).toMatchObject({ status: conversationStatus });
    }
  });

  it('preserves fields needed for sign-in, long polling and question cards', () => {
    const signIn = readFixture('auth-sign-in');
    const { email } = PhoneSignInRequestSchema.parse(signIn.request.body);
    expect(PhoneSignInReplySchema.parse(signIn.response.body).user?.email).toBe(email);
    expect(signIn.response.headers?.['set-cookie']?.some(value =>
      /^(?:__Secure-)?better-auth\.session_token=/.test(value) && /;\s*httponly\b/iu.test(value),
    )).toBe(true);

    const held = readFixture('detail-held-unchanged');
    const since = new URL(held.request.url, 'https://fixture.test').searchParams.get('since');
    expect(ChatConversationSchema.parse(held.response.body).version).toBe(since);

    const letter = ChatConversationSchema.parse(readFixture('detail-question-fields').response.body);
    expect(letter.question?.fields?.length).toBeGreaterThan(0);
  });

  it('redacts the fixture password and transient credentials before writing records', () => {
    const { request, response } = readFixture('auth-sign-in');
    const authReply = z.object({ token: z.string().optional() }).parse(response.body);
    const session = z.object({ session: z.object({ token: z.string().optional() }) }).parse(readFixture('auth-session').response.body);
    const pairing = PhoneWindowsPairingSchema.parse(readFixture('windows-pairing').response.body);
    expect(PhoneSignInRequestSchema.parse(request.body).password === '[fixture password]').toBe(true);
    expect(authReply.token === undefined || authReply.token === '[fixture token]').toBe(true);
    expect(session.session.token === undefined || session.session.token === '[fixture token]').toBe(true);
    expect(pairing.code === 'A'.repeat(16)).toBe(true);
  });

  it('keeps the selected target and grant in the active Windows overview', () => {
    const overview = PhoneWindowsOverviewSchema.parse(readFixture('windows-active').response.body);
    const grant = PhoneWindowsGrantSchema.parse(readFixture('windows-grant').response.body);
    const device = overview.devices[0];
    expect(device?.state?.target?.key).toBe(grant.targetKey);
    expect(device?.grant).toEqual(grant);
  });

  it('rejects a missing or mistyped chat message field the phone reads', () => {
    const fixture = readFixture('detail-completed');
    const body = ChatConversationSchema.parse(fixture.response.body);
    const [message, ...remaining] = body.messages;
    const { text: _text, ...messageWithoutText } = message;

    for (const changedMessage of [messageWithoutText, { ...message, text: 123 }]) {
      const mutated = {
        ...fixture,
        response: { ...fixture.response, body: { ...body, messages: [changedMessage, ...remaining] } },
      };
      expect(() => validateFixture('detail-completed', mutated, 200)).toThrow(/"path":\s*\[\s*"messages",\s*0,\s*"text"/);
    }
  });
});
