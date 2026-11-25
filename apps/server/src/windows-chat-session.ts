import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WindowsControl } from '@mohassan/windows';
import { registerCommandChatRoutes } from './command-chat.js';

/** Preserve the authenticated HTTP session as asynchronous chat work is dispatched. */
export async function registerWindowsScopedChatRoutes(
  app: FastifyInstance,
  options: Parameters<typeof registerCommandChatRoutes>[1],
  windows: Pick<WindowsControl, 'runInSession'>,
  sessionFor: (request: FastifyRequest) => Promise<{ id: string; sessionId: string } | null>,
) {
  await app.register(async scoped => {
    scoped.addHook('onRoute', route => {
      const handler = route.handler;
      route.handler = async function (request, reply) {
        const session = await sessionFor(request);
        return windows.runInSession(session?.id ?? '', session?.sessionId, () => handler.call(this, request, reply));
      };
    });
    await registerCommandChatRoutes(scoped, options);
  });
}
