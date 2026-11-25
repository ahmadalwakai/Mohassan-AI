import { ChatCreateSchema, ChatSendSchema } from '@mohassan/contracts';
import { createCommandChatControl, type CommandChatConfig } from '../../command-chat.js';
import { assessRequestScope } from '../request-scope.js';
import { withLongRunChat } from '../long-run/host.js';
import { classifyRefusal } from './classifier.js';
import { logRefusalDecision, refusalPolicyEnabled } from './settings.js';

/** Image captions otherwise enter the reader directly, outside the task worker. */
export async function createRefusalAwareCommandChat(db: Parameters<typeof createCommandChatControl>[0], config: CommandChatConfig) {
  const chat = await createCommandChatControl(db, config);
  const refusedCaption = async (ownerId: string, caption: string | undefined) => {
    if (!caption) return false;
    const decision = classifyRefusal(caption, { fullAccess: config.fullAccess ? await config.fullAccess(ownerId) : true,
      scope: assessRequestScope(caption), capabilities: { computer: Boolean(config.tools?.computer || config.desktop),
        memory: Boolean(config.tools?.memory) } });
    if (!decision) return false;
    if (refusalPolicyEnabled()) return true;
    logRefusalDecision(decision.code, false);
    return false;
  };

  return withLongRunChat(db, config, { ...chat,
    async create(ownerId: string, raw: unknown = {}) {
      const input = ChatCreateSchema.safeParse(raw);
      if (input.success && input.data.images?.length && await refusedCaption(ownerId, input.data.goal)) {
        return chat.create(ownerId, { ...(raw as object), images: undefined });
      }
      return chat.create(ownerId, raw);
    },
    async send(ownerId: string, id: string, raw: unknown) {
      const input = ChatSendSchema.safeParse(raw);
      if (input.success && input.data.images?.length && await refusedCaption(ownerId, input.data.text)) {
        return chat.send(ownerId, id, { ...(raw as object), images: undefined });
      }
      return chat.send(ownerId, id, raw);
    },
  });
}
