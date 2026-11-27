import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { ActivationConsoleSnapshot } from '@mohassan/contracts';
import { observeActivationConsoleLogs } from './log-sources.js';
import { observationWindowDays, readActivationObservations } from './observations.js';
import { readActivationSwitches, type ActivationRuntime } from './runtime.js';

type Options = Omit<ActivationRuntime, 'app'> & {
  db: Kysely<any>;
  owner: (request: FastifyRequest) => Promise<{ id: string }>;
  role: (request: FastifyRequest) => Promise<string>;
  judgeLogFile: string;
};

export function registerActivationConsole(app: FastifyInstance, { db, owner, role, config, judgeLogFile, live }: Options) {
  const runtime = { app, config, live };
  const startup = new Map(readActivationSwitches(runtime, new Map()).map(row => [row.name, row]));
  const consoleLogs = observeActivationConsoleLogs();
  app.addHook('onClose', async () => { consoleLogs.close(); });
  const conversationLogFile = join(process.cwd(), '.data', 'conversation', 'shadow.jsonl');

  app.get('/api/activation-console', async (request, reply): Promise<ActivationConsoleSnapshot | void> => {
    reply.header('Cache-Control', 'private, no-store');
    const actor = await owner(request);
    if (await role(request) !== 'owner') {
      return void reply.code(403).send({ error: { code: 'MEMBER_FORBIDDEN', message: 'هذه الخدمة غير متاحة لحسابك.' } });
    }
    const observations = await readActivationObservations({ db, actorId: actor.id, judgeLogFile, conversationLogFile,
      consoleEvents: consoleLogs.events(), to: new Date() });
    return { switches: readActivationSwitches(runtime, observations, startup), observationWindowDays };
  });
}
