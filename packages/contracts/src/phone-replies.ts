import { z } from 'zod';
import { ChatCapabilitiesSchema, ChatConversationSummarySchema } from './command-chat';

// These replies follow the Swift decoders in apps/ios/Wasla/Models.swift.
// The phone ignores additional server fields.
const PhoneAuthUserSchema = z.object({
  email: z.string().nullish(),
  name: z.string().nullish(),
});

export const PhoneSignInReplySchema = z.object({ user: PhoneAuthUserSchema.nullish() });

// Session lookup and sign-out are recorded to exercise the auth lifecycle.
export const PhoneSessionReplySchema = z.object({
  session: z.object({}),
  user: PhoneAuthUserSchema,
});
export const PhoneSignOutReplySchema = z.object({ success: z.boolean() });

export const PhoneOkReplySchema = z.object({ ok: z.boolean() });

export const PhoneAuthErrorReplySchema = z.object({
  code: z.string(),
  message: z.string(),
});
export const PhoneServerErrorReplySchema = z.object({ error: PhoneAuthErrorReplySchema });

export const PhoneChatListReplySchema = z.object({
  conversations: z.array(ChatConversationSummarySchema),
  capabilities: ChatCapabilitiesSchema,
  requestKeys: z.boolean(),
});

export const PhoneChatImageAvailabilityReplySchema = z.object({ available: z.boolean() });

const PhoneWindowsTargetSchema = z.object({
  key: z.string(),
  mode: z.string(),
  title: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

const PhoneWindowsStateSchema = z.object({
  approvalNonce: z.string(),
  safeDesktop: z.boolean(),
  localView: z.boolean(),
  localControl: z.boolean(),
  target: PhoneWindowsTargetSchema.nullish(),
  status: z.string(),
});

export const PhoneWindowsGrantSchema = z.object({
  id: z.string(),
  scope: z.string(),
  targetKey: z.string(),
  approvalNonce: z.string(),
  expiresAt: z.string(),
});

const PhoneWindowsDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  revoked: z.boolean(),
  online: z.boolean(),
  lastSeenAt: z.string().nullish(),
  state: PhoneWindowsStateSchema.nullish(),
  grant: PhoneWindowsGrantSchema.nullish(),
});

export const PhoneWindowsOverviewSchema = z.object({
  enabled: z.boolean(),
  devices: z.array(PhoneWindowsDeviceSchema),
});

export const PhoneWindowsPairingSchema = z.object({
  id: z.string(),
  code: z.string(),
  expiresAt: z.string(),
});

export const PhoneWindowsFrameReplySchema = z.object({
  frame: z.object({
    id: z.string(),
    targetKey: z.string(),
    capturedAt: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    jpeg: z.string(),
  }),
  grant: PhoneWindowsGrantSchema,
});

export const PhoneWindowsActionReplySchema = z.object({
  id: z.string(),
  status: z.string(),
});

// Phone request bodies for routes whose server validators are internal.
export const PhoneSignInRequestSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(1),
  rememberMe: z.boolean(),
});

export const PhoneWindowsGrantRequestSchema = z.strictObject({
  scope: z.enum(['view', 'control']),
  durationSeconds: z.union([z.literal(30), z.literal(60), z.literal(120)]),
  targetKey: z.string().regex(/^[a-f0-9]{64}$/),
  approvalNonce: z.uuid(),
});

const PhoneWindowsActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('click'),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    button: z.enum(['left', 'right']),
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
