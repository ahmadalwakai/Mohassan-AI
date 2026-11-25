import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { roleOf } from '../../members.js';
import { createMemoryHitReader } from './memory-evidence.js';
import { installDeliberationRunView } from './run-view.js';
import { configureDeliberation } from './settings.js';

export function installChatDeliberation(app: FastifyInstance, db: Kysely<any>,
  owner: (request: FastifyRequest) => Promise<{ id: string }>,
  memory: Parameters<typeof createMemoryHitReader>[0], enabled?: boolean) {
  configureDeliberation(db, { enabled, memoryHit: createMemoryHitReader(memory) });
  installDeliberationRunView(app, db, owner, ownerId => roleOf(db, ownerId));
}
