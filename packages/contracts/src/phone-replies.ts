import { z } from 'zod';
import { ChatCapabilitiesSchema, ChatConversationSummarySchema, ChatImageSchema } from './command-chat';

// Ported from https://github.com/ahmadalwakai/Mohassan-AI/pull/5 (retrieved 2026-11-27).
// The iPhone decoders in apps/ios/Wasla/Models.swift ignore additional server fields.
const PhoneAuthUserSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  name: z.string(),
});

export const PhoneSignInReplySchema = z.object({ user: PhoneAuthUserSchema });

// Session lookup and sign-out are recorded to exercise the auth lifecycle.
export const PhoneSessionReplySchema = z.object({
  session: z.object({ id: z.string().min(1), userId: z.string().min(1), expiresAt: z.iso.datetime() }),
  user: PhoneAuthUserSchema,
}).nullable();
export const PhoneSignOutReplySchema = z.object({ success: z.boolean() });

export const PhoneOkReplySchema = z.object({ ok: z.boolean() });

export const PhoneAuthErrorReplySchema = z.object({
  code: z.string(),
  message: z.string(),
});
export const PhoneServerErrorReplySchema = z.object({ error: PhoneAuthErrorReplySchema });

export const PhoneChatListReplySchema = z.object({
  conversations: z.array(ChatConversationSummarySchema),
  configured: z.boolean(),
  capabilities: ChatCapabilitiesSchema,
  requestKeys: z.boolean(),
});

export const PhoneChatImageAvailabilityReplySchema = z.object({ available: z.boolean() });
export const PhoneChatImageUploadReplySchema = ChatImageSchema.extend({
  mimeType: z.enum(['image/png', 'image/jpeg']),
  bytes: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  url: z.string().regex(/^\/api\/chat\/images\/[a-f0-9-]{36}$/u),
});

// Windows DTOs and request validators come from packages/windows/src/index.ts.
const WindowsTargetKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const WindowsScopeSchema = z.enum(['view', 'control']);
const WindowsPairingCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{16}$/u);
const PhoneWindowsTargetSchema = z.object({
  key: WindowsTargetKeySchema,
  mode: z.enum(['window', 'desktop']),
  title: z.string().max(160),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
}).strict();

const PhoneWindowsStateSchema = z.object({
  approvalNonce: z.uuid(),
  sessionId: z.number().int().positive(),
  safeDesktop: z.boolean(),
  localView: z.boolean(),
  localControl: z.boolean(),
  target: PhoneWindowsTargetSchema.nullable(),
  status: z.string().max(200),
}).strict();

export const PhoneWindowsGrantSchema = z.object({
  id: z.uuid(),
  scope: WindowsScopeSchema,
  targetKey: WindowsTargetKeySchema,
  approvalNonce: z.uuid(),
  expiresAt: z.iso.datetime(),
});

const PhoneWindowsDeviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revoked: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.iso.datetime().nullable(),
  state: PhoneWindowsStateSchema.nullable(),
  grant: PhoneWindowsGrantSchema.nullable(),
});

export const PhoneWindowsOverviewSchema = z.object({
  enabled: z.boolean(),
  devices: z.array(PhoneWindowsDeviceSchema),
  events: z.array(z.object({
    id: z.uuid(),
    deviceId: z.uuid().nullable(),
    type: z.string(),
    detail: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })),
});

export const PhoneWindowsPairingSchema = z.object({
  id: z.uuid(),
  code: WindowsPairingCodeSchema,
  expiresAt: z.iso.datetime(),
});

const PhoneWindowsFrameSchema = z.object({
  id: z.uuid(),
  targetKey: WindowsTargetKeySchema,
  capturedAt: z.iso.datetime(),
  width: z.number().int().positive().max(1024),
  height: z.number().int().positive().max(1024),
  jpeg: z.string().min(100).max(280_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  elements: z.array(z.strictObject({
    name: z.string().max(160),
    type: z.string().max(80),
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
    password: z.boolean(),
  })).max(100),
});

export const PhoneWindowsFrameReplySchema = z.object({
  frame: PhoneWindowsFrameSchema.extend({ receivedAt: z.iso.datetime() }),
  grant: PhoneWindowsGrantSchema,
});

export const PhoneWindowsActionReplySchema = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'dispatched', 'applied', 'rejected', 'unknown']),
  code: z.string().nullable().optional(),
});

// Phone request bodies for routes whose server validators are internal.
export const PhoneSignInRequestSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(1),
  rememberMe: z.boolean().optional(),
});

export const PhoneWindowsGrantRequestSchema = z.strictObject({
  scope: WindowsScopeSchema,
  durationSeconds: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  targetKey: WindowsTargetKeySchema,
  approvalNonce: z.uuid(),
});

const PhoneWindowsActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('click'),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    button: z.enum(['left', 'right']).default('left'),
  }),
  z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/u) }),
  z.strictObject({
    type: z.literal('key'),
    key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight',
      'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space']),
  }),
  z.strictObject({ type: z.literal('scroll'), delta: z.number().int().min(-3).max(3).refine(value => value !== 0) }),
]);

export const PhoneWindowsActionRequestSchema = z.strictObject({
  grantId: z.uuid(),
  nonce: z.uuid(),
  frameId: z.uuid(),
  action: PhoneWindowsActionSchema,
});

export const PhoneWindowsCompanionPairRequestSchema = z.strictObject({
  code: WindowsPairingCodeSchema,
  name: z.string().trim().min(1).max(80),
});

export const PhoneWindowsCompanionPairReplySchema = z.object({
  deviceId: z.uuid(),
  deviceKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  pollIntervalMs: z.number().int().positive(),
});

export const PhoneWindowsCompanionPollRequestSchema = z.strictObject({
  nonce: z.uuid(),
  sentAt: z.iso.datetime(),
  state: PhoneWindowsStateSchema,
  frame: PhoneWindowsFrameSchema.strict().nullable(),
  ack: z.strictObject({
    id: z.uuid(),
    status: z.enum(['applied', 'rejected', 'unknown']),
    code: z.string().regex(/^[A-Z_]{2,80}$/u),
  }).nullable(),
});

export const PhoneWindowsCompanionPollReplySchema = z.object({
  grant: PhoneWindowsGrantSchema.nullable(),
  command: z.object({
    id: z.uuid(),
    grantId: z.uuid(),
    sequence: z.number().int().positive(),
    frameId: z.uuid(),
    expiresAt: z.iso.datetime(),
    action: PhoneWindowsActionSchema,
  }).nullable(),
  stop: z.boolean(),
  serverTime: z.iso.datetime(),
});
