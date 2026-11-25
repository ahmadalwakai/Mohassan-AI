import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  ConversationExportQuerySchema, ConversationShareSettingsSchema, ConversationShareTokenSchema,
  CreateConversationShareSchema,
} from '@mohassan/contracts';
import { createPdfRenderer } from '@mohassan/pdf';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { renderConversationMarkdown, renderConversationPdf } from './conversation-export.js';
import { conversationSharePaths as paths } from './conversation-share-paths.js';
import { scanConversationPrivacy } from './conversation-share-privacy.js';
import { createConversationShareStorage } from './conversation-share-storage.js';
import { assertMemberFeatureAccess } from './member-deletion.js';
import type { WorkspaceRole } from './members.js';

type Identity = (request: FastifyRequest) => Promise<{ id: string }>;
interface ConversationShareOptions {
  db: Kysely<any>;
  owner: Identity;
  role: (request: FastifyRequest) => Promise<WorkspaceRole>;
  webOrigin: string;
  internalSecret: string;
  fontsDir?: string;
}

const failure = (statusCode: number, code: string, message: string) => Object.assign(new Error(message), { statusCode, code });
const notFound = () => failure(404, 'CONVERSATION_NOT_FOUND', 'المحادثة غير موجودة.');
const shareUnavailable = () => failure(404, 'CONVERSATION_SHARE_NOT_FOUND', 'رابط المشاركة غير متاح.');
const empty = z.object({}).strict();

export function registerConversationShareRoutes(app: FastifyInstance, options: ConversationShareOptions) {
  const { owner, role } = options;
  const store = createConversationShareStorage(options.db);
  const renderer = createPdfRenderer({ fontsDir: options.fontsDir });
  app.addHook('preClose', () => renderer.close());

  async function load(ownerId: string, id: string) {
    const conversation = await store.ownedSnapshot(ownerId, id);
    if (!conversation) throw notFound();
    return conversation;
  }

  async function review(ownerId: string, id: string) {
    const { snapshot, provenance, quotes } = await load(ownerId, id);
    const checked = scanConversationPrivacy(snapshot, provenance, quotes);
    // RFC 2104 §2, retrieved 2026-11-25: https://www.rfc-editor.org/rfc/rfc2104#section-2
    // A stateless receipt binds the displayed findings to the account and the exact content reviewed.
    const receipt = createHmac('sha256', options.internalSecret)
      .update(JSON.stringify(['conversation-share-review-v1', ownerId, id, snapshot, checked])).digest();
    return { ...checked, receipt };
  }

  async function requireMemberSharing(actorRole: WorkspaceRole) {
    if (actorRole === 'member' && !await store.getMemberSharingEnabled()) {
      throw failure(403, 'CONVERSATION_SHARE_DISABLED', 'أوقف المالك إنشاء روابط المشاركة للأعضاء.');
    }
  }

  async function requireOwner(request: FastifyRequest) {
    if (await role(request) !== 'owner') throw failure(403, 'MEMBER_FORBIDDEN', 'هذه الخدمة غير متاحة لحسابك.');
  }

  app.get<{ Params: { id: string } }>(paths.export, { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const actor = await owner(request);
    const { format } = ConversationExportQuerySchema.parse(request.query);
    const { snapshot } = await load(actor.id, z.uuid().parse(request.params.id));
    const extension = format === 'pdf' ? 'pdf' : 'md';
    const body = format === 'pdf' ? await renderConversationPdf(snapshot, renderer) : renderConversationMarkdown(snapshot);
    return reply.type(format === 'pdf' ? 'application/pdf' : 'text/markdown; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="conversation.${extension}"; filename*=UTF-8''${encodeURIComponent('محادثة')}.${extension}`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox").send(body);
  });

  app.post<{ Params: { id: string } }>(paths.preview, { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const actor = await owner(request);
    await requireMemberSharing(await role(request));
    empty.parse(request.body ?? {});
    const { findings, receipt } = await review(actor.id, z.uuid().parse(request.params.id));
    return { findings, review: receipt.toString('hex') };
  });

  app.post<{ Params: { id: string } }>(paths.create, { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    const actor = await owner(request);
    const actorRole = await role(request);
    await requireMemberSharing(actorRole);
    const id = z.uuid().parse(request.params.id);
    const input = CreateConversationShareSchema.parse(request.body);
    const { snapshot, receipt } = await review(actor.id, id);
    if (!timingSafeEqual(receipt, Buffer.from(input.review, 'hex'))) {
      throw failure(409, 'CONVERSATION_SHARE_REVIEW_CHANGED', 'تغيّرت المحادثة. راجع فحص الخصوصية من جديد.');
    }
    const { share, token } = await store.createShare(actor.id, id, snapshot, input.expiry, actorRole, assertMemberFeatureAccess);
    return reply.code(201).send({ share, url: new URL(`/share/${token}`, options.webOrigin).href });
  });

  app.get(paths.list, async request => ({ shares: await store.listShares((await owner(request)).id) }));
  app.delete<{ Params: { id: string } }>(paths.revoke, async request => {
    if (!await store.revokeShare((await owner(request)).id, z.uuid().parse(request.params.id))) throw shareUnavailable();
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>(paths.public, {
    onSend: async (_request, reply, payload) => {
      reply.headers({
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      return payload;
    },
  }, async request => {
    const token = ConversationShareTokenSchema.safeParse(request.params.token);
    const share = token.success ? await store.lookupShare(token.data) : null;
    if (!share) throw shareUnavailable();
    return share;
  });

  app.get(paths.settings, async request => {
    await requireOwner(request);
    return { memberSharingEnabled: await store.getMemberSharingEnabled() };
  });
  app.post(paths.settings, async request => {
    await requireOwner(request);
    const input = ConversationShareSettingsSchema.parse(request.body);
    await store.setMemberSharingEnabled(input.memberSharingEnabled);
    return input;
  });
}
